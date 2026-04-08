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
    smtp = body["smtp"]
    assert smtp.keys() >= {
        "host_configured",
        "auth_configured",
        "from_configured",
        "ready_to_send",
    }


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
    from unittest.mock import patch

    email = f"local_{uuid.uuid4().hex[:10]}@example.com"
    with patch("app.main.generate_verification_code", return_value="123456"):
        reg = client.post(
            "/auth/register",
            json={"email": email, "password": "secret1234", "name": "Local User"},
        )
    assert reg.status_code == 200, reg.text
    body = reg.json()
    assert body.get("verification_required") is True
    assert body.get("email") == email

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

    unverified = client.post(
        "/auth/login",
        json={"email": email, "password": "secret1234"},
    )
    assert unverified.status_code == 403

    verify = client.post(
        "/auth/verify-email",
        json={"email": email, "code": "123456"},
    )
    assert verify.status_code == 200, verify.text
    vbody = verify.json()
    assert vbody["user"]["login"] == email
    assert vbody["user"]["avatar_hex"].startswith("#")
    assert vbody["onboarding_required"] is True

    ok = client.post(
        "/auth/login",
        json={"email": email, "password": "secret1234"},
    )
    assert ok.status_code == 200, ok.text
    obody = ok.json()
    assert obody["user"]["login"] == email
    assert obody["user"]["avatar_hex"].startswith("#")


def test_register_google_only_user_prompts_google_signin(client):
    """Google-only verified account: register stores pending password; Google callback applies it for email login."""
    from unittest.mock import AsyncMock, patch

    from sqlalchemy import func, select

    from app.auth import verify_password
    from app.db import SessionLocal
    from app.models import User

    email = f"googleonly_{uuid.uuid4().hex[:10]}@example.com"
    google_sub = f"google-sub-{uuid.uuid4().hex[:12]}"
    with SessionLocal() as db:
        u = User(
            google_id=google_sub,
            login=email,
            password_hash=None,
            email_verified=True,
        )
        db.add(u)
        db.commit()

    reg = client.post(
        "/auth/register",
        json={"email": email, "password": "newpass1234", "name": "G User"},
    )
    assert reg.status_code == 200, reg.text
    body = reg.json()
    assert body.get("google_account_exists") is True
    assert body.get("email") == email
    assert "message" in body
    assert body.get("verification_required") is not True

    with SessionLocal() as db:
        row = db.execute(select(User).where(func.lower(User.login) == email)).scalar_one()
        assert row.pending_password_hash is not None
        assert verify_password("newpass1234", row.pending_password_hash)

    pic_url = "https://example.com/google-avatar.png"
    mock_google = {
        "id": google_sub,
        "email": email,
        "name": "G User",
        "picture": pic_url,
    }
    with patch("app.main.exchange_google_code", new_callable=AsyncMock, return_value=mock_google):
        go = client.post(
            "/auth/google/callback",
            json={"code": "abc", "redirect_uri": "https://example.com/callback"},
        )
    assert go.status_code == 200, go.text
    body_go = go.json()
    assert body_go["user"]["avatar_url"] == pic_url
    assert body_go["user"]["name"] == "G User"

    with SessionLocal() as db:
        row = db.execute(select(User).where(func.lower(User.login) == email)).scalar_one()
        assert row.pending_password_hash is None
        assert row.password_hash is not None
        assert verify_password("newpass1234", row.password_hash)
        assert row.avatar_url == pic_url
        assert row.display_name == "G User"

    ok = client.post(
        "/auth/login",
        json={"email": email, "password": "newpass1234"},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["user"]["login"] == email
    assert ok.json()["user"]["avatar_url"] == pic_url


def test_google_callback_links_existing_email_password_account(client):
    """Google OAuth with same email as an email/password user attaches Google id; both logins work."""
    from unittest.mock import AsyncMock, patch

    email = f"link_{uuid.uuid4().hex[:10]}@example.com"
    with patch("app.main.generate_verification_code", return_value="654321"):
        reg = client.post(
            "/auth/register",
            json={"email": email, "password": "pwlinks1234", "name": "Local First"},
        )
    assert reg.status_code == 200, reg.text
    assert reg.json().get("verification_required") is True
    v = client.post("/auth/verify-email", json={"email": email, "code": "654321"})
    assert v.status_code == 200, v.text

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
    assert body["user"]["avatar_url"] == "https://example.com/a.png"
    assert "notice" in body
    assert "linked" in body["notice"].lower()

    pw = client.post("/auth/login", json={"email": email, "password": "pwlinks1234"})
    assert pw.status_code == 200, pw.text
    assert pw.json()["user"]["login"] == email
    assert pw.json()["user"]["avatar_url"] == "https://example.com/a.png"
    assert pw.json()["user"]["name"] == "From Google"

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


# ── Account / password reset ─────────────────────────────────────


def _register_and_verify_email_user(client, *, email=None, password="secret1234"):
    email = email or f"acct_{uuid.uuid4().hex[:10]}@example.com"
    with patch("app.main.generate_verification_code", return_value="123456"):
        reg = client.post(
            "/auth/register",
            json={"email": email, "password": password, "name": "Acct"},
        )
    assert reg.status_code == 200, reg.text
    v = client.post("/auth/verify-email", json={"email": email, "code": "123456"})
    assert v.status_code == 200, v.text
    return email, v.json()["token"]


def test_forgot_password_returns_ok_without_leak(client):
    r = client.post("/auth/forgot-password", json={"email": "no_such_user_xyz@example.com"})
    assert r.status_code == 200
    assert r.json().get("ok") is True


def test_reset_password_flow(client):
    email, _token = _register_and_verify_email_user(client)
    with patch("app.main.generate_password_reset_token", return_value="fixed_reset_token_xyz"):
        fr = client.post("/auth/forgot-password", json={"email": email})
    assert fr.status_code == 200
    rs = client.post(
        "/auth/reset-password",
        json={"token": "fixed_reset_token_xyz", "new_password": "newsecret99"},
    )
    assert rs.status_code == 200, rs.text
    assert client.post("/auth/login", json={"email": email, "password": "secret1234"}).status_code == 401
    assert client.post("/auth/login", json={"email": email, "password": "newsecret99"}).status_code == 200


def test_auth_me_and_change_password(client):
    email, token = _register_and_verify_email_user(client)
    me = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json().get("has_password") is True
    ch = client.post(
        "/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={"current_password": "secret1234", "new_password": "changed111"},
    )
    assert ch.status_code == 200, ch.text
    assert client.post("/auth/login", json={"email": email, "password": "secret1234"}).status_code == 401
    assert client.post("/auth/login", json={"email": email, "password": "changed111"}).status_code == 200


def test_delete_account_blocked_when_workspace_owner(client):
    email, token = _register_and_verify_email_user(client)
    ent = client.post(
        "/enterprises",
        headers={"Authorization": f"Bearer {token}"},
        json={"name": "Owner workspace"},
    )
    assert ent.status_code == 200, ent.text
    owner_token = ent.json()["token"]
    del_req = client.post(
        "/auth/delete-account",
        headers={"Authorization": f"Bearer {owner_token}"},
        json={"password": "secret1234"},
    )
    assert del_req.status_code == 409, del_req.text


def test_delete_account_succeeds_without_owned_workspace(client):
    email, token = _register_and_verify_email_user(client)
    del_req = client.post(
        "/auth/delete-account",
        headers={"Authorization": f"Bearer {token}"},
        json={"password": "secret1234"},
    )
    assert del_req.status_code == 200, del_req.text
    assert client.post("/auth/login", json={"email": email, "password": "secret1234"}).status_code == 401
