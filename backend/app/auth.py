import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

import httpx
import jwt
from fastapi import Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select

from app.db import SessionLocal
from app.models import User, UserRole

_bearer = HTTPBearer(auto_error=False)

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
JWT_SECRET = os.getenv("JWT_SECRET", secrets.token_hex(32))
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = int(os.getenv("JWT_EXPIRY_HOURS", "168"))  # 7 days


def _decode_jwt(token: str) -> dict | None:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except (jwt.InvalidTokenError, jwt.ExpiredSignatureError):
        return None


def create_jwt(google_user: dict, user: User | None = None) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(google_user["id"]),
        "login": google_user["email"],
        "name": google_user.get("name") or google_user["email"],
        "avatar_url": google_user.get("picture", ""),
        "enterprise_id": user.enterprise_id if user else None,
        "role": user.role.value if user else None,
        "iat": now,
        "exp": now + timedelta(hours=JWT_EXPIRY_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def require_auth(
    credentials: HTTPAuthorizationCredentials | None = Security(_bearer),
) -> User:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Missing authentication")

    token = credentials.credentials

    # Try API key first — treated as a synthetic admin (used in tests/scripts)
    api_key = os.getenv("API_KEY", "").strip()
    if api_key and hmac.compare_digest(token, api_key):
        return User(google_id="api_key", login="api_key", role=UserRole.admin)

    # Try JWT
    claims = _decode_jwt(token)
    if claims is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    google_id = claims.get("sub")
    with SessionLocal() as db:
        user = db.execute(select(User).where(User.google_id == google_id)).scalar_one_or_none()

    if user is None:
        raise HTTPException(status_code=401, detail="User not found — please log in again")

    return user


def require_admin(current_user: User = Depends(require_auth)) -> User:
    if current_user.role != UserRole.admin:
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user


async def exchange_google_code(code: str, redirect_uri: str) -> dict:
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        raise HTTPException(
            status_code=500,
            detail="Google OAuth not configured",
        )

    async with httpx.AsyncClient() as client:
        token_resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "code": code,
                "grant_type": "authorization_code",
                "redirect_uri": redirect_uri,
            },
            timeout=10.0,
        )

    if token_resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Google token exchange failed")

    token_data = token_resp.json()
    access_token = token_data.get("access_token")
    if not access_token:
        error = token_data.get("error_description", "Unknown error")
        raise HTTPException(status_code=401, detail=f"Google auth failed: {error}")

    async with httpx.AsyncClient() as client:
        user_resp = await client.get(
            "https://www.googleapis.com/oauth2/v2/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10.0,
        )

    if user_resp.status_code != 200:
        raise HTTPException(status_code=502, detail="Failed to fetch Google user info")

    return user_resp.json()
