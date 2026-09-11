"""Generous per-IP rate limit for /api routes (global safety net).

Distinct from the targeted auth (failed-login blocklist) and AI (per-user)
limiters: this catches brute-force floods and runaway scrapers across the whole
API. Fail-open: when Redis is unavailable the RateLimiter falls back to an
in-memory dict, and when Redis is unreachable entirely the limit is skipped.

Client IP comes from ``_client_ip``, which prefers Cloudflare's CF-Connecting-IP,
then X-Forwarded-For, then ``request.client.host`` - so all users behind the
Cloudflare Tunnel do not share a single tunnel IP.
"""
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.config import settings
from app.middleware.csrf import CSRF_SAFE_PATHS
from app.utils.client_ip import _client_ip
from app.utils.ratelimit import RateLimiter

_api_limiter = RateLimiter("rl:api")


class APIRateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if not settings.api_rate_limit_enabled:
            return await call_next(request)

        path = request.url.path
        # Only /api traffic; the auth endpoints are already rate-limited at a
        # finer grain by auth.py (and /health must never be throttled).
        if not path.startswith("/api/") or path in CSRF_SAFE_PATHS or request.method in {"OPTIONS", "HEAD"}:
            return await call_next(request)

        ip = _client_ip(request)
        count = _api_limiter.count(f"ip:{ip}", 60)
        if count > settings.api_rate_limit_per_min:
            return JSONResponse(status_code=429, content={"detail": "Too many requests"})

        return await call_next(request)
