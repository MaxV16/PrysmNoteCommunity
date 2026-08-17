import asyncio
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.config import settings
from app.database import async_session_factory, system_session_factory
from app.models.token_blacklist import TokenBlacklist
from app.models.user_token import UserToken
from app.routers import auth, tasks, tags, search, ai, keys, calendar, task_links, habits, oauth
from app.routers.ai import start_rate_limit_pruner
from app.services.calendar_service import pull_and_import_events
from app.services.recurring_task_service import recurring_task_background_loop

_repo_root = Path(__file__).resolve().parent.parent.parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

MAX_BODY_SIZE = 10 * 1024 * 1024  # 10MB


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                size = int(content_length)
            except ValueError:
                # Malformed content-length: reject rather than crash with a 500.
                return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})
            if size > MAX_BODY_SIZE:
                return JSONResponse(status_code=413, content={"detail": "Request body too large"})
        return await call_next(request)


class CSPSecurityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        # In production the backend is reached same-origin/configured-origin, so
        # connect-src should NOT include localhost (removes a post-XSS pivot to
        # local services). Dev keeps localhost for the hot-reload backend.
        connect_src = (
            "'self'"
            if settings.is_production
            else "'self' http://localhost:* ws://localhost:*"
        )
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; "
            f"connect-src {connect_src}; "
            "frame-ancestors 'none'; "
            "base-uri 'self'; "
            "form-action 'self';"
            + (" upgrade-insecure-requests;" if settings.is_production else " ")
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

_background_tasks: list[asyncio.Task] = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Guarantee the database schema (extensions + baseline tables) exists and is
    # up to date before accepting traffic. Idempotent; never drops data.
    from app.services.schema_provisioning import ensure_schema
    from app.database import engine as _app_engine
    await ensure_schema(_app_engine)

    # Apply idempotent EE finance schema additions (new columns on existing tables).
    # create_all never alters existing tables, so this ALTER-on-startup converges both
    # fresh and existing databases. Guarded so the community build (which strips the
    # block) stays a safe no-op.

    # Start background tasks. These process data across all users (recurring
    # expansion, calendar pull) so they run through the BYPASSRLS system engine.
    task = asyncio.create_task(recurring_task_background_loop(system_session_factory))
    _background_tasks.append(task)
    _prune_task = start_rate_limit_pruner()
    _background_tasks.append(_prune_task)

    # One-time, best-effort: encrypt any legacy plaintext Google Calendar OAuth
    # tokens at rest (idempotent — already-encrypted rows are skipped).
    try:
        from app.services.calendar_service import backfill_encrypted_tokens

        async with system_session_factory() as _sys_session:
            _converted = await backfill_encrypted_tokens(_sys_session)
    except Exception:
        pass

    async def blacklist_cleanup(session_factory):
        while True:
            try:
                async with session_factory() as session:
                    await session.execute(
                        TokenBlacklist.__table__.delete().where(
                            TokenBlacklist.expires_at < func.now()
                        )
                    )
                    await session.commit()
            except Exception:
                pass
            await asyncio.sleep(3600)

    _cleanup_task = asyncio.create_task(blacklist_cleanup(system_session_factory))
    _background_tasks.append(_cleanup_task)

    async def gcal_pull_background_loop(session_factory):
        while True:
            try:
                async with session_factory() as session:
                    result = await session.execute(
                        select(UserToken).where(UserToken.provider == "google_calendar")
                    )
                    tokens = result.scalars().all()
                    for token in tokens:
                        try:
                            from app.services.calendar_service import _decrypt_token

                            await pull_and_import_events(
                                session,
                                token.user_id,
                                _decrypt_token(token.access_token),
                                _decrypt_token(token.refresh_token or "") or "",
                            )
                        except Exception:
                            pass
            except Exception:
                pass
            await asyncio.sleep(300)

    gcal_task = asyncio.create_task(gcal_pull_background_loop(system_session_factory))
    _background_tasks.append(gcal_task)
    yield
    # Cancel background tasks on shutdown
    for t in _background_tasks:
        t.cancel()


app = FastAPI(
    title="Prysm Note API",
    version="0.1.0",
    lifespan=lifespan,
    # Do not expose Swagger/OpenAPI schema to the public in production.
    docs_url="/docs" if not settings.is_production else None,
    redoc_url="/redoc" if not settings.is_production else None,
    openapi_url="/openapi.json" if not settings.is_production else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins.split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_middleware(BodySizeLimitMiddleware)
app.add_middleware(CSPSecurityMiddleware)
# CSRF runs outermost (last-added = outermost in Starlette) so the cookie is set
# on every safe request and unsafe requests are rejected before they reach any
# route. Auth endpoints (login/register/refresh/logout) and /api/health are
# exempt by the middleware; the frontend sends X-CSRF-Token everywhere else.
from app.middleware.csrf import CSRFSecurityMiddleware
from app.middleware.ratelimit import APIRateLimitMiddleware

app.add_middleware(APIRateLimitMiddleware)
app.add_middleware(CSRFSecurityMiddleware)

app.include_router(auth.router)
app.include_router(oauth.router)
app.include_router(tasks.router)
app.include_router(tags.router)
app.include_router(search.router)
app.include_router(ai.router)
app.include_router(keys.router)
app.include_router(calendar.router)
app.include_router(task_links.router)
app.include_router(habits.router)


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "version": settings.git_sha or None}