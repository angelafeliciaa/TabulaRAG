"""Send email verification codes (SMTP) and hash/compare codes."""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import smtplib
import ssl
from email.message import EmailMessage

logger = logging.getLogger(__name__)

_VERIFICATION_CODE_TTL_MINUTES = int(os.getenv("VERIFY_EMAIL_CODE_TTL_MINUTES", "15"))
_PASSWORD_RESET_TTL_MINUTES = int(os.getenv("PASSWORD_RESET_TTL_MINUTES", "60"))


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
    return bool(os.getenv("SMTP_HOST", "").strip())


def send_verification_email(to_addr: str, code: str, display_name: str) -> bool:
    """
    Send verification email. Returns True if SMTP delivery was attempted and succeeded.
    If SMTP is not configured, logs the code (development) and returns False.
    """
    host = os.getenv("SMTP_HOST", "").strip()
    if not host:
        logger.info(
            "Email verification code for %s (set SMTP_HOST to send real email): %s",
            to_addr,
            code,
        )
        return False

    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER", "").strip()
    password = os.getenv("SMTP_PASSWORD", "")
    from_addr = os.getenv("SMTP_FROM", "").strip() or user
    if not from_addr:
        logger.error("SMTP_FROM or SMTP_USER required when SMTP_HOST is set")
        return False

    app_name = os.getenv("EMAIL_VERIFICATION_APP_NAME", "TabulaRAG")
    subject = f"{app_name} — verify your email"
    body = (
        f"Hi {display_name},\n\n"
        f"Your verification code is: {code}\n\n"
        f"It expires in {_VERIFICATION_CODE_TTL_MINUTES} minutes.\n\n"
        "If you did not create an account, you can ignore this message.\n"
    )

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg.set_content(body)

    use_tls = os.getenv("SMTP_USE_TLS", "true").lower() in ("1", "true", "yes")

    try:
        if port == 465:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, context=context, timeout=30) as smtp:
                if user:
                    smtp.login(user, password)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=30) as smtp:
                smtp.ehlo()
                if use_tls:
                    smtp.starttls(context=ssl.create_default_context())
                    smtp.ehlo()
                if user:
                    smtp.login(user, password)
                smtp.send_message(msg)
    except (OSError, smtplib.SMTPException) as exc:
        # Includes SMTPDataError (e.g. Resend 550: sandbox only sends to your account email until a domain is verified).
        logger.warning("SMTP send failed for %s: %s", to_addr, exc)
        return False

    return True


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
    host = os.getenv("SMTP_HOST", "").strip()
    reset_url = f"{_public_ui_base()}/reset-password?token={token}"
    if not host:
        logger.info(
            "Password reset link for %s (set SMTP_HOST to send real email): %s",
            to_addr,
            reset_url,
        )
        return False

    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER", "").strip()
    password = os.getenv("SMTP_PASSWORD", "")
    from_addr = os.getenv("SMTP_FROM", "").strip() or user
    if not from_addr:
        logger.error("SMTP_FROM or SMTP_USER required when SMTP_HOST is set")
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

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg.set_content(body)

    use_tls = os.getenv("SMTP_USE_TLS", "true").lower() in ("1", "true", "yes")

    try:
        if port == 465:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(host, port, context=context, timeout=30) as smtp:
                if user:
                    smtp.login(user, password)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=30) as smtp:
                smtp.ehlo()
                if use_tls:
                    smtp.starttls(context=ssl.create_default_context())
                    smtp.ehlo()
                if user:
                    smtp.login(user, password)
                smtp.send_message(msg)
    except (OSError, smtplib.SMTPException) as exc:
        logger.warning("SMTP password reset send failed for %s: %s", to_addr, exc)
        return False

    return True
