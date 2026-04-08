"""Send email verification codes via Brevo HTTP API (with SMTP fallback) and hash/compare codes."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import smtplib
import ssl
import urllib.request
import urllib.error
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


def _brevo_api_key() -> str | None:
    """Return the Brevo API key (xkeysib-...), set via BREVO_API_KEY env var."""
    key = os.getenv("BREVO_API_KEY", "").strip()
    return key or None


def _send_via_brevo_api(from_addr: str, to_addr: str, subject: str, body: str) -> bool:
    """Send an email using Brevo's HTTP API (port 443, never blocked by cloud providers)."""
    api_key = _brevo_api_key()
    if not api_key:
        return False

    payload = json.dumps({
        "sender": {"email": from_addr},
        "to": [{"email": to_addr}],
        "subject": subject,
        "textContent": body,
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.brevo.com/v3/smtp/email",
        data=payload,
        headers={
            "api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            if resp.status in (200, 201):
                logger.info("Brevo API: email sent to %s", to_addr)
                return True
            logger.warning("Brevo API unexpected status %s for %s", resp.status, to_addr)
            return False
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
        logger.warning("Brevo API send failed for %s: %s", to_addr, exc)
        return False


def _send_via_smtp(from_addr: str, to_addr: str, subject: str, body: str) -> bool:
    """Send an email via SMTP (original method)."""
    host = os.getenv("SMTP_HOST", "").strip()
    port = int(os.getenv("SMTP_PORT", "587"))
    user = os.getenv("SMTP_USER", "").strip()
    password = os.getenv("SMTP_PASSWORD", "")
    use_tls = os.getenv("SMTP_USE_TLS", "true").lower() in ("1", "true", "yes")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = to_addr
    msg.set_content(body)

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
        logger.warning("SMTP send failed for %s: %s", to_addr, exc)
        return False
    return True


def _send_email(from_addr: str, to_addr: str, subject: str, body: str) -> bool:
    """Try Brevo HTTP API first (works on cloud platforms), fall back to SMTP."""
    if _brevo_api_key():
        if _send_via_brevo_api(from_addr, to_addr, subject, body):
            return True
        logger.info("Brevo API failed, falling back to SMTP for %s", to_addr)

    if os.getenv("SMTP_HOST", "").strip():
        return _send_via_smtp(from_addr, to_addr, subject, body)

    return False


def send_verification_email(to_addr: str, code: str, display_name: str) -> bool:
    """
    Send verification email. Returns True if delivery succeeded.
    If neither Brevo API nor SMTP is configured, logs the code (development) and returns False.
    """
    if not smtp_configured() and not _brevo_api_key():
        logger.info(
            "Email verification code for %s (set SMTP_HOST to send real email): %s",
            to_addr,
            code,
        )
        return False

    from_addr = os.getenv("SMTP_FROM", "").strip() or os.getenv("SMTP_USER", "").strip()
    if not from_addr:
        logger.error("SMTP_FROM or SMTP_USER required to send email")
        return False

    app_name = os.getenv("EMAIL_VERIFICATION_APP_NAME", "TabulaRAG")
    subject = f"{app_name} — verify your email"
    body = (
        f"Hi {display_name},\n\n"
        f"Your verification code is: {code}\n\n"
        f"It expires in {_VERIFICATION_CODE_TTL_MINUTES} minutes.\n\n"
        "If you did not create an account, you can ignore this message.\n"
    )

    return _send_email(from_addr, to_addr, subject, body)


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

    if not smtp_configured() and not _brevo_api_key():
        logger.info(
            "Password reset link for %s (set SMTP_HOST to send real email): %s",
            to_addr,
            reset_url,
        )
        return False

    from_addr = os.getenv("SMTP_FROM", "").strip() or os.getenv("SMTP_USER", "").strip()
    if not from_addr:
        logger.error("SMTP_FROM or SMTP_USER required to send email")
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

    return _send_email(from_addr, to_addr, subject, body)
