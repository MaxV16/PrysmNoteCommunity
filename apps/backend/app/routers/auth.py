from datetime import datetime, timezone
import re
import time
from uuid import UUID, uuid4

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from fastapi.security import HTTPAuthorizationCredentials


def _cookie_secure(request: Request) -> bool:
    # Only honor the TLS-terminating proxy's X-Forwarded-Proto in production,
    # where the proxy is a trusted hop. In development the header is
    # client-controlled, so a Secure cookie is set only on a real https scheme.
    if request.url.scheme == "https":
        return True
    if not settings.is_production:
        return False
    forwarded_proto = (request.headers.get("X-Forwarded-Proto") or "").lower()
    return "https" in forwarded_proto
from jose import JWTError, jwt
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.dependencies import get_current_user, security_optional
from app.models.token_blacklist import TokenBlacklist
from app.models.user import User
from app.services.auth_service import (
    create_access_token,
    create_refresh_token,
    create_user,
    get_user_by_email,
    hash_password,
    verify_password,
)
from app.utils.ratelimit import RateLimiter, _get_redis

# Precomputed at startup: a real bcrypt hash used when verifying a login for a
# non-existent account so response timing doesn't reveal whether an email is
# registered.
DUMMY_PASSWORD_HASH = hash_password("__prysm_dummy_login__")

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Redis-backed limiter (rl:auth:* keys). When Redis is unavailable the limiter
# falls back to the in-memory dicts below, which tests also exercise directly.
_auth_limiter = RateLimiter("rl:auth")

# Time-based IP blocklist: IP -> unix timestamp when the block expires.
# Entries auto-expire so a legitimate user (shared/NAT IP, or a typo'd password)
# is never permanently locked out until a server restart. Pruned lazily on read.
_IP_BLOCKLIST: dict[str, float] = {}
_BLOCK_DURATION = 15 * 60  # seconds an IP stays blocked after 10 failed logins


def _is_blocked(ip: str) -> bool:
    if _get_redis() is not None:
        return _auth_limiter.is_blocked(f"authblock:{ip}")
    if ip not in _IP_BLOCKLIST:
        return False
    if time.time() >= _IP_BLOCKLIST[ip]:
        del _IP_BLOCKLIST[ip]
        return False
    return True


def _prune_blocklist() -> None:
    now = time.time()
    expired = [ip for ip, exp in _IP_BLOCKLIST.items() if now >= exp]
    for ip in expired:
        del _IP_BLOCKLIST[ip]

class RegisterRequest(BaseModel):
    email: str
    password: str
    display_name: str | None = None

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        if not re.match(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$", v):
            raise ValueError("Invalid email format")
        return v.lower().strip()

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        # bcrypt only uses the first 72 bytes; longer inputs are silently
        # truncated, so two distinct long passwords would hash identically.
        if len(v.encode("utf-8")) > 72:
            raise ValueError("Password must be at most 72 bytes")
        return v

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, v: str | None) -> str | None:
        if v is not None:
            v = v.strip()
            if len(v) > 100:
                raise ValueError("Display name must be at most 100 characters")
        return v


class LoginRequest(BaseModel):
    email: str
    password: str

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        return v.lower().strip()


class AuthResponse(BaseModel):
    access_token: str
    refresh_token: str
    user: dict


class RefreshRequest(BaseModel):
    refresh_token: str | None = None


@router.post("/register")
async def register(request: RegisterRequest, response: Response, req: Request, session: AsyncSession = Depends(get_db)):
    secure = _cookie_secure(req)
    ip = _get_client_ip(req)
    if _is_blocked(ip):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="IP blocked")

    existing = await get_user_by_email(session, request.email)
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")
    user = await create_user(session, request.email, request.password, request.display_name)
    access_token = create_access_token(str(user.id), user.token_version)
    refresh_token = create_refresh_token(str(user.id), user.token_version)
    response.set_cookie(
        key="access_token", value=access_token,
        httponly=True, secure=secure, samesite="lax", max_age=15 * 60, path="/"
    )
    response.set_cookie(
        key="refresh_token", value=refresh_token,
        httponly=True, secure=secure, samesite="lax", max_age=7 * 24 * 60 * 60, path="/"
    )
    return {"id": str(user.id), "email": user.email, "display_name": user.display_name}


@router.post("/login")
async def login(request: LoginRequest, response: Response, req: Request, session: AsyncSession = Depends(get_db)):
    secure = _cookie_secure(req)
    ip = _get_client_ip(req)
    if _is_blocked(ip):
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="IP blocked")

    user = await get_user_by_email(session, request.email)
    # Always run bcrypt so the timing cost is identical for existing and
    # non-existent emails (prevents account enumeration via response time).
    # A fixed dummy hash is used when the account doesn't exist.
    if user and user.password_hash:
        password_ok = verify_password(request.password, user.password_hash)
    else:
        password_ok = False
        verify_password(request.password, DUMMY_PASSWORD_HASH)
    if not user or not password_ok:
        _track_failed_login(ip)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    access_token = create_access_token(str(user.id), user.token_version)
    refresh_token = create_refresh_token(str(user.id), user.token_version)
    response.set_cookie(
        key="access_token", value=access_token,
        httponly=True, secure=secure, samesite="lax", max_age=15 * 60, path="/"
    )
    response.set_cookie(
        key="refresh_token", value=refresh_token,
        httponly=True, secure=secure, samesite="lax", max_age=7 * 24 * 60 * 60, path="/"
    )
    return {"id": str(user.id), "email": user.email, "display_name": user.display_name}


@router.post("/refresh")
async def refresh(
    response: Response,
    request: RefreshRequest | None = None,
    refresh_token: str | None = Cookie(None),
    req: Request = None,
    session: AsyncSession = Depends(get_db),
):
    token = refresh_token or (request.refresh_token if request else None)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token required")
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        if payload.get("type") != "refresh":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token type")
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    jti = payload.get("jti")
    if jti:
        result = await session.execute(
            select(TokenBlacklist).where(TokenBlacklist.jti == jti)
        )
        if result.scalar_one_or_none():
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token revoked")

    result = await session.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    # Password reset bumps token_version; a pre-reset refresh token no longer works.
    if payload.get("tv", 0) != user.token_version:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token revoked")

    # Refresh-token rotation: revoke the presented refresh token so a stolen
    # token can't be replayed to mint new sessions. (The old jti is blacklisted
    # before new cookies are set.)
    if jti:
        exp = payload.get("exp")
        expires_at = datetime.fromtimestamp(exp, tz=timezone.utc) if exp else None
        entry = TokenBlacklist(
            jti=jti,
            user_id=UUID(user_id),
            expires_at=expires_at,
        )
        session.add(entry)
        await session.flush()

    secure = _cookie_secure(req)
    access_token = create_access_token(str(user.id), user.token_version)
    refresh_token = create_refresh_token(str(user.id), user.token_version)
    response.set_cookie(
        key="access_token", value=access_token,
        httponly=True, secure=secure, samesite="lax", max_age=15 * 60, path="/"
    )
    response.set_cookie(
        key="refresh_token", value=refresh_token,
        httponly=True, secure=secure, samesite="lax", max_age=7 * 24 * 60 * 60, path="/"
    )
    return {"id": str(user.id), "email": user.email, "display_name": user.display_name}


@router.post("/logout")
async def logout(
    response: Response,
    refresh_token: str | None = Cookie(None),
    session: AsyncSession = Depends(get_db),
    credentials: HTTPAuthorizationCredentials | None = Depends(security_optional),
):
    tokens = {}
    if refresh_token:
        tokens["refresh"] = refresh_token
    if credentials and credentials.credentials:
        tokens["access"] = credentials.credentials
    for _type, token in tokens.items():
        try:
            payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
            jti = payload.get("jti")
            exp = payload.get("exp")
            user_id = payload.get("sub")
            if jti and exp and user_id:
                expires_at = datetime.fromtimestamp(exp, tz=timezone.utc)
                exists = await session.execute(
                    select(TokenBlacklist).where(TokenBlacklist.jti == jti)
                )
                if not exists.scalar_one_or_none():
                    entry = TokenBlacklist(
                        jti=jti,
                        user_id=UUID(user_id),
                        expires_at=expires_at,
                    )
                    session.add(entry)
        except (JWTError, Exception):
            pass
    await session.flush()
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")
    return {"status": "logged_out"}


@router.delete("/me")
async def delete_account(
    response: Response,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    # Delete orphaned blacklist rows for this user before the cascade removes the
    # user, so no dangling token_blacklist references remain.
    from sqlalchemy import delete as sa_delete
    await session.execute(
        sa_delete(TokenBlacklist).where(TokenBlacklist.user_id == user.id)
    )
    await session.delete(user)
    await session.flush()
    response.delete_cookie("access_token", path="/")
    response.delete_cookie("refresh_token", path="/")
    return {"status": "deleted"}


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def validate_new_password(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if len(v.encode("utf-8")) > 72:
            raise ValueError("Password must be at most 72 bytes")
        return v


@router.post("/change-password")
async def change_password(
    request: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    if not user.password_hash or not verify_password(request.current_password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Current password is incorrect")
    from app.services.auth_service import hash_password
    user.password_hash = hash_password(request.new_password)
    await session.flush()
    return {"status": "password_updated"}


class ForgotPasswordRequest(BaseModel):
    email: str

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str) -> str:
        return v.lower().strip()


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def validate_new_password(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        if len(v.encode("utf-8")) > 72:
            raise ValueError("Password must be at most 72 bytes")
        return v


@router.post("/forgot-password")
async def forgot_password(
    request: ForgotPasswordRequest,
    session: AsyncSession = Depends(get_db),
):
    """Send a password-reset email if the account exists. Always returns the
    same response so the endpoint cannot be used to enumerate accounts."""
    import asyncio
    from datetime import timedelta

    from app.services.email import send_email

    user = await get_user_by_email(session, request.email)
    if not user or not user.password_hash:
        return {"status": "sent"}

    expires = datetime.now(timezone.utc) + timedelta(minutes=30)
    token = jwt.encode(
        {"sub": str(user.id), "exp": expires, "type": "reset", "jti": str(uuid4())},
        settings.jwt_secret_key,
        algorithm=settings.jwt_algorithm,
    )
    reset_url = f"{settings.app_origin}/reset-password?token={token}"
    body = (
        "We received a request to reset the password for your Prysm Note account.\n\n"
        f"Open the link below to choose a new password (valid for 30 minutes):\n\n"
        f"{reset_url}\n\n"
        "If you didn't request this, you can safely ignore this email — your password won't change."
    )
    asyncio.create_task(asyncio.to_thread(send_email, user.email, "[Prysm Note] Reset your password", body))
    return {"status": "sent"}


@router.post("/reset-password")
async def reset_password(
    request: ResetPasswordRequest,
    session: AsyncSession = Depends(get_db),
):
    """Verify a reset token, set a new password, and invalidate all prior sessions."""
    try:
        payload = jwt.decode(request.token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
        if payload.get("type") != "reset":
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired token")
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired token")
    except (JWTError, Exception):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired token")

    jti = payload.get("jti")
    if jti:
        result = await session.execute(
            select(TokenBlacklist).where(TokenBlacklist.jti == jti)
        )
        if result.scalar_one_or_none():
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired token")

    result = await session.execute(select(User).where(User.id == UUID(user_id)))
    user = result.scalar_one_or_none()
    if not user or not user.password_hash:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired token")

    # One-time use: blacklist the reset token's jti.
    exp = payload.get("exp")
    expires_at = datetime.fromtimestamp(exp, tz=timezone.utc) if exp else datetime.now(timezone.utc)
    session.add(TokenBlacklist(jti=jti, user_id=user.id, expires_at=expires_at))

    from app.services.auth_service import hash_password

    user.password_hash = hash_password(request.new_password)
    # Invalidate every outstanding access/refresh token for this account.
    user.token_version += 1
    await session.flush()
    return {"status": "password_reset"}


@router.get("/me")
async def get_me(user: User = Depends(get_current_user)):
    return {
        "id": str(user.id),
        "email": user.email,
        "display_name": user.display_name,
        "created_at": user.created_at.isoformat(),
    }


class UpdateMeRequest(BaseModel):
    display_name: str | None = None
    email: str | None = None

    @field_validator("email")
    @classmethod
    def validate_email(cls, v: str | None) -> str | None:
        if v is not None:
            if not re.match(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$", v):
                raise ValueError("Invalid email format")
            return v.lower().strip()
        return v

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, v: str | None) -> str | None:
        if v is not None:
            v = v.strip()
            if len(v) > 100:
                raise ValueError("Display name must be at most 100 characters")
        return v


@router.patch("/me")
async def update_me(
    request: UpdateMeRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    if request.email is not None:
        existing = await get_user_by_email(session, request.email)
        if existing and str(existing.id) != str(user.id):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already in use")
        user.email = request.email
    if request.display_name is not None:
        user.display_name = request.display_name
    await session.flush()
    return {
        "id": str(user.id),
        "email": user.email,
        "display_name": user.display_name,
        "created_at": user.created_at.isoformat(),
    }


def _get_client_ip(req: Request) -> str:
    # Do NOT trust the raw X-Forwarded-For header here: it is client-controlled
    # when the app is reachable directly, letting an attacker spoof an arbitrary
    # IP to bypass rate limiting or poison the blocklist. With uvicorn
    # `--proxy-headers`, request.client.host is already the trusted proxy-derived
    # real client IP (only populated from forwarded headers when the immediate
    # peer is a trusted proxy). Falling back to the peer IP is conservative and
    # cannot be spoofed from a direct connection.
    return req.client.host if req.client else "unknown"


_FAILED_LOGINS: dict[str, list[float]] = {}

def _track_failed_login(ip: str) -> None:
    if _get_redis() is not None:
        count = _auth_limiter.count(f"authfail:{ip}", 300)
        if count >= 10:
            _auth_limiter.block(f"authblock:{ip}", _BLOCK_DURATION)
        return
    now = time.time()
    if ip not in _FAILED_LOGINS:
        _FAILED_LOGINS[ip] = []
    _FAILED_LOGINS[ip] = [t for t in _FAILED_LOGINS[ip] if now - t < 300]
    _FAILED_LOGINS[ip].append(now)
    if len(_FAILED_LOGINS[ip]) >= 10:
        _IP_BLOCKLIST[ip] = now + _BLOCK_DURATION
        _FAILED_LOGINS[ip] = []
        _prune_blocklist()