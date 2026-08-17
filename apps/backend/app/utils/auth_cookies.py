"""Shared HTTP-only cookie helpers for setting/clearing the auth session."""
from fastapi import Request
from fastapi.responses import Response

from app.config import settings

# Backend OAuth callback URI for SSO (registered on the Google/GitHub OAuth apps).
# This is distinct from the integration redirect (/settings). Default to localhost.
OAUTH_REDIRECT_URI = settings.oauth_redirect_uri


def cookie_secure(request: Request) -> bool:
    # Direct TLS: always secure.
    if request.url.scheme == "https":
        return True
    # Behind a TLS-terminating proxy (nginx/Cloudflare) the app sees http, but
    # X-Forwarded-Proto is trusted ONLY in production (where the prod Dockerfile
    # also runs uvicorn with --proxy-headers, so this is a defense-in-depth
    # fallback rather than the primary mechanism). In development we never trust
    # the header, so localhost stays http and `Secure` cookies are not set.
    if settings.is_production:
        return request.headers.get("x-forwarded-proto", "").lower() == "https"
    return False


def set_auth_cookies(response: Response, user_id: str, request: Request, token_version: int = 0) -> None:
    from app.services.auth_service import create_access_token, create_refresh_token

    secure = cookie_secure(request)
    access_token = create_access_token(user_id, token_version)
    refresh_token = create_refresh_token(user_id, token_version)
    response.set_cookie(
        key="access_token", value=access_token,
        httponly=True, secure=secure, samesite="lax", max_age=15 * 60, path="/",
    )
    response.set_cookie(
        key="refresh_token", value=refresh_token,
        httponly=True, secure=secure, samesite="lax", max_age=7 * 24 * 60 * 60, path="/",
    )
