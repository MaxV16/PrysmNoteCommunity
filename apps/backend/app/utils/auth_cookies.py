"""Shared HTTP-only cookie helpers for setting/clearing the auth session."""
from fastapi import Request
from fastapi.responses import Response

from app.config import settings

# Backend OAuth callback URI for SSO (registered on the Google/GitHub OAuth apps).
# This is distinct from the integration redirect (/settings). Default to localhost.
OAUTH_REDIRECT_URI = settings.oauth_redirect_uri


def cookie_secure(request: Request) -> bool:
    return request.url.scheme == "https"


def set_auth_cookies(response: Response, user_id: str, request: Request) -> None:
    from app.services.auth_service import create_access_token, create_refresh_token

    secure = cookie_secure(request)
    access_token = create_access_token(user_id)
    refresh_token = create_refresh_token(user_id)
    response.set_cookie(
        key="access_token", value=access_token,
        httponly=True, secure=secure, samesite="lax", max_age=15 * 60, path="/",
    )
    response.set_cookie(
        key="refresh_token", value=refresh_token,
        httponly=True, secure=secure, samesite="lax", max_age=7 * 24 * 60 * 60, path="/",
    )
