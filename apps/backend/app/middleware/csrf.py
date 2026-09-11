import secrets
import hmac
from urllib.parse import urlparse

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.config import settings


def _cookie_secure(request: Request) -> bool:
    return request.url.scheme == "https"


def _get_origin(request: Request) -> str | None:
    """Extract the Origin header (preferred) or the Referer origin."""
    origin = request.headers.get("Origin")
    if origin:
        return origin
    referer = request.headers.get("Referer")
    if referer:
        try:
            parsed = urlparse(referer)
            return f"{parsed.scheme}://{parsed.netloc}".lower()
        except Exception:
            return None
    return None


def _origin_allowed(origin: str | None) -> bool:
    """Check Origin against csrf_allowed_origins. Missing origin is allowed
    (non-browser clients like curl/scripts pass through to the double-submit
    gate)."""
    if origin is None:
        return True
    allowed = [o.strip().lower() for o in settings.csrf_allowed_origins.split(",")]
    norm = origin.rstrip("/").lower()
    return norm in allowed


SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSRF_COOKIE_NAME = "csrf_token"
CSRF_HEADER_NAME = "X-CSRF-Token"
# Login/register/refresh/logout are CSRF-exempt (their own bearer/token flows
# protect them; logout is a trivial CSRF with no state change). Webhook
# endpoints are exempt because provider signature verification (Stripe HMAC)
# is the auth mechanism - an external webhook sender cannot read the
# double-submit cookie, so CSRF would only block legitimate provider deliveries.
CSRF_SAFE_PATHS = {
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/refresh",
    "/api/auth/logout",
    "/api/health",
    "/api/ee/billing/webhook/stripe",
}


class CSRFSecurityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not settings.csrf_enabled:
            return await call_next(request)
        if request.url.path in CSRF_SAFE_PATHS:
            return await call_next(request)

        if request.method in SAFE_METHODS:
            response = await call_next(request)
            csrf_token = request.cookies.get(CSRF_COOKIE_NAME)
            if not csrf_token:
                csrf_token = secrets.token_hex(32)
                response.set_cookie(
                    key=CSRF_COOKIE_NAME,
                    value=csrf_token,
                    httponly=False,
                    secure=_cookie_secure(request),
                    samesite="lax",
                    path="/",
                    max_age=86400,
                )
            return response

        # Origin/Referer allowlist check for unsafe methods.
        origin = _get_origin(request)
        if not _origin_allowed(origin):
            return JSONResponse(
                status_code=403,
                content={"detail": "Origin not allowed"},
            )

        csrf_cookie = request.cookies.get(CSRF_COOKIE_NAME)
        csrf_header = request.headers.get(CSRF_HEADER_NAME)

        if not csrf_cookie or not csrf_header:
            return JSONResponse(status_code=403, content={"detail": "CSRF token missing"})

        if not hmac.compare_digest(csrf_cookie, csrf_header):
            return JSONResponse(status_code=403, content={"detail": "CSRF token mismatch"})

        return await call_next(request)
