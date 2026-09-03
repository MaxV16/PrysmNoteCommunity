"""First-party product analytics endpoint (core).

POST /api/analytics/track accepts a client-side event, validates it and enqueues
it for the background flush loop. The request path only touches an in-memory
queue - it never waits on the database, so tracking costs nothing on the hot
path. CSRF applies (the frontend beacon sends the header); the endpoint is NOT
csrf-exempt.
"""
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field

from app.dependencies import get_current_user
from app.models.user import User
from app.services import analytics
from app.utils.ratelimit import RateLimiter

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/analytics", tags=["analytics"])

MAX_EVENT_LENGTH = 64
MAX_PROPERTIES_BYTES = 4096
_TRACK_LIMIT = 60
_TRACK_WINDOW = 60  # seconds
_track_limiter = RateLimiter("rl:analytics")


class TrackRequest(BaseModel):
    event: str = Field(default="", max_length=MAX_EVENT_LENGTH)
    properties: dict[str, Any] = Field(default_factory=dict)
    session_id: str | None = Field(default=None, max_length=64)


@router.post("/track", status_code=status.HTTP_204_NO_CONTENT)
async def track(
    body: TrackRequest,
    user: User = Depends(get_current_user),
):
    event = body.event.strip()
    if not event:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="event must be a non-empty string",
        )
    try:
        if len(json.dumps(body.properties).encode("utf-8")) > MAX_PROPERTIES_BYTES:
            raise ValueError()
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"properties must be a JSON object of at most {MAX_PROPERTIES_BYTES} bytes",
        )

    if not _track_limiter.count(str(user.id), _TRACK_WINDOW) <= _TRACK_LIMIT:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many analytics events - slow down",
        )

    analytics.enqueue_event(
        str(user.id),
        event,
        body.properties,
        (body.session_id or "")[:64] or None,
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
