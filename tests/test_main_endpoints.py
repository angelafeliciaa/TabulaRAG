"""Tests for app.main – endpoint coverage for auth, health, ingest edge cases."""

import io
import os
import uuid
from unittest.mock import patch, MagicMock, AsyncMock

import pytest

from app.auth import create_jwt


# ── Health ────────────────────────────────────────────────────────


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_health_deps(client):
    resp = client.get("/health/deps")
    assert resp.status_code == 200
    body = resp.json()
    assert "postgres" in body
    assert "qdrant" in body


# ── Auth verify ───────────────────────────────────────────────────


def test_auth_verify_valid(client):
    resp = client.post("/auth/verify")
    assert resp.status_code == 200
    assert resp.json()["valid"] is True


def test_auth_verify_no_token():
    from fastapi.testclient import TestClient
    import app.main as app_main
    with TestClient(app_main.app) as c:
        resp = c.post("/auth/verify")
        assert resp.status_code == 401


def test_auth_verify_jwt(client):
    from app.db import SessionLocal
    from app.models import User

    with SessionLocal() as db:
        u = User(
            google_id="test_google_id",
            login="tester@example.com",
        )
        db.add(u)
        db.commit()
        db.refresh(u)
        uid = u.id

    token = create_jwt(
        user_id=uid,
        login="tester@example.com",
        name="tester",
        avatar_url="",
    )

    resp = client.post(
        "/auth/verify",
        headers={"Authorization": f"Bearer {token}"}
    )

    assert resp.status_code == 200



# ── Auth Google callback ─────────────────────────────────────────


def test_google_callback_missing_code(client):
    resp = client.post("/auth/google/callback", json={})
    assert resp.status_code == 400


def test_google_callback_missing_redirect_uri(client):
    resp = client.post("/auth/google/callback", json={"code": "abc123"})
    assert resp.status_code == 400


def test_register_login_email_flow(client):
    email = f"local_{uuid.uuid4().hex[:10]}@example.com"
    reg = client.post(
        "/auth/register",
        json={"email": email, "password": "secret1234", "name": "Local User"},
    )
    assert reg.status_code == 200, reg.text
    body = reg.json()
    assert "token" in body
    assert body["user"]["login"] == email
    assert body["onboarding_required"] is True

    dup = client.post(
        "/auth/register",
        json={"email": email, "password": "othersecret1"},
    )
    assert dup.status_code == 409

    bad_pw = client.post(
        "/auth/login",
        json={"email": email, "password": "wrongpassword"},
    )
    assert bad_pw.status_code == 401

    ok = client.post(
        "/auth/login",
        json={"email": email, "password": "secret1234"},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["user"]["login"] == email


def test_google_callback_links_existing_email_password_account(client):
    """Google OAuth with same email as an email/password user attaches Google id; both logins work."""
    from unittest.mock import AsyncMock, patch

    email = f"link_{uuid.uuid4().hex[:10]}@example.com"
    reg = client.post(
        "/auth/register",
        json={"email": email, "password": "pwlinks1234", "name": "Local First"},
    )
    assert reg.status_code == 200, reg.text

    mock_google = {
        "id": "google-sub-linked-99",
        "email": email,
        "name": "From Google",
        "picture": "https://example.com/a.png",
    }

    with patch("app.main.exchange_google_code", new_callable=AsyncMock, return_value=mock_google):
        go = client.post(
            "/auth/google/callback",
            json={"code": "abc", "redirect_uri": "https://example.com/callback"},
        )
    assert go.status_code == 200, go.text
    body = go.json()
    assert body["user"]["login"] == email
    assert body["user"]["name"] == "From Google"

    pw = client.post("/auth/login", json={"email": email, "password": "pwlinks1234"})
    assert pw.status_code == 200, pw.text
    assert pw.json()["user"]["login"] == email

    with patch("app.main.exchange_google_code", new_callable=AsyncMock, return_value=mock_google):
        go2 = client.post(
            "/auth/google/callback",
            json={"code": "def", "redirect_uri": "https://example.com/callback"},
        )
    assert go2.status_code == 200, go2.text


def test_google_callback_success(client):
    mock_user = {
        "id": "42",
        "email": "octocat@example.com",
        "name": "Octo",
        "picture": "",
    }

    with patch("app.main.exchange_google_code", new_callable=AsyncMock, return_value=mock_user):
        resp = client.post(
            "/auth/google/callback",
            json={"code": "abc123", "redirect_uri": "https://example.com/callback"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert "token" in body
    assert body["user"]["login"] == "octocat@example.com"


# ── Ingest edge cases ────────────────────────────────────────────


def test_ingest_missing_filename(client):
    resp = client.post(
        "/ingest",
        files={"file": ("", io.BytesIO(b"a,b\n1,2\n"), "text/csv")},
    )
    assert resp.status_code in (400, 422)


def test_ingest_invalid_extension(client):
    resp = client.post(
        "/ingest",
        files={"file": ("data.json", io.BytesIO(b'{"a":1}'), "application/json")},
    )
    assert resp.status_code == 400


# ── _normalize_headers ────────────────────────────────────────────


def test_normalize_headers():
    from app.normalization import normalize_headers
    result = normalize_headers(["Name", "", "Name", "  Age  "])
    assert result[0] == "name"
    assert result[1] == "col_2"
    assert result[2] == "name_2"  # deduplicated
    assert result[3] == "age"


def test_normalize_headers_all_empty():
    from app.normalization import normalize_headers
    result = normalize_headers(["", "", ""])
    assert result == ["col_1", "col_2", "col_3"]


# ── validate_filename ─────────────────────────────────────────────


def test_validate_filename_csv():
    from app.main import validate_filename
    validate_filename("data.csv")  # should not raise


def test_validate_filename_tsv():
    from app.main import validate_filename
    validate_filename("data.tsv")  # should not raise


def test_validate_filename_invalid():
    from app.main import validate_filename
    from fastapi import HTTPException
    with pytest.raises(HTTPException):
        validate_filename("data.json")


# ── _detect_delimiter ─────────────────────────────────────────────


def test_detect_delimiter():
    from app.main import _detect_delimiter
    assert _detect_delimiter("file.csv") == ","
    assert _detect_delimiter("file.tsv") == "\t"
    assert _detect_delimiter("file.txt") == ","
    assert _detect_delimiter(None) == ","
