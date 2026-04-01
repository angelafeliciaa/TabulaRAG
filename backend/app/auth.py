from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx
import jwt
from fastapi import Depends, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token as google_id_token
from sqlalchemy import select

from app.db import SessionLocal
from app.models import EnterpriseMembership, McpAccessToken, User, UserRole

_bearer = HTTPBearer(auto_error=False)

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
JWT_SECRET = os.getenv("JWT_SECRET", secrets.token_hex(32))
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_HOURS = int(os.getenv("JWT_EXPIRY_HOURS", "168"))  # 7 days

MCP_TOKEN_PREFIX = "tgr_mcp_"


def hash_mcp_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def auth_user_from_mcp_token(raw_token: str) -> AuthUser | None:
    """Resolve Bearer MCP token to AuthUser if membership still exists."""
    if not raw_token or not raw_token.startswith(MCP_TOKEN_PREFIX):
        return None
    th = hash_mcp_token(raw_token)
    with SessionLocal() as db:
        row = db.execute(select(McpAccessToken).where(McpAccessToken.token_hash == th)).scalar_one_or_none()
        if row is None:
            return None
        m = db.execute(
            select(EnterpriseMembership).where(
                EnterpriseMembership.user_id == row.user_id,
                EnterpriseMembership.enterprise_id == row.enterprise_id,
            ),
        ).scalar_one_or_none()
        if m is None:
            return None
        user = db.get(User, row.user_id)
        if user is None:
            return None
        return AuthUser(
            id=user.id,
            google_id=user.google_id,
            login=user.login,
            enterprise_id=row.enterprise_id,
            role=m.role,
        )


@dataclass
class AuthUser:
    """Authenticated identity plus active enterprise context (from DB)."""

    id: int
    google_id: str
    login: str
    enterprise_id: int | None
    role: UserRole | None


def _decode_jwt(token: str) -> dict | None:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except (jwt.InvalidTokenError, jwt.ExpiredSignatureError):
        return None


def get_active_membership(db, user: User) -> EnterpriseMembership | None:
    eid = user.last_active_enterprise_id
    if eid is not None:
        m = db.execute(
            select(EnterpriseMembership).where(
                EnterpriseMembership.user_id == user.id,
                EnterpriseMembership.enterprise_id == eid,
            ),
        ).scalar_one_or_none()
        if m is not None:
            return m
    return db.execute(
        select(EnterpriseMembership)
        .where(EnterpriseMembership.user_id == user.id)
        .order_by(EnterpriseMembership.id.asc()),
    ).scalars().first()


def mint_token_for_user(db, user: User, google_profile: dict | None = None) -> str:
    """JWT reflecting current `last_active_enterprise_id` and membership role."""
    profile = google_profile or {
        "id": user.google_id,
        "email": user.login,
        "name": user.login,
        "picture": "",
    }
    m = get_active_membership(db, user)
    return create_jwt(
        profile,
        enterprise_id=m.enterprise_id if m else None,
        role=m.role.value if m else None,
    )


def _auth_user_from_db_user(db, user: User) -> AuthUser:
    m = get_active_membership(db, user)
    if m is None:
        return AuthUser(
            id=user.id,
            google_id=user.google_id,
            login=user.login,
            enterprise_id=None,
            role=None,
        )
    if user.last_active_enterprise_id != m.enterprise_id:
        user.last_active_enterprise_id = m.enterprise_id
        db.add(user)
        db.commit()
        db.refresh(user)
    return AuthUser(
        id=user.id,
        google_id=user.google_id,
        login=user.login,
        enterprise_id=m.enterprise_id,
        role=m.role,
    )


def create_jwt(
    google_user: dict,
    *,
    enterprise_id: int | None = None,
    role: str | None = None,
) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(google_user["id"]),
        "login": google_user["email"],
        "name": google_user.get("name") or google_user["email"],
        "avatar_url": google_user.get("picture", ""),
        "enterprise_id": enterprise_id,
        "role": role,
        "iat": now,
        "exp": now + timedelta(hours=JWT_EXPIRY_HOURS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def require_auth(
    credentials: HTTPAuthorizationCredentials | None = Security(_bearer),
) -> AuthUser:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Missing authentication")

    token = credentials.credentials

    # Try API key first — treated as a synthetic admin (used in tests/scripts)
    api_key = os.getenv("API_KEY", "").strip()
    if api_key and hmac.compare_digest(token, api_key):
        return AuthUser(
            id=0,
            google_id="api_key",
            login="api_key",
            enterprise_id=None,
            role=UserRole.admin,
        )

    mcp_user = auth_user_from_mcp_token(token)
    if mcp_user is not None:
        return mcp_user

    claims = _decode_jwt(token)
    if claims is None:
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    google_id = claims.get("sub")
    with SessionLocal() as db:
        user = db.execute(select(User).where(User.google_id == google_id)).scalar_one_or_none()
        if user is None:
            raise HTTPException(status_code=401, detail="User not found — please log in again")
        return _auth_user_from_db_user(db, user)


def is_admin_capable(role: UserRole | None) -> bool:
    return role in (UserRole.admin, UserRole.owner)


def require_admin(current_user: AuthUser = Depends(require_auth)) -> AuthUser:
    if not is_admin_capable(current_user.role):
        raise HTTPException(
            status_code=403,
            detail="Owner or admin access required (queriers are read-only)",
        )
    return current_user


def require_owner(current_user: AuthUser = Depends(require_auth)) -> AuthUser:
    if current_user.role != UserRole.owner:
        raise HTTPException(status_code=403, detail="Enterprise owner access required")
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
    raw_id_token = token_data.get("id_token")
    if not raw_id_token:
        error = token_data.get("error_description", "Unknown error")
        raise HTTPException(status_code=401, detail=f"Google auth failed: {error}")

    try:
        claims = google_id_token.verify_oauth2_token(
            raw_id_token,
            google_requests.Request(),
            GOOGLE_CLIENT_ID,
        )
    except ValueError as exc:
        raise HTTPException(status_code=401, detail=f"Invalid Google ID token: {exc}") from exc

    return {
        "id": claims["sub"],
        "email": claims["email"],
        "name": claims.get("name", ""),
        "picture": claims.get("picture", ""),
    }
