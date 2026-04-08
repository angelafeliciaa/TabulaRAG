"""Send email verification codes (Resend API) and hash/compare codes."""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets

import httpx

logger = logging.getLogger(__name__)

_VERIFICATION_CODE_TTL_MINUTES = int(os.getenv("VERIFY_EMAIL_CODE_TTL_MINUTES", "15"))
_PASSWORD_RESET_TTL_MINUTES = int(os.getenv("PASSWORD_RESET_TTL_MINUTES", "60"))

_RESEND_API_URL = "https://api.resend.com/emails"


def _signing_key() -> bytes:
    secret = os.getenv("JWT_SECRET", "").strip()
    if not secret:
        raise RuntimeError("JWT_SECRET must be set to hash email verification codes")
    return secret.encode("utf-8")


def generate_verification_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def hash_verification_code(code: str) -> str:
    raw = (code or "").strip()
    return hmac.new(_signing_key(), raw.encode("utf-8"), hashlib.sha256).hexdigest()


def verification_codes_match(plain: str, stored_hash: str | None) -> bool:
    if not stored_hash:
        return False
    try:
        return hmac.compare_digest(hash_verification_code(plain), stored_hash)
    except Exception:
        return False


def normalize_verification_code_input(raw: str) -> str:
    """Allow spaces/dashes; keep digits only, expect 6 digits."""
    digits = "".join(c for c in (raw or "") if c.isdigit())
    return digits[-6:] if len(digits) >= 6 else digits


def smtp_configured() -> bool:
    """Returns True if email sending is configured (Resend API key present)."""
    return bool(os.getenv("RESEND_API_KEY", "").strip())


def _resend_from() -> str:
    return os.getenv("RESEND_FROM", "").strip() or os.getenv("SMTP_FROM", "").strip()


def _send_via_resend(to_addr: str, subject: str, body: str) -> bool:
    api_key = os.getenv("RESEND_API_KEY", "").strip()
    from_addr = _resend_from()
    if not from_addr:
        logger.error("RESEND_FROM (or SMTP_FROM) env var must be set to send email")
        return False
    try:
        resp = httpx.post(
            _RESEND_API_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json={"from": from_addr, "to": [to_addr], "subject": subject, "text": body},
            timeout=10,
        )
        if resp.status_code in (200, 201):
            return True
        logger.warning("Resend API error for %s: %s %s", to_addr, resp.status_code, resp.text)
        return False
    except Exception as exc:
        logger.warning("Resend send failed for %s: %s", to_addr, exc)
        return False


def send_verification_email(to_addr: str, code: str, display_name: str) -> bool:
    """
    Send verification email via Resend. Returns True on success.
    If RESEND_API_KEY is not set, logs the code (development fallback) and returns False.
    """
    if not os.getenv("RESEND_API_KEY", "").strip():
        logger.info(
            "Email verification code for %s (set RESEND_API_KEY to send real email): %s",
            to_addr,
            code,
        )
        return False

    app_name = os.getenv("EMAIL_VERIFICATION_APP_NAME", "TabulaRAG")
    subject = f"{app_name} — verify your email"
    body = (
        f"Hi {display_name},\n\n"
        f"Your verification code is: {code}\n\n"
        f"It expires in {_VERIFICATION_CODE_TTL_MINUTES} minutes.\n\n"
        "If you did not create an account, you can ignore this message.\n"
    )
    return _send_via_resend(to_addr, subject, body)


def verification_ttl_minutes() -> int:
    return _VERIFICATION_CODE_TTL_MINUTES


def password_reset_ttl_minutes() -> int:
    return _PASSWORD_RESET_TTL_MINUTES


def generate_password_reset_token() -> str:
    return secrets.token_urlsafe(32)


def hash_password_reset_token(token: str) -> str:
    raw = (token or "").strip().encode("utf-8")
    return hmac.new(_signing_key(), b"pwreset1:" + raw, hashlib.sha256).hexdigest()


def password_reset_tokens_match(plain: str, stored_hash: str | None) -> bool:
    if not stored_hash:
        return False
    try:
        return hmac.compare_digest(hash_password_reset_token(plain), stored_hash)
    except Exception:
        return False


def _public_ui_base() -> str:
    return (os.getenv("PUBLIC_UI_BASE_URL", "http://localhost:5173") or "http://localhost:5173").rstrip("/")


def send_password_reset_email(to_addr: str, token: str, display_name: str) -> bool:
    reset_url = f"{_public_ui_base()}/reset-password?token={token}"

    if not os.getenv("RESEND_API_KEY", "").strip():
        logger.info(
            "Password reset link for %s (set RESEND_API_KEY to send real email): %s",
            to_addr,
            reset_url,
        )
        return False

    app_name = os.getenv("EMAIL_VERIFICATION_APP_NAME", "TabulaRAG")
    subject = f"{app_name} — reset your password"
    body = (
        f"Hi {display_name},\n\n"
        "We received a request to reset your password. Open this link to choose a new one:\n\n"
        f"{reset_url}\n\n"
        f"The link expires in {_PASSWORD_RESET_TTL_MINUTES} minutes.\n\n"
        "If you did not request this, you can ignore this email.\n"
    )
    return _send_via_resend(to_addr, subject, body)
