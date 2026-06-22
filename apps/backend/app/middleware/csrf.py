import secrets
import hmac
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
CSRF_COOKIE_NAME = "csrf_token"
CSRF_HEADER_NAME = "X-CSRF-Token"
CSRF_SAFE_PATHS = {"/api/auth/login", "/api/auth/register", "/api/auth/refresh", "/api/auth/logout", "/api/health"}

class CSRFSecurityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path in CSRF_SAFE_PATHS:
            return await call_next(request)

        if request.method in SAFE_METHODS:
            response = await call_next(request)
            csrf_token = request.cookies.get(CSRF_COOKIE_NAME)
            if not csrf_token:
                csrf_token = secrets.token_hex(32)
                response.set_cookie(
                    key=CSRF_COOKIE_NAME,
                    value=csrf_token,
                    httponly=False,
                    secure=True,
                    samesite="lax",
                    path="/",
                    max_age=86400,
                )
            return response

        csrf_cookie = request.cookies.get(CSRF_COOKIE_NAME)
        csrf_header = request.headers.get(CSRF_HEADER_NAME)

        if not csrf_cookie or not csrf_header:
            return JSONResponse(status_code=403, content={"detail": "CSRF token missing"})

        if not hmac.compare_digest(csrf_cookie, csrf_header):
            return JSONResponse(status_code=403, content={"detail": "CSRF token mismatch"})

        return await call_next(request)
