"""OAuth SSO login (Google + GitHub).

Allows a regular user to sign in with their Google or GitHub account. OAuth
users are created in the SAME `users` table as email/password accounts (keyed by
verified email, with `provider` set and `password_hash` NULL).

Flow:
  GET /api/auth/oauth/{provider}/start   -> 307 redirect to the provider
  GET /api/auth/oauth/{provider}/callback -> exchange code, create/log in,
                                             set session cookies, redirect to the app

Mobile (Capacitor) flow: the WebView cannot run OAuth provider flows directly
(Google blocks embedded webviews), so `GET ?redirect=mobile` on start opens the
provider in the system browser via @capacitor/browser. The callback then issues
a short-lived, single-use one-time code and 307s to the app's custom deep link
`com.prysmnote.app://oauth/client?code=...`; the native side catches `appUrlOpen`
and loads `GET /api/auth/mobile/exchange?code=...` inside the WebView, where the
code is validated, the session cookies are set, and the app reloads at `/`.

Desktop (Electron) flow: identical idea, separate scheme. `GET ?redirect=desktop`
(or with a `nonce`) opens the provider in the system browser; the callback 307s to
`prysmnote://oauth/callback?code=...&nonce=...`. The Electron main process verifies
the nonce it generated, then loads the same exchange URL inside the app window so
the cookies land there. This avoids Google's embedded-webview block, which the old
in-window redirect hit on macOS/Windows.
"""
import logging
import re
import secrets
from datetime import datetime, timezone
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import RedirectResponse
from jose import jwt, JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models.user import User
from app.services.app_login_codes import create_app_login_code
from app.services.auth_service import create_access_token, create_refresh_token
from app.utils.auth_cookies import set_auth_cookies, OAUTH_REDIRECT_URI
from app.utils.ratelimit import RateLimiter
from app.utils.token_revocation import blacklist_jti

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth/oauth", tags=["oauth"])

_PROVIDERS = {"google", "github"}

# GitHub shares Google's single callback URI (the `google` in the path is a
# documented quirk), so GitHub authorization codes arrive at /google/callback.
# GitHub codes are exactly 20 lowercase hex chars; Google codes never are.
GITHUB_CODE_RE = re.compile(r"^[0-9a-f]{20}$")

# Google verify_id_token needs the client id to enforce audience; pass it through.
# GitHub needs user read scopes to retrieve a verified primary email.
GITHUB_SCOPES = "read:user user:email"

# Mobile (Capacitor) SSO: the WebView cannot run OAuth provider flows directly
# (Google blocks embedded webviews), so the provider opens in the system browser
# via @capacitor/browser. The callback footer carries this marker in the state
# cookie so it survives the provider round-trip without extra OAuth console
# registrations: we keep the web OAUTH_REDIRECT_URI and only change the
# POST-consent destination. The one-time code is a JWT (type=mobile_oauth,
# exp ~2 min) consumed exactly once at /api/auth/mobile/exchange (its jti is
# blacklisted on use, mirroring the password-reset token pattern).
MOBILE_REDIRECT_PARAM = "mobile"
MOBILE_STATE_PREFIX = "mobile:"
# Desktop (Electron) uses the same one-time-code exchange but its own scheme and
# a nonce the app generates, so a stray `prysmnote://` link cannot log the app
# into an account the user did not authenticate as (login-CSRF guard).
DESKTOP_REDIRECT_PARAM = "desktop"
DESKTOP_STATE_PREFIX = "desktop:"
DESKTOP_DEEP_LINK = "prysmnote://oauth/callback"
NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MOBILE_EXCHANGE_LIMIT = 20  # per IP, per window of 10 minutes
MOBILE_EXCHANGE_WINDOW = 10 * 60

mobile_router = APIRouter(prefix="/api/auth/mobile", tags=["oauth"])

_mobile_exchange_limiter = RateLimiter("rl:mobile_oauth")


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
async def oauth_start(
    provider: str,
    request: Request,
    redirect: str | None = None,
    nonce: str | None = None,
):
    if provider not in _PROVIDERS:
        return RedirectResponse(url=_app_url("/login?error=unsupported_provider"), status_code=302)
    if not _configured(provider):
        return RedirectResponse(url=_app_url("/login?error=sso_not_configured"), status_code=302)
    state = secrets.token_urlsafe(24)
    # Persist the state so the callback can validate it (store in a signed cookie).
    # For the app flows the state string is prefixed with a marker so the callback
    # knows to send the session to the app's custom deep link instead of setting
    # cookies in the system browser (where they would be useless). The desktop
    # marker also carries the nonce the app generated, which the callback echoes
    # back so the app can reject a deep link it did not initiate.
    mobile = redirect == MOBILE_REDIRECT_PARAM
    desktop = redirect == DESKTOP_REDIRECT_PARAM
    if mobile:
        # Mobile carries a nonce too (like desktop) so a stray
        # com.prysmnote.app:// link cannot log the app into an account the user
        # did not authenticate as (login-CSRF guard).
        safe_nonce = nonce if nonce and NONCE_RE.fullmatch(nonce) else ""
        cookie_value = f"{MOBILE_STATE_PREFIX}{safe_nonce}:{state}"
    elif desktop:
        safe_nonce = nonce if nonce and NONCE_RE.fullmatch(nonce) else ""
        cookie_value = f"{DESKTOP_STATE_PREFIX}{safe_nonce}:{state}"
    else:
        cookie_value = state
    response = RedirectResponse(url=_provider_authorize_url(provider, state), status_code=302)
    response.set_cookie("oauth_state", cookie_value, httponly=True, samesite="lax",
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

    # GitHub's OAuth app is registered with the same callback URL as Google (the
    # shared OAUTH_REDIRECT_URI), so GitHub codes come back to /google/callback.
    # Detect the 20-hex GitHub code and route it to the GitHub exchange.
    if provider == "google" and code and GITHUB_CODE_RE.fullmatch(code):
        provider = "github"

    expected_raw = request.cookies.get("oauth_state") if request else None
    app_flow: str | None = None
    mobile_nonce = ""
    desktop_nonce = ""
    expected_state = expected_raw
    if expected_raw and expected_raw.startswith(DESKTOP_STATE_PREFIX):
        app_flow = "desktop"
        rest = expected_raw[len(DESKTOP_STATE_PREFIX):]
        desktop_nonce, _, expected_state = rest.partition(":")
    elif expected_raw and expected_raw.startswith(MOBILE_STATE_PREFIX):
        app_flow = "mobile"
        rest = expected_raw[len(MOBILE_STATE_PREFIX):]
        # New format is "<nonce>:<state>"; a cookie without a colon (older
        # backend, no nonce) is treated as the state alone.
        if ":" in rest:
            mobile_nonce, _, expected_state = rest.partition(":")
        else:
            mobile_nonce = ""
            expected_state = rest
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
    # Clear the state cookie now that it's consumed (landing in the system
    # browser whether the flow was mobile or web).
    response.delete_cookie("oauth_state", path="/")

    if app_flow == "mobile":
        # Mobile: the provider ran in the system browser, so cookies set here
        # would never reach the WebView. Issue a short-lived one-time code and
        # bounce to the app's custom deep link instead; the native side loads
        # GET /api/auth/mobile/exchange?code=... inside the WebView where the
        # session cookies finally land. Echo the nonce so the app only accepts
        # a deep link for the flow it started.
        code = _create_mobile_code(user)
        suffix = f"&nonce={mobile_nonce}" if mobile_nonce else ""
        return RedirectResponse(url=f"com.prysmnote.app://oauth/client?code={code}{suffix}", status_code=307)

    if app_flow == "desktop":
        # Desktop: same reason, and Electron's protocol handler loads the
        # exchange URL in the app window. Echo the nonce so the app only accepts
        # the deep link for the flow it started.
        code = _create_mobile_code(user)
        # desktop_nonce passed NONCE_RE, so it is already URL-safe.
        suffix = f"&nonce={desktop_nonce}" if desktop_nonce else ""
        return RedirectResponse(url=f"{DESKTOP_DEEP_LINK}?code={code}{suffix}", status_code=307)

    set_auth_cookies(response, str(user.id), request, user.token_version)
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
        # The provider verified this email address, so the account is confirmed.
        existing.email_verified = True
        await session.flush()
        return existing

    user = User(
        email=email,
        password_hash=None,
        display_name=name or None,
        provider=provider,
        email_verified=True,  # SSO emails are verified by the provider
    )
    session.add(user)
    await session.flush()
    return user


def _create_mobile_code(user: User) -> str:
    """Short-lived, single-use code for the app deep-link exchange.

    Thin wrapper around ``app.services.app_login_codes.create_app_login_code``
    (shared with the passkey login flow); kept here so existing callers/tests
    keep their import.
    """
    return create_app_login_code(user)


@mobile_router.get("/exchange")
async def mobile_exchange(
    code: str,
    request: Request,
    session: AsyncSession = Depends(get_db),
):
    """Validate an app one-time code and set the session cookies.

    Called from inside the Capacitor WebView (``com.prysmnote.app://`` deep link)
    or the Electron window (``prysmnote://`` deep link) after the native main
    process catches it. Cookies set here land in that app's cookie store, so it
    is authenticated immediately. The code is single-use (jti blacklisted) and
    both expired and replayed codes are rejected identically.
    """
    client_ip = request.client.host if request.client else "unknown"
    if _mobile_exchange_limiter.count(f"exchange:{client_ip}", MOBILE_EXCHANGE_WINDOW) > MOBILE_EXCHANGE_LIMIT:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many attempts")

    try:
        payload = jwt.decode(code, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        if payload.get("type") != "mobile_oauth":
            raise ValueError("wrong token type")
        user_id, jti = payload.get("sub"), payload.get("jti")
        if not user_id or not jti:
            raise ValueError("missing claims")
    except (JWTError, ValueError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired code")

    # Single-use: the code's jti is blacklisted on first use. The insert is
    # race-safe, so a concurrent replay is rejected with 400 rather than 500 on
    # the unique jti constraint.
    exp = payload.get("exp")
    expires_at = datetime.fromtimestamp(exp, tz=timezone.utc) if exp else datetime.now(timezone.utc)
    if not await blacklist_jti(session, jti, UUID(user_id), expires_at):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired code")

    result = await session.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired code")

    response = RedirectResponse(url=_app_url("/"), status_code=307)
    set_auth_cookies(response, str(user.id), request, user.token_version)
    return response
