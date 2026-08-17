import logging
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from app.config import settings

logger = logging.getLogger(__name__)

_BREVO_SEND_URL = "https://api.brevo.com/v3/smtp/email"


def send_email(to_address: str, subject: str, body: str) -> bool:
    """Send a plain-text email through the configured provider.

    Core-owned (community-safe): the EE services call into this helper — core
    never imports from ``ee/`` (the community build strips it), so the generic
    send lives here. Returns True on success; logs and returns False when no
    provider is configured or the send fails.

    Transport priority: Brevo REST API (port 443 — reliable from any network)
    when ``BREVO_API_KEY`` is set, otherwise classic SMTP via ``SMTP_*`` envs.
    """
    if not settings.admin_email:
        logger.warning(
            "No ADMIN_EMAIL configured, skipping email to %s: %s", to_address, subject
        )
        return False

    if settings.brevo_api_key:
        return _send_brevo_api(to_address, subject, body)

    if not settings.smtp_host:
        logger.warning("SMTP not configured, skipping email to %s: %s", to_address, subject)
        return False
    return _send_smtp(to_address, subject, body)


def _send_brevo_api(to_address: str, subject: str, body: str) -> bool:
    import httpx

    payload = {
        "sender": {"name": "Prysm Note", "email": settings.admin_email},
        "to": [{"email": to_address}],
        "subject": subject,
        "textContent": body,
    }
    headers = {
        "api-key": settings.brevo_api_key,
        "accept": "application/json",
        "content-type": "application/json",
    }
    # Retry once on transient HTTP/network errors; the API runs on 443, which is
    # reliable on the prod VM (SMTP ports are blocked/flaky there).
    for attempt in range(2):
        try:
            resp = httpx.post(_BREVO_SEND_URL, json=payload, headers=headers, timeout=20)
            if resp.status_code in (200, 201):
                return True
            if resp.status_code >= 500 or resp.status_code == 429:
                if attempt == 0:
                    continue
            logger.warning(
                "Brevo API send to %s returned %s: %s", to_address, resp.status_code, resp.text[:200]
            )
            return False
        except Exception:
            if attempt == 0:
                continue
            logger.exception("Failed to send email via Brevo API to %s", to_address)
    return False


def _send_smtp(to_address: str, subject: str, body: str) -> bool:
    try:
        msg = MIMEMultipart("alternative")
        # From = the public sender (ADMIN_EMAIL, e.g. support@prysmnote.com), not
        # the SMTP login (which is an API key with Brevo, or a Gmail address).
        msg["From"] = settings.admin_email or settings.smtp_user
        msg["To"] = to_address
        msg["Subject"] = subject
        msg.attach(MIMEText(body, "plain", "utf-8"))

        if settings.smtp_port == 465:
            with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=15) as server:
                if settings.smtp_user:
                    server.login(settings.smtp_user, settings.smtp_password)
                server.send_message(msg)
        else:
            with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as server:
                server.starttls()
                if settings.smtp_user:
                    server.login(settings.smtp_user, settings.smtp_password)
                server.send_message(msg)
        return True
    except Exception:
        logger.exception("Failed to send email via SMTP to %s", to_address)
        return False
