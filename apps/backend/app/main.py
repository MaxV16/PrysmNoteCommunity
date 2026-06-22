import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.config import settings
from app.database import async_session_factory
from app.middleware.csrf import CSRFSecurityMiddleware
from app.models.user_token import UserToken
from app.routers import auth, tasks, projects, tags, search, ai, keys, calendar, task_links
from app.routers.ai import start_rate_limit_pruner
from app.services.calendar_service import pull_and_import_events
from app.services.recurring_task_service import recurring_task_background_loop

MAX_BODY_SIZE = 10 * 1024 * 1024  # 10MB


class BodySizeLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        content_length = request.headers.get("content-length")
        if content_length and int(content_length) > MAX_BODY_SIZE:
            return JSONResponse(status_code=413, content={"detail": "Request body too large"})
        return await call_next(request)


class CSPSecurityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; "
            "connect-src 'self' http://localhost:* ws://localhost:*; "
            "frame-ancestors 'none'; "
            "base-uri 'self'; "
            "form-action 'self';"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        return response

_background_tasks: list[asyncio.Task] = []


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start background tasks
    task = asyncio.create_task(recurring_task_background_loop(async_session_factory))
    _background_tasks.append(task)
    _prune_task = start_rate_limit_pruner()
    _background_tasks.append(_prune_task)

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
                            await pull_and_import_events(
                                session, token.user_id, token.access_token, token.refresh_token or ""
                            )
                        except Exception:
                            pass
            except Exception:
                pass
            await asyncio.sleep(300)

    gcal_task = asyncio.create_task(gcal_pull_background_loop(async_session_factory))
    _background_tasks.append(gcal_task)
    yield
    # Cancel background tasks on shutdown
    for t in _background_tasks:
        t.cancel()


app = FastAPI(
    title="Prysm Note API",
    version="0.1.0",
    lifespan=lifespan,
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
app.add_middleware(CSRFSecurityMiddleware)

app.include_router(auth.router)
app.include_router(tasks.router)
app.include_router(projects.router)
app.include_router(tags.router)
app.include_router(search.router)
app.include_router(ai.router)
app.include_router(keys.router)
app.include_router(calendar.router)
app.include_router(task_links.router)


@app.get("/api/health")
async def health_check():
    return {"status": "ok"}