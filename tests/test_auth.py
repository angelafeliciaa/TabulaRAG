"""Tests for app.auth – JWT creation, decoding, require_auth, and OAuth flows."""

import asyncio
import os
from unittest.mock import AsyncMock, patch, MagicMock

import pytest

from app.auth import _decode_jwt, create_jwt, require_auth, JWT_SECRET, JWT_ALGORITHM


# ── helpers ────────────────────────────────────────────────────────


def _google_user(**kwargs) -> dict:
    """Create a Google userinfo dict for testing."""
    defaults = {
        "id": "1",
        "email": "octocat@example.com",
        "name": "Octo Cat",
        "picture": "https://example.com/avatar.png",
    }
    defaults.update(kwargs)
    return defaults


# ── JWT round-trip ────────────────────────────────────────────────


def test_create_and_decode_jwt():
    user = _google_user()
    token = create_jwt(user)
    claims = _decode_jwt(token)
    assert claims is not None
    assert claims["sub"] == "1"
    assert claims["login"] == "octocat@example.com"
    assert claims["name"] == "Octo Cat"
    assert claims["avatar_url"] == "https://example.com/avatar.png"
    assert claims.get("enterprise_id") is None
    assert claims.get("role") is None


def test_create_jwt_uses_email_as_name_fallback():
    user = _google_user(name=None)
    token = create_jwt(user)
    claims = _decode_jwt(token)
    assert claims["name"] == "octocat@example.com"


def test_decode_jwt_invalid_token():
    assert _decode_jwt("not.a.valid.token") is None


def test_decode_jwt_wrong_secret():
    import jwt as pyjwt
    token = pyjwt.encode({"sub": "1"}, "wrong-secret", algorithm=JWT_ALGORITHM)
    assert _decode_jwt(token) is None


def test_decode_jwt_expired():
    import jwt as pyjwt
    from datetime import datetime, timedelta, timezone
    payload = {
        "sub": "1",
        "exp": datetime.now(timezone.utc) - timedelta(hours=1),
    }
    token = pyjwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)
    assert _decode_jwt(token) is None


# ── require_auth ──────────────────────────────────────────────────


def test_require_auth_missing_credentials():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc_info:
        require_auth(credentials=None)
    assert exc_info.value.status_code == 401
    assert "Missing" in exc_info.value.detail


def test_require_auth_valid_api_key():
    from app.models import UserRole
    cred = MagicMock()
    cred.credentials = os.environ.get("API_KEY", "test-key")
    result = require_auth(credentials=cred)
    assert result.google_id == "api_key"
    assert result.role == UserRole.admin


def test_require_auth_valid_jwt():
    from app.models import User, UserRole
    google_user = _google_user(id="99")
    token = create_jwt(google_user)
    cred = MagicMock()
    cred.credentials = token

    mock_user = User(google_id="99", login="octocat@example.com")
    mock_db = MagicMock()
    mock_db.execute.return_value.scalar_one_or_none.return_value = mock_user
    mock_db.__enter__ = MagicMock(return_value=mock_db)
    mock_db.__exit__ = MagicMock(return_value=False)

    with patch("app.auth.SessionLocal", return_value=mock_db):
        result = require_auth(credentials=cred)

    assert result.google_id == "99"


def test_require_auth_user_not_found():
    from fastapi import HTTPException
    google_user = _google_user(id="999")
    token = create_jwt(google_user)
    cred = MagicMock()
    cred.credentials = token

    mock_db = MagicMock()
    mock_db.execute.return_value.scalar_one_or_none.return_value = None
    mock_db.__enter__ = MagicMock(return_value=mock_db)
    mock_db.__exit__ = MagicMock(return_value=False)

    with patch("app.auth.SessionLocal", return_value=mock_db):
        with pytest.raises(HTTPException) as exc_info:
            require_auth(credentials=cred)
    assert exc_info.value.status_code == 401
    assert "not found" in exc_info.value.detail


def test_require_auth_invalid_token():
    from fastapi import HTTPException
    cred = MagicMock()
    cred.credentials = "totally-bogus-token"
    with pytest.raises(HTTPException) as exc_info:
        require_auth(credentials=cred)
    assert exc_info.value.status_code == 401
    assert "Invalid" in exc_info.value.detail


# ── exchange_google_code ──────────────────────────────────────────


def test_exchange_google_code_not_configured():
    from app.auth import exchange_google_code
    from fastapi import HTTPException
    with patch("app.auth.GOOGLE_CLIENT_ID", ""), patch("app.auth.GOOGLE_CLIENT_SECRET", ""):
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(exchange_google_code("some-code", "https://example.com/callback"))
        assert exc_info.value.status_code == 500
        assert "not configured" in exc_info.value.detail


def test_exchange_google_code_token_exchange_fails():
    from app.auth import exchange_google_code
    from fastapi import HTTPException

    mock_resp = MagicMock()
    mock_resp.status_code = 500

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("app.auth.GOOGLE_CLIENT_ID", "id"), \
         patch("app.auth.GOOGLE_CLIENT_SECRET", "secret"), \
         patch("app.auth.httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(exchange_google_code("bad-code", "https://example.com/callback"))
        assert exc_info.value.status_code == 502


def test_exchange_google_code_no_id_token():
    from app.auth import exchange_google_code
    from fastapi import HTTPException

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"error_description": "bad code"}

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("app.auth.GOOGLE_CLIENT_ID", "id"), \
         patch("app.auth.GOOGLE_CLIENT_SECRET", "secret"), \
         patch("app.auth.httpx.AsyncClient", return_value=mock_client):
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(exchange_google_code("bad-code", "https://example.com/callback"))
        assert exc_info.value.status_code == 401
        assert "bad code" in exc_info.value.detail


def test_exchange_google_code_invalid_id_token():
    from app.auth import exchange_google_code
    from fastapi import HTTPException

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"id_token": "bad.id.token"}

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch("app.auth.GOOGLE_CLIENT_ID", "id"), \
         patch("app.auth.GOOGLE_CLIENT_SECRET", "secret"), \
         patch("app.auth.httpx.AsyncClient", return_value=mock_client), \
         patch("app.auth.google_id_token.verify_oauth2_token", side_effect=ValueError("token invalid")):
        with pytest.raises(HTTPException) as exc_info:
            asyncio.run(exchange_google_code("bad-code", "https://example.com/callback"))
        assert exc_info.value.status_code == 401
        assert "Invalid Google ID token" in exc_info.value.detail


def test_exchange_google_code_success():
    from app.auth import exchange_google_code

    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"id_token": "valid.id.token"}

    mock_client = AsyncMock()
    mock_client.post = AsyncMock(return_value=mock_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    fake_claims = {
        "sub": "1",
        "email": "octocat@example.com",
        "name": "Octo",
        "picture": "",
    }

    with patch("app.auth.GOOGLE_CLIENT_ID", "id"), \
         patch("app.auth.GOOGLE_CLIENT_SECRET", "secret"), \
         patch("app.auth.httpx.AsyncClient", return_value=mock_client), \
         patch("app.auth.google_id_token.verify_oauth2_token", return_value=fake_claims):
        result = asyncio.run(exchange_google_code("good-code", "https://example.com/callback"))

    assert result["email"] == "octocat@example.com"
    assert result["id"] == "1"
