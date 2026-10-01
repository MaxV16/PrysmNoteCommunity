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
from app.routers import auth, tasks, tags, search, ai, keys, calendar, task_links, habits, oauth, notifications, teams, notes, preferences, board_sections, imports, watchlist, analytics, lists, passkeys, finance, tokens, events
from app.routers.ai import start_rate_limit_pruner
from app.services.calendar_service import pull_and_import_events
from app.services.recurring_task_service import recurring_task_background_loop
from app.services.notification_service import notification_background_loop
from app.services.analytics import analytics_flush_loop, analytics_rollup_loop

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
        # The backend never serves inline/eval'd scripts (pure JSON API), so
        # production drops both 'unsafe-inline' and 'unsafe-eval' (M5). Dev
        # keeps them for reload tooling.
        script_src = (
            "script-src 'self'; "
            if settings.is_production
            else "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
        )
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            f"{script_src}"
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: https://image.tmdb.org https://www.themoviedb.org; "
            f"connect-src {connect_src}; "
            "frame-ancestors 'none'; "
            "base-uri 'self'; "
            "form-action 'self';"
            + (" upgrade-insecure-requests;" if settings.is_production else " ")
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(self), geolocation=()"
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

_background_tasks: list[asyncio.Task] = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Guarantee the database schema (extensions + baseline tables) exists and is
    # up to date before accepting traffic. Idempotent; never drops data.
    from app.services.schema_provisioning import ensure_schema
    from app.database import engine as _app_engine
    from app.database import system_engine as _system_engine
    from app.services.loop_leader import serialize_schema_provisioning as _serialize_schema

    # Serialize DDL across concurrent uvicorn workers (blocking advisory lock on
    # Postgres; a plain call on SQLite). Whichever worker wins provisions first;
    # the others block briefly and then re-run the idempotent pass.
    async def _provision_core_schema():
        await ensure_schema(_app_engine, _system_engine)

    await _serialize_schema(_app_engine, _provision_core_schema)

    # Every worker registers these in-process hooks regardless of leadership
    # (they gate request handling), so they are intentionally NOT leader-only.
    run_loops = settings.run_background_loops

    # Apply idempotent EE finance schema additions (new columns on existing tables).
    # create_all never alters existing tables, so this ALTER-on-startup converges both
    # fresh and existing databases. Guarded so the community build (which strips the
    # block) stays a safe no-op.

    # Multi-worker leadership. Only ONE worker may run the shared background
    # loops, or they duplicate (double reminder emails, double calendar pulls).
    # Workers elect a single leader via a Postgres advisory lock held for the
    # process lifetime; followers serve HTTP only. On SQLite (tests) or a single
    # worker this is always true. PRYSM_RUN_BACKGROUND_LOOPS=false disables the
    # loops everywhere without a code change (dedicated-worker pattern).
    if run_loops:
        from app.services.loop_leader import try_acquire_background_leadership as _try_lead

        run_loops = await _try_lead(settings.system_database_url or settings.database_url)

    # Warm the FX reference-rate cache off the request path (daily TTL; the
    # pricing endpoint refreshes on demand and fails open to a bundled snapshot).
    # Leader-only so followers do not repeat the external fetch.
    if run_loops:
        try:
            _fx_warm_task = _spawn_warm()
            _background_tasks.append(_fx_warm_task)
        except ImportError:
            pass

    # Start background tasks. These process data across all users (recurring
    # expansion, calendar pull) so they run through the BYPASSRLS system engine.
    # Leader-only under multiple workers (see the leadership note above).
    if run_loops:
        task = asyncio.create_task(recurring_task_background_loop(system_session_factory))
        _background_tasks.append(task)
        _prune_task = start_rate_limit_pruner()
        _background_tasks.append(_prune_task)

        # Notifications engine (email reminders, daily digest, Web Push). The loop
        # itself checks NOTIFICATIONS_ENABLED and is a safe no-op when unset.
        _notif_task = asyncio.create_task(notification_background_loop(system_session_factory))
        _background_tasks.append(_notif_task)

        # First-party analytics: flush the in-memory event queue to the DB and roll
        # raw rows into the forever-kept daily aggregate (plus retention pruning).
        _analytics_flush = asyncio.create_task(analytics_flush_loop(system_session_factory))
        _background_tasks.append(_analytics_flush)
        _analytics_rollup = asyncio.create_task(analytics_rollup_loop(system_session_factory))
        _background_tasks.append(_analytics_rollup)

        # Shows & Movies watchlist: refresh upcoming continuations (next season,
        # next franchise installment) on a 6h cadence. Skips itself when no TMDB
        # key is configured.
        from app.services.watchlist_background import watchlist_background_loop

        _watchlist_task = asyncio.create_task(watchlist_background_loop(system_session_factory))
        _background_tasks.append(_watchlist_task)

        # One-time, best-effort: encrypt any legacy plaintext Google Calendar OAuth
        # tokens at rest (idempotent - already-encrypted rows are skipped).
        try:
            from app.services.calendar_service import backfill_encrypted_tokens

            async with system_session_factory() as _sys_session:
                _converted = await backfill_encrypted_tokens(_sys_session)
        except Exception:
            pass

    async def maintenance_cleanup(session_factory):
        # Hourly maintenance: prune expired token-blacklist rows plus the
        # unbounded-growth premium AI tables (expired response cache, and usage
        # rows past the retention window). Runs through the BYPASSRLS session so
        # every user's rows are covered; each delete is independent so one
        # failure cannot skip the rest.
        from datetime import datetime, timedelta, timezone

        from app.models.ai_cache import AiCache
        from app.models.ai_usage import AiUsage

        while True:
            try:
                async with session_factory() as session:
                    await session.execute(
                        TokenBlacklist.__table__.delete().where(
                            TokenBlacklist.expires_at < func.now()
                        )
                    )
                    try:
                        await session.execute(
                            AiCache.__table__.delete().where(AiCache.expires_at < func.now())
                        )
                    except Exception:
                        pass
                    try:
                        usage_cutoff = datetime.now(timezone.utc) - timedelta(
                            days=settings.ai_usage_retention_days
                        )
                        await session.execute(
                            AiUsage.__table__.delete().where(
                                AiUsage.created_at < usage_cutoff
                            )
                        )
                    except Exception:
                        pass
                    await session.commit()
            except Exception:
                pass
            await asyncio.sleep(3600)

    if run_loops:
        _cleanup_task = asyncio.create_task(maintenance_cleanup(system_session_factory))
        _background_tasks.append(_cleanup_task)

    async def trash_purge_loop(session_factory):
        from app.services.task_service import purge_trash

        while True:
            try:
                async with session_factory() as session:
                    purged = await purge_trash(session)
                    await session.commit()
                    if purged:
                        print(f"[trash] Purged {purged} expired trashed task(s)")
            except Exception:
                pass
            await asyncio.sleep(6 * 3600)  # every 6 hours

    if run_loops:
        _trash_task = asyncio.create_task(trash_purge_loop(system_session_factory))
        _background_tasks.append(_trash_task)

    async def gcal_pull_background_loop(session_factory):
        from datetime import datetime, timezone

        from app.models.user_token import UserToken
        from app.services.calendar_service import (
            _decrypt_token,
            get_user_calendar_ids,
            get_user_calendar_interval,
        )

        while True:
            # List the tokens to pull in one short session (never held open
            # during network calls), then run each user's pull as its own task
            # with its own session, bounded by a semaphore so N external calls
            # overlap at most `gcal_pull_concurrency` at a time.
            due_tokens = []
            try:
                async with session_factory() as session:
                    result = await session.execute(
                        select(UserToken).where(UserToken.provider == "google_calendar")
                    )
                    tokens = result.scalars().all()
                    now = datetime.now(timezone.utc)
                    for token in tokens:
                        last_pulled = token.last_pulled_at
                        if last_pulled is not None and last_pulled.tzinfo is None:
                            # SQLite returns naive datetimes for TIMESTAMPTZ; treat as UTC.
                            last_pulled = last_pulled.replace(tzinfo=timezone.utc)
                        # Each user may choose their own interval (the value is
                        # clamped server-side to a 15 min floor); absent, the
                        # global default applies. One tiny indexed read per user.
                        try:
                            interval = await get_user_calendar_interval(session, token.user_id)
                        except Exception:
                            interval = settings.gcal_pull_interval
                        if last_pulled is None or (now - last_pulled).total_seconds() >= interval:
                            due_tokens.append(token.user_id)
            except Exception:
                pass

            semaphore = asyncio.Semaphore(settings.gcal_pull_concurrency)

            async def _pull_user(user_id):
                async with semaphore:
                    try:
                        async with session_factory() as user_session:
                            result = await user_session.execute(
                                select(UserToken).where(
                                    UserToken.user_id == user_id,
                                    UserToken.provider == "google_calendar",
                                )
                            )
                            token = result.scalar_one_or_none()
                            if token is None:
                                return
                            calendar_ids = await get_user_calendar_ids(user_session, user_id)
                            await pull_and_import_events(
                                user_session,
                                user_id,
                                _decrypt_token(token.access_token),
                                _decrypt_token(token.refresh_token or "") or "",
                                calendar_ids=calendar_ids,
                            )
                            # pull_and_import_events commits/rolls back its own
                            # transaction; stamp the pull time so the interval
                            # guard (and the manual-endpoint rate guard) sees it.
                            token.last_pulled_at = datetime.now(timezone.utc)
                            await user_session.commit()
                    except Exception:
                        pass

            if due_tokens:
                await asyncio.gather(*(_pull_user(uid) for uid in due_tokens))
            await asyncio.sleep(settings.gcal_pull_interval)

    if run_loops:
        gcal_task = asyncio.create_task(gcal_pull_background_loop(system_session_factory))
        _background_tasks.append(gcal_task)





    # Mount the MCP server (Streamable HTTP) and keep its session manager alive
    # as a background task. The endpoint stays under /api/* so the Next.js
    # rewrite proxies it; /api/mcp is CSRF-exempt in csrf.py because MCP clients
    # authenticate with a Bearer PAT, not cookies. In the community build there
    # is no entitlement provider, so MCP is free; the private build gates it and
    # registers its extra tools via the EE marker block below.
    from app.services.mcp_server import get_mcp_http_app, mcp_session_loop

    app.mount("/api/mcp", get_mcp_http_app())
    _mcp_task = asyncio.create_task(mcp_session_loop())
    _background_tasks.append(_mcp_task)


    yield
    # Cancel background tasks on shutdown
    for t in _background_tasks:
        t.cancel()
    # Release the advisory lock so a recycled worker hands leadership over
    # immediately instead of waiting for the connection to drop.
    from app.services.loop_leader import release_background_leadership as _release_lead

    await _release_lead()


app = FastAPI(
    title="Prysm Note API",
    version="0.1.0",
    lifespan=lifespan,
    # Do not expose Swagger/OpenAPI schema to the public in production.
    docs_url="/docs" if not settings.is_production else None,
    redoc_url="/redoc" if not settings.is_production else None,
    openapi_url="/openapi.json" if not settings.is_production else None,
)


@app.exception_handler(ValueError)
async def _value_error_handler(request: Request, exc: ValueError):
    """Surface domain validation errors (task date/time ordering, foreign-list
    assignment) raised by the service layer as 422s, matching the Pydantic
    validation responses, instead of unhandled 500s."""
    return JSONResponse(status_code=422, content={"detail": str(exc)})

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
from app.middleware.events import EventPublishMiddleware

app.add_middleware(APIRateLimitMiddleware)
app.add_middleware(CSRFSecurityMiddleware)
# Publishes a lightweight per-user change event after successful task/tag/list/
# section mutations so connected clients can refetch instantly over SSE.
app.add_middleware(EventPublishMiddleware)

app.include_router(auth.router)
app.include_router(passkeys.router)
app.include_router(oauth.router)
app.include_router(oauth.mobile_router)
app.include_router(tasks.router)
app.include_router(tags.router)
app.include_router(search.router)
app.include_router(ai.router)
app.include_router(keys.router)
app.include_router(calendar.router)
app.include_router(task_links.router)
app.include_router(habits.router)
app.include_router(notifications.router)
app.include_router(teams.router)
app.include_router(notes.router)
app.include_router(preferences.router)
app.include_router(board_sections.router)
app.include_router(imports.router)
app.include_router(watchlist.router)
app.include_router(analytics.router)
app.include_router(lists.router)
app.include_router(finance.router)
app.include_router(tokens.router)
app.include_router(events.router)


@app.get("/api/health")
async def health_check():
    return {"status": "ok", "version": settings.git_sha or None}