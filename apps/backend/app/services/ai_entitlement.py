"""AI entitlement + token usage accounting (core).

Determines how a user's AI is served and enforces the hosted (PrysmAI) token
allowance. The community build has no hosted AI: ``get_ai_mode`` returns BYOK
(unlimited) unless the EE build registers an entitlement hook (which reads the
subscription plan/trial allowance and the monthly ``ai_usage`` sum).
"""
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_usage import AiUsage

_MODE_CHECK = None
_BYOK_GATE = None


def register_ai_entitlement(check) -> None:
    """EE hook: ``async (user_id, session) -> {"mode", "allowance", "used"}``.

    ``mode`` is "prysmai" (hosted, allowance-capped), "byok" (user's key,
    unlimited) or "none" (no hosted AI - e.g. free tier without a trial).
    """
    global _MODE_CHECK
    _MODE_CHECK = check


def register_byok_gate(check) -> None:
    """EE hook: ``async (user_id, session) -> bool`` (True = BYOK allowed).

    In the hosted build bring-your-own-key AI is a paid-plan feature (active
    subscription), so the EE build registers a gate that rejects free/trial
    users. The community build has no premium tier - no gate is registered and
    BYOK stays open to everyone.
    """
    global _BYOK_GATE
    _BYOK_GATE = check


def has_entitlement_check() -> bool:
    return _MODE_CHECK is not None


def has_byok_gate() -> bool:
    return _BYOK_GATE is not None


async def byok_allowed(user_id, session: AsyncSession) -> bool:
    """Whether the user may use the in-app AI agent with their own API key."""
    if _BYOK_GATE is None:
        # Community build: BYOK only, unlimited, no premium tier to gate on.
        return True
    return bool(await _BYOK_GATE(str(user_id), session))


async def get_ai_mode(user_id, session: AsyncSession) -> dict:
    if _MODE_CHECK is None:
        # Community build: BYOK only, unlimited.
        return {"mode": "byok", "allowance": 0, "used": 0}
    return await _MODE_CHECK(str(user_id), session)


async def check_ai_allowance(user_id, session: AsyncSession) -> dict:
    """Resolve the user's AI entitlement + whether a hosted call is allowed."""
    ent = await get_ai_mode(user_id, session)
    if ent.get("mode") != "prysmai":
        return {**ent, "remaining": None, "blocked": False}
    remaining = ent.get("allowance", 0) - ent.get("used", 0)
    return {**ent, "remaining": max(remaining, 0), "blocked": remaining <= 0}


def _current_month() -> object:
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    return datetime(now.year, now.month, 1, tzinfo=timezone.utc)


async def monthly_usage(session: AsyncSession, user_id, provider: str) -> int:
    """Sum a user's tokens (input + output + cached) for the current calendar month."""
    result = await session.execute(
        select(func.coalesce(
            func.sum(AiUsage.input_tokens + AiUsage.output_tokens + AiUsage.cached_input_tokens), 0
        )).where(
            AiUsage.user_id == user_id,
            AiUsage.provider == provider,
            AiUsage.month >= _current_month(),
        )
    )
    return int(result.scalar() or 0)


async def record_ai_usage(
    session: AsyncSession,
    user_id,
    provider: str,
    input_tokens: int,
    output_tokens: int,
    cached_input_tokens: int = 0,
) -> None:
    """Append a usage row for a provider call. Flushed, committed by the caller."""
    session.add(
        AiUsage(
            user_id=user_id,
            provider=provider,
            month=_current_month(),
            input_tokens=int(input_tokens or 0),
            output_tokens=int(output_tokens or 0),
            cached_input_tokens=int(cached_input_tokens or 0),
        )
    )


def parse_usage(response: dict) -> dict:
    """Extract ``{input, output, cached_input}`` from an OpenAI-style response."""
    usage = response.get("usage") or {}
    prompt_tokens = usage.get("prompt_tokens") or 0
    completion_tokens = usage.get("completion_tokens") or 0
    details = usage.get("prompt_tokens_details") or {}
    cached = details.get("cached_tokens") or 0
    return {"input": prompt_tokens, "output": completion_tokens, "cached_input": cached}


def is_uuid_like(value) -> bool:
    try:
        UUID(str(value))
        return True
    except (ValueError, TypeError, AttributeError):
        return False
