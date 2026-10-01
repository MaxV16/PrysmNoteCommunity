"""One-time app login codes for the mobile/desktop deep-link exchange.

A short-lived, single-use JWT carrying only the user id, used by the app flows
(Capacitor mobile and Electron desktop) where session cookies cannot be set in
the system browser. Expiry is enforced by the JWT ``exp``; single use by
blacklisting the ``jti`` in ``token_blacklist`` at exchange time
(``GET /api/auth/mobile/exchange``). Shared by the OAuth SSO callback and the
WebAuthn passkey login so both app flows use the exact same mechanism.
"""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from jose import jwt

from app.config import settings
from app.models.user import User

MOBILE_CODE_TTL_MINUTES = 2


def create_app_login_code(user: User) -> str:
    expires = datetime.now(timezone.utc) + timedelta(minutes=MOBILE_CODE_TTL_MINUTES)
    return jwt.encode(
        {"sub": str(user.id), "exp": expires, "type": "mobile_oauth", "jti": str(uuid4())},
        settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
    )
