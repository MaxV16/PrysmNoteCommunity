"""WebAuthn passkey registration + sign-in (core feature, all users).

A passkey is an alternative sign-in method usable by any account, including
accounts created through Google/GitHub SSO. The browser/PWA runs the native
``navigator.credentials`` ceremony; the Electron desktop app hands the ceremony
to the system browser and returns through the same one-time-code deep link as
desktop SSO (``redirect=desktop`` + nonce).

Challenge handling: the challenge is stored in a short-lived HttpOnly cookie
(``webauthn_challenge``, 5 min) that also carries the flow type and, for
registration, the user id. It is deleted after a verify. Challenges never reach
JS, so a stolen page cannot replay one.

Security: ``expected_rp_id`` comes from config (never the request Host) and
``expected_origin`` must be in the configured origins; user verification is
required; raw assertions are never logged.
"""
import json
import logging
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, field_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from webauthn import (
    generate_authentication_options,
    generate_registration_options,
    options_to_json,
    verify_authentication_response,
    verify_registration_response,
)
from webauthn.helpers import base64url_to_bytes, bytes_to_base64url
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialDescriptor,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from app.config import settings
from app.database import get_db, get_system_db
from app.dependencies import get_current_user
from app.models.passkey import Passkey
from app.models.user import User
from app.routers.oauth import DESKTOP_DEEP_LINK, NONCE_RE
from app.services.app_login_codes import create_app_login_code
from app.utils.auth_cookies import cookie_secure, set_auth_cookies
from app.utils.client_ip import _client_ip
from app.utils.ratelimit import RateLimiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth/passkey", tags=["passkey"])

CHALLENGE_COOKIE = "webauthn_challenge"
CHALLENGE_TTL_SECONDS = 300
MAX_PASSKEYS_PER_USER = 20

# Per-IP limiter for the public login endpoints (the authenticated registration
# endpoints are already behind the session + CSRF gates).
_passkey_limiter = RateLimiter("rl:passkey")
LOGIN_LIMIT = 20
LOGIN_WINDOW = 5 * 60


def _set_challenge_cookie(response: Response, request: Request, flow: str, challenge: bytes, user_id: str = "") -> None:
    value = f"{flow}:{bytes_to_base64url(challenge)}:{user_id}"
    response.set_cookie(
        CHALLENGE_COOKIE,
        value,
        httponly=True,
        secure=cookie_secure(request),
        samesite="lax",
        max_age=CHALLENGE_TTL_SECONDS,
        path="/",
    )


def _clear_challenge_cookie(response: Response) -> None:
    response.delete_cookie(CHALLENGE_COOKIE, path="/")


def _read_challenge(request: Request, expected_flow: str) -> tuple[bytes, str]:
    raw = request.cookies.get(CHALLENGE_COOKIE) or ""
    flow, _, rest = raw.partition(":")
    if flow != expected_flow:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Challenge expired. Please try again.")
    challenge_b64, _, user_id = rest.partition(":")
    if not challenge_b64:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Challenge expired. Please try again.")
    try:
        return base64url_to_bytes(challenge_b64), user_id
    except Exception:  # noqa: BLE001
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Challenge expired. Please try again.")


def _credential_id_from(credential: dict) -> str:
    raw = credential.get("rawId") or credential.get("id") or ""
    if not isinstance(raw, str):
        return ""
    return raw


def _enforce_login_rate_limit(request: Request) -> None:
    ip = _client_ip(request)
    if _passkey_limiter.count(f"login:{ip}", LOGIN_WINDOW) > LOGIN_LIMIT:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Too many attempts - try again later")


class RegisterVerifyRequest(BaseModel):
    credential: dict
    name: str | None = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        if len(v) > 100:
            raise ValueError("Name must be at most 100 characters")
        return v or None


class RenamePasskeyRequest(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        v = v.strip()
        if not v or len(v) > 100:
            raise ValueError("Name must be between 1 and 100 characters")
        return v


class LoginVerifyRequest(BaseModel):
    credential: dict
    desktop_nonce: str | None = None


@router.post("/register/options")
async def register_options(
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    existing = (
        await session.execute(select(Passkey.credential_id).where(Passkey.user_id == user.id))
    ).scalars().all()
    exclude = [
        PublicKeyCredentialDescriptor(id=base64url_to_bytes(cid))
        for cid in existing
        if cid
    ]
    options = generate_registration_options(
        rp_id=settings.resolved_webauthn_rp_id,
        rp_name=settings.webauthn_rp_name,
        user_id=str(user.id).encode("utf-8"),
        user_name=user.email,
        user_display_name=user.display_name or user.email,
        exclude_credentials=exclude,
        # Discoverable (resident) credentials are required for the username-less
        # "Sign in with a passkey" flow; require user verification so the device
        # unlocks the credential.
        authenticator_selection=AuthenticatorSelectionCriteria(
            resident_key=ResidentKeyRequirement.REQUIRED,
            user_verification=UserVerificationRequirement.REQUIRED,
        ),
    )
    _set_challenge_cookie(response, request, "register", options.challenge, str(user.id))
    return json.loads(options_to_json(options))


@router.post("/register/verify")
async def register_verify(
    body: RegisterVerifyRequest,
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    challenge, cookie_user_id = _read_challenge(request, "register")
    # Bind the challenge to the account that requested it.
    if cookie_user_id and cookie_user_id != str(user.id):
        _clear_challenge_cookie(response)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Challenge expired. Please try again.")

    try:
        verified = verify_registration_response(
            credential=body.credential,
            expected_challenge=challenge,
            expected_rp_id=settings.resolved_webauthn_rp_id,
            expected_origin=settings.resolved_webauthn_origins,
            require_user_verification=True,
        )
    except Exception as exc:  # noqa: BLE001
        _clear_challenge_cookie(response)
        logger.info("Passkey registration failed: %s", type(exc).__name__)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Could not register this passkey.")

    credential_id = bytes_to_base64url(verified.credential_id)
    duplicate = (
        await session.execute(select(Passkey).where(Passkey.credential_id == credential_id))
    ).scalar_one_or_none()
    if duplicate:
        _clear_challenge_cookie(response)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This passkey is already registered.")

    count = (
        await session.execute(select(func.count()).select_from(Passkey).where(Passkey.user_id == user.id))
    ).scalar_one()
    if count >= MAX_PASSKEYS_PER_USER:
        _clear_challenge_cookie(response)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"You can register up to {MAX_PASSKEYS_PER_USER} passkeys.")

    transports = body.credential.get("response", {}).get("transports")
    if isinstance(transports, list):
        transports = ",".join(str(t) for t in transports)
    else:
        transports = None

    passkey = Passkey(
        user_id=user.id,
        credential_id=credential_id,
        public_key=verified.credential_public_key,
        sign_count=verified.sign_count,
        transports=transports[:64] if transports else None,
        aaguid=(str(verified.aaguid)[:64] if verified.aaguid else None),
        name=body.name,
    )
    session.add(passkey)
    try:
        await session.flush()
    except IntegrityError:
        # Two concurrent registrations of the same credential can race past the
        # duplicate check above; the unique constraint is the backstop.
        await session.rollback()
        _clear_challenge_cookie(response)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This passkey is already registered.")
    _clear_challenge_cookie(response)
    return {
        "id": str(passkey.id),
        "name": passkey.name,
        "created_at": passkey.created_at.isoformat() if passkey.created_at else None,
    }


@router.get("")
async def list_passkeys(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    rows = (
        await session.execute(
            select(Passkey).where(Passkey.user_id == user.id).order_by(Passkey.created_at.desc())
        )
    ).scalars().all()
    return [
        {
            "id": str(p.id),
            "name": p.name,
            "created_at": p.created_at.isoformat() if p.created_at else None,
            "last_used_at": p.last_used_at.isoformat() if p.last_used_at else None,
            "aaguid": p.aaguid,
            "transports": p.transports,
        }
        for p in rows
    ]


@router.patch("/{passkey_id}")
async def rename_passkey(
    passkey_id: UUID,
    body: RenamePasskeyRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    passkey = (
        await session.execute(
            select(Passkey).where(Passkey.id == passkey_id, Passkey.user_id == user.id)
        )
    ).scalar_one_or_none()
    if not passkey:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Passkey not found")
    passkey.name = body.name
    await session.flush()
    return {"id": str(passkey.id), "name": passkey.name}


@router.delete("/{passkey_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_passkey(
    passkey_id: UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    passkey = (
        await session.execute(
            select(Passkey).where(Passkey.id == passkey_id, Passkey.user_id == user.id)
        )
    ).scalar_one_or_none()
    if not passkey:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Passkey not found")
    await session.delete(passkey)
    await session.flush()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/login/options")
async def login_options(request: Request, response: Response):
    _enforce_login_rate_limit(request)
    options = generate_authentication_options(
        rp_id=settings.resolved_webauthn_rp_id,
        user_verification=UserVerificationRequirement.REQUIRED,
    )
    _set_challenge_cookie(response, request, "login", options.challenge)
    return json.loads(options_to_json(options))


@router.post("/login/verify")
async def login_verify(
    body: LoginVerifyRequest,
    request: Request,
    response: Response,
    session: AsyncSession = Depends(get_system_db),
):
    _enforce_login_rate_limit(request)
    challenge, _ = _read_challenge(request, "login")

    credential_id = _credential_id_from(body.credential)
    passkey = None
    if credential_id:
        passkey = (
            await session.execute(select(Passkey).where(Passkey.credential_id == credential_id))
        ).scalar_one_or_none()
    if not passkey:
        # Generic error: never reveal whether a credential is registered.
        _clear_challenge_cookie(response)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Passkey sign-in failed")

    try:
        verified = verify_authentication_response(
            credential=body.credential,
            expected_challenge=challenge,
            expected_rp_id=settings.resolved_webauthn_rp_id,
            expected_origin=settings.resolved_webauthn_origins,
            credential_public_key=passkey.public_key,
            credential_current_sign_count=passkey.sign_count,
            require_user_verification=True,
        )
    except Exception as exc:  # noqa: BLE001
        _clear_challenge_cookie(response)
        logger.info("Passkey sign-in failed: %s", type(exc).__name__)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Passkey sign-in failed")

    # Reject a sign-count regression (cloned authenticator) unless the counter is
    # unused (some platform authenticators always report 0).
    if verified.new_sign_count < passkey.sign_count:
        _clear_challenge_cookie(response)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Passkey sign-in failed")
    passkey.sign_count = verified.new_sign_count
    passkey.last_used_at = datetime.now(timezone.utc)

    user = (
        await session.execute(select(User).where(User.id == passkey.user_id))
    ).scalar_one_or_none()
    if not user:
        _clear_challenge_cookie(response)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Passkey sign-in failed")
    # The challenge is single-use: delete it before any further work.
    _clear_challenge_cookie(response)

    nonce = body.desktop_nonce or ""
    if nonce and NONCE_RE.fullmatch(nonce):
        # Desktop: the ceremony ran in the system browser, so cookies set here
        # would not reach the app. Return a one-time code deep link instead; the
        # Electron main process verifies the nonce and loads the exchange URL.
        code = create_app_login_code(user)
        return {"redirect": f"{DESKTOP_DEEP_LINK}?code={code}&nonce={nonce}"}

    await session.flush()
    set_auth_cookies(response, str(user.id), request, user.token_version)
    return {
        "id": str(user.id),
        "email": user.email,
        "display_name": user.display_name,
        "email_verified": user.email_verified,
    }
