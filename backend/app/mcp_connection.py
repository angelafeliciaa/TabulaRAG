"""Gate the Streamable HTTP MCP endpoint; tool calls forward the same Bearer token to the API."""

import hmac
import os

from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.auth import auth_user_from_mcp_token

_bearer_mcp = HTTPBearer(auto_error=False)


def require_mcp_connection_auth(
    credentials: HTTPAuthorizationCredentials | None = Security(_bearer_mcp),
) -> None:
    """Allow MCP HTTP only with a valid per-user MCP token or the server API_KEY (tests/automation)."""
    if credentials is None:
        raise HTTPException(
            status_code=401,
            detail="MCP requires Authorization: Bearer <mcp-token>. Create a token in the app (MCP section).",
        )
    token = credentials.credentials
    api_key = os.getenv("API_KEY", "").strip()
    if api_key and hmac.compare_digest(token, api_key):
        return
    if auth_user_from_mcp_token(token) is not None:
        return
    raise HTTPException(
        status_code=401,
        detail="Invalid MCP access token.",
    )
