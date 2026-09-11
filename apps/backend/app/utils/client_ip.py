"""Real-client-IP detection for rate limiting.

Behind Cloudflare Tunnel every request's ``request.client.host`` is the tunnel
IP (all users share it), which defeats per-IP limits. Prefer the trusted
proxied headers that Cloudflare sets:

1. ``CF-Connecting-IP`` (Cloudflare sets this from the real client; validate it
   parses as an IP so a spoofed value is ignored).
2. ``X-Forwarded-For`` first entry (the original client, appended by proxies).
3. Fall back to ``request.client.host``.
"""
from ipaddress import ip_address as _ip_address

from starlette.requests import Request


def _client_ip(request: Request) -> str:
    """Best-effort real client IP for rate limiting. Never raises."""
    cf_ip = request.headers.get("CF-Connecting-IP")
    if cf_ip:
        try:
            _ip_address(cf_ip.strip())
            return cf_ip.strip()
        except ValueError:
            pass
    xff = request.headers.get("X-Forwarded-For")
    if xff:
        first = xff.split(",")[0].strip()
        try:
            _ip_address(first)
            return first
        except ValueError:
            pass
    if request.client:
        return request.client.host
    return "unknown"