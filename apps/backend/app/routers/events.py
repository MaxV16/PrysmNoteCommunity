"""Server-Sent Events stream (Phase B).

``GET /api/events`` pushes a lightweight ``change`` event whenever the user's
tasks/tags/lists/board-sections mutate, so open clients can refetch only what
changed instead of polling on a timer. Auth is cookie/Bearer via
``get_current_user_id``, which does NOT hold a DB session open for the life of
the stream.
"""
import asyncio
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from app.dependencies import get_current_user_id
from app.services.events import subscribe_user_events

router = APIRouter(prefix="/api/events", tags=["events"])

HEARTBEAT_SECONDS = 15


@router.get("")
async def stream_events(
    request: Request,
    user_id: UUID = Depends(get_current_user_id),
):
    async def event_stream():
        # Tell EventSource to hold off reconnecting aggressively.
        yield "retry: 5000\n\n"
        yield ": connected\n\n"
        try:
            async for payload in subscribe_user_events(user_id):
                if payload is None:
                    yield ": ping\n\n"  # keep-alive comment
                else:
                    yield f"event: change\ndata: {payload}\n\n"
        except asyncio.CancelledError:
            raise

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
