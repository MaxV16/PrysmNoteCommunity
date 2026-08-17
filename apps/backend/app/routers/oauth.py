"""OAuth SSO login (Google + GitHub).

Allows a regular user to sign in with their Google or GitHub account. OAuth
users are created in the SAME `users` table as email/password accounts (keyed by
verified email, with `provider` set and `password_hash` NULL).

Flow:
  GET /api/auth/oauth/{provider}/start   -> 307 redirect to the provider
  GET /api/auth/oauth/{provider}/callback -> exchange code, create/log in,
                                             set session cookies, redirect to the app
"""
import logging
import secrets

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.user import User
from app.services.auth_service import create_access_token, create_refresh_token
from app.utils.auth_cookies import set_auth_cookies, OAUTH_REDIRECT_URI

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth/oauth", tags=["oauth"])

_PROVIDERS = {"google", "github"}

# Google verify_id_token needs the client id to enforce audience; pass it through.
# GitHub needs user read scopes to retrieve a verified primary email.
GITHUB_SCOPES = "read:user user:email"


def _provider_authorize_url(provider: str, state: str) -> str:
    from urllib.parse import urlencode
    if provider == "github":
        params = {
            "client_id": settings.github_client_id,
            "redirect_uri": OAUTH_REDIRECT_URI,
            "scope": GITHUB_SCOPES,
            "state": state,
            "allow_signup": "true",
        }
        return f"https://github.com/login/oauth/authorize?{urlencode(params)}"
    # google
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": OAUTH_REDIRECT_URI,
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "prompt": "select_account",
    }
    return f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}"


def _configured(provider: str) -> bool:
    if provider == "github":
        return bool(settings.github_client_id and settings.github_client_secret)
    return bool(settings.google_client_id and settings.google_client_secret)


def _app_url(path: str) -> str:
    return f"{settings.app_origin}{path}"


@router.get("/{provider}/start")
async def oauth_start(provider: str, request: Request):
    if provider not in _PROVIDERS:
        return RedirectResponse(url=_app_url("/login?error=unsupported_provider"), status_code=302)
    if not _configured(provider):
        return RedirectResponse(url=_app_url("/login?error=sso_not_configured"), status_code=302)
    state = secrets.token_urlsafe(24)
    # Persist the state so the callback can validate it (store in a signed cookie).
    response = RedirectResponse(url=_provider_authorize_url(provider, state), status_code=302)
    response.set_cookie("oauth_state", state, httponly=True, samesite="lax",
                        secure=request.url.scheme == "https", path="/")
    return response


@router.get("/{provider}/callback")
async def oauth_callback(
    provider: str,
    code: str,
    state: str,
    error: str | None = None,
    request: Request = None,
    session: AsyncSession = Depends(get_db),
):
    return_url = request.query_params.get("return") or "/"
    # Only allow same-app relative paths. A single "/" prefix is not enough:
    # "//evil.com" is protocol-relative and would become an open redirect.
    if not return_url.startswith("/") or return_url.startswith("//"):
        return_url = "/"
    if error:
        return RedirectResponse(url=_app_url(f"/login?error=sso_{error}"), status_code=307)

    if provider not in _PROVIDERS:
        return RedirectResponse(url=_app_url("/login?error=unsupported_provider"), status_code=307)

    expected_state = request.cookies.get("oauth_state") if request else None
    if not expected_state or not secrets.compare_digest(expected_state, state or ""):
        return RedirectResponse(url=_app_url("/login?error=sso_invalid_state"), status_code=307)

    try:
        identity = await _fetch_identity(provider, code)
    except Exception as exc:  # noqa: BLE001
        logger.warning("OAuth callback failed for %s: %s", provider, exc)
        return RedirectResponse(url=_app_url("/login?error=sso_failed"), status_code=307)

    email = (identity.get("email") or "").lower().strip()
    if not email:
        return RedirectResponse(url=_app_url("/login?error=sso_no_email"), status_code=307)
    # Require a verified email from the provider so a login can't be taken over
    # with an unverified address. GitHub only returns primary+verified emails;
    # Google is checked explicitly below.
    if identity.get("email_verified") is False:
        return RedirectResponse(url=_app_url("/login?error=sso_email_not_verified"), status_code=307)

    user = await _getorcreate_user(session, email, identity, provider)

    response = RedirectResponse(url=_app_url(return_url), status_code=307)
    set_auth_cookies(response, str(user.id), request, user.token_version)
    # Clear the state cookie now that it's consumed.
    response.delete_cookie("oauth_state", path="/")
    return response


async def _fetch_identity(provider: str, code: str) -> dict:
    if provider == "github":
        return await _exchange_github(code)
    return await _exchange_google(code)


async def _exchange_github(code: str) -> dict:
    if not _configured("github"):
        raise RuntimeError("GitHub SSO not configured")
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://github.com/login/oauth/access_token",
            data={
                "client_id": settings.github_client_id,
                "client_secret": settings.github_client_secret,
                "code": code,
                "redirect_uri": OAUTH_REDIRECT_URI,
            },
            headers={"Accept": "application/json"},
        )
        resp.raise_for_status()
        payload = resp.json()
        token = payload.get("access_token")
        if not token:
            raise RuntimeError("GitHub returned no access token")
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "User-Agent": "PrysmNote-SSO",
        }
        me = (await client.get("https://api.github.com/user", headers=headers)).json()
        email = me.get("email")
        if not email:
            emails = (await client.get("https://api.github.com/user/emails", headers=headers)).json()
            if isinstance(emails, list):
                for e in emails:
                    if e.get("primary") and e.get("verified") and e.get("email"):
                        email = e["email"]
                        break
        return {
            "email": email or "",
            "name": me.get("name") or me.get("login"),
        }


async def _exchange_google(code: str) -> dict:
    from urllib.parse import urlencode
    if not _configured("google"):
        raise RuntimeError("Google SSO not configured")
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": OAUTH_REDIRECT_URI,
                "grant_type": "authorization_code",
            },
            headers={"Accept": "application/json"},
        )
        resp.raise_for_status()
        payload = resp.json()
        id_token = payload.get("id_token")
        if not id_token:
            raise RuntimeError("Google returned no id_token")
        # Verify audience (this client) via google-auth's id_token verifier.
        from google.oauth2 import id_token as google_id_token
        from google.auth.transport.requests import Request as GoogleRequest
        info = google_id_token.verify_oauth2_token(
            id_token, GoogleRequest(), audience=settings.google_client_id
        )
        return {
            "email": info.get("email") or "",
            "name": info.get("name") or info.get("email", "").split("@")[0],
            "email_verified": bool(info.get("email_verified")),
        }


async def _getorcreate_user(session: AsyncSession, email: str, identity: dict, provider: str) -> User:
    existing = (await session.execute(select(User).where(User.email == email))).scalar_one_or_none()
    name = (identity.get("name") or "").strip()[:100] or email.split("@")[0]
    if existing:
        # Link the SSO provider if the account was previously email/password.
        if existing.provider is None:
            existing.provider = provider
            await session.flush()
        return existing

    user = User(email=email, password_hash=None, display_name=name or None, provider=provider)
    session.add(user)
    await session.flush()
    return user
