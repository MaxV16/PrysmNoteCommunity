import asyncio
import json
import os
import re
from uuid import uuid4
import time

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import async_session_factory, get_db
from app.dependencies import get_current_user
from app.models.ai_conversation import AiConversation
from app.models.ai_session import AiSession
from app.models.api_key import ApiKey
from app.models.user import User
from app.llm.base import first_choice
from app.services.ai_entitlement import (
    byok_allowed,
    check_ai_allowance,
    parse_usage,
    record_ai_usage,
)
from app.services.ai_cache import (
    cache_response,
    get_cached_response,
    purge_expired,
)
from app.services.ai_region import RegionBlockedError, resolve_ai_chain
from app.services.ai_service import (
    build_messages,
    execute_tool_calls,
    get_llm_client,
    is_premium,
    tools_for_user,
)
from app.services.memory_service import (
    extract_memories,
    list_active_memories,
    purge_memories_for_session,
    retrieve_relevant_memories,
    store_memories,
)
from app.utils.ratelimit import RateLimiter, _get_redis

router = APIRouter(prefix="/api/ai", tags=["ai"])

# Redis-backed per-user limiter (rl:ai:* keys) with an in-memory fallback (used
# by tests and any deployment without Redis). The TTL pruner below only matters
# for the fallback; Redis entries expire on their own.
_ai_limiter = RateLimiter("rl:ai")
_ai_rate_limit: dict[str, list[float]] = {}
RATE_LIMIT_CLEANUP_INTERVAL = 300


async def _prune_rate_limits():
    while True:
        await asyncio.sleep(RATE_LIMIT_CLEANUP_INTERVAL)
        if _get_redis() is not None:
            # Redis TTLs expire counters automatically - nothing to prune.
            continue
        now = time.time()
        stale = [uid for uid, stamps in _ai_rate_limit.items()
                 if not any(now - t < 60 for t in stamps)]
        for uid in stale:
            del _ai_rate_limit[uid]
        for stamps in _ai_rate_limit.values():
            stamps[:] = [t for t in stamps if now - t < 60]


def start_rate_limit_pruner() -> asyncio.Task:
    return asyncio.create_task(_prune_rate_limits())


def _check_ai_rate_limit(user_id: str) -> None:
    max_requests = 30
    window = 60

    if _get_redis() is not None:
        count = _ai_limiter.count(f"ai:{user_id}", window)
        if count > max_requests:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Rate limit exceeded ({max_requests}/min). Please try again later.",
            )
        return

    now = time.time()
    if user_id not in _ai_rate_limit:
        _ai_rate_limit[user_id] = []
    _ai_rate_limit[user_id] = [t for t in _ai_rate_limit[user_id] if now - t < window]
    if len(_ai_rate_limit[user_id]) >= max_requests:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Rate limit exceeded ({max_requests}/min). Please try again later.",
        )
    _ai_rate_limit[user_id].append(now)


def _provider_error_detail(exc: Exception) -> str | None:
    """Return the underlying provider error message (e.g. OpenRouter's
    'Insufficient Credits') when we can read it, else None."""
    import openai

    if isinstance(exc, openai.APIStatusError):
        body = exc.body
        if isinstance(body, dict):
            err = body.get("error")
            if isinstance(err, dict):
                return str(err.get("message", "")).strip() or None
            if isinstance(err, str) and err.strip():
                return err.strip() or None
        return str(exc)
    if isinstance(exc, openai.OpenAIError):
        return str(getattr(exc, "message", exc)).strip() or None
    return None


def _friendly_llm_error(exc: Exception, provider: str | None = None) -> str:
    """Map provider/transport errors to a clear, actionable user message - e.g.
    when the user's OpenRouter key has no credits left."""
    import openai

    if isinstance(exc, openai.AuthenticationError):
        return "Your AI API key was rejected by the provider. Check the key in Settings."
    if isinstance(exc, openai.RateLimitError):
        return "The AI provider is rate-limiting requests. Please wait a moment and try again."

    detail = (_provider_error_detail(exc) or "").lower()
    status = exc.status_code if isinstance(exc, openai.APIStatusError) else None

    if status == 402 or "insufficient credit" in detail or "no credit" in detail or "payment required" in detail:
        if provider == "prysmai":
            # Hosted PrysmAI sub-keys are server-managed; a 402 means the user's
            # USD key limit (mirror of the token allowance) is exhausted, not a
            # missing credit balance on their own account.
            return (
                "Your PrysmAI token allowance is used up for this month. "
                "Upgrade your plan or wait for it to reset."
            )
        return (
            "Your AI provider account is out of credits, so the AI can't respond. "
            "Top up your account (e.g. at openrouter.ai) and try again."
        )
    if status and status == 429:
        return "The AI provider is rate-limiting requests. Please wait a moment and try again."

    if status:
        msg = _provider_error_detail(exc) or ""
        return f"The AI provider returned an error (HTTP {status}).{(' ' + msg) if msg else ''}"
    if isinstance(exc, openai.APIConnectionError):
        return "Could not reach the AI provider. Check your internet connection and try again."
    # Malformed/empty provider payloads (e.g. an empty ``choices`` array) and
    # parsing slips surface as bare Python exceptions. Never leak internal
    # traceback text to the user.
    if isinstance(exc, (IndexError, KeyError, TypeError, ValueError)):
        return "The AI provider returned an unexpected response. Please try again."
    msg = str(exc).strip()
    return f"AI request failed.{(' ' + msg) if msg else ''}"


MAX_CHAT_HISTORY = 20
MAX_MESSAGE_LENGTH = 4000


def _normalize_reply_markdown(text: str) -> str:
    """Clean up sloppy model output before it is persisted or displayed.

    Some providers write emphasis with stray spaces ("** what should the task
    be ?**" or "* x *") which never renders as markdown, and insert spaces
    around punctuation ("e .g .", "daily ,", "I 'll"). This fixes those
    artifacts line by line so replies render as real markdown. Fenced code
    blocks are left untouched (their whitespace is significant) and start-of-line
    "* "/"- " list markers are preserved (they are never emphasis closers).
    """
    if not text:
        return text

    def _strip_delimiter_spacing(line: str, marker: str) -> str:
        """Remove one stray-space run around paired emphasis/code delimiters.

        Pairs delimiters sequentially ("** a **" -> "**a**", "* x *" -> "*x*",
        "` x `" -> "`x`"). A start-of-line "* "/"- " is a list marker, never an
        opener, and clean text (no space right after the opener or before the
        closer) is left untouched.
        """
        positions = []
        i = 0
        while True:
            idx = line.find(marker, i)
            if idx == -1:
                break
            positions.append(idx)
            i = idx + len(marker)
        for p in range(0, len(positions) - 1, 2):
            open_idx = positions[p]
            close_idx = positions[p + 1]
            if marker in ("*", "-") and not line[:open_idx].strip():
                continue
            after_open = open_idx + len(marker)
            if after_open < len(line) and line[after_open].isspace():
                line = line[:after_open] + line[after_open:].lstrip()
                close_idx = line.find(marker, after_open)
                if close_idx == -1:
                    break
            before_close = close_idx
            k = before_close - 1
            while k >= 0 and line[k].isspace():
                k -= 1
            if k != before_close - 1:
                line = line[: k + 1] + line[before_close:]
        return line

    def _join_split_hex_run(line: str) -> str:
        """Rejoin streaming artifacts like "3 5 8 b 2 5 0 b" (single hex chars
        separated by spaces) into "358b250b", and "4 0 d 8 -b 9 5 0" -> "40d8-b950".

        Only runs of 6+ single-character hex tokens (dash-prefixed tokens allowed
        so UUID dashes survive) are touched, and only when the run also contains a
        digit - so ordinary words can never be collapsed ("a b c" stays intact).
        """
        def _repl(m: re.Match) -> str:
            tokens = m.group(0).split()
            if not any(c.isdigit() for t in tokens for c in t):
                return m.group(0)
            return "".join(tokens)

        return re.sub(r"\b-?[0-9a-fA-F](?: -?[0-9a-fA-F]){5,}\b", _repl, line)

    _QUOTE_CHARS = '"\u201c\u201d'

    def _strip_quote_padding(line: str) -> str:
        """Collapse padding inside quoted spans: ``" Work "`` -> ``"Work"`` and
        ``"Work "`` -> ``"Work"``. Works on matched quote pairs on one line, so
        quotes around a future word are never glued to it.
        """
        return re.sub(
            rf'(?<![0-9A-Za-z])([{_QUOTE_CHARS}])[ \t]+(?=\S)([^\s{_QUOTE_CHARS}][^{_QUOTE_CHARS}\n]*?)[ \t]+([{_QUOTE_CHARS}])(?=\s|[",.;:!?)\]%>]|$)',
            lambda m: f"{m.group(1)}{m.group(2).rstrip()}{m.group(3)}",
            line,
        )

    def _clean(line: str) -> str:
        # Space before punctuation: "e .g ." -> "e.g.", "daily ," -> "daily,".
        # "]" and "}" are excluded so GFM checkboxes "[ ]" stay intact.
        line = re.sub(r"[ \t]+([,.;:?!>)])", r"\1", line)
        # Space after an opening bracket/paren: "( e" -> "(e". An empty-bracket
        # checkbox "[ ]" is left alone (valid GFM task-list syntax).
        line = re.sub(r"([(\[{<])[ \t]+(?![\]}])", r"\1", line)
        # Contractions with a stray space: "I 'll" -> "I'll", "can 't" -> "can't",
        # "don ’t" -> "don’t", "I ’ ll" -> "I’ll". This runs on the word END
        # before the apostrophe (no \\b anchor bug): the suffix must be 1-3
        # letters, so quoted words like "said 'hello'" are never collapsed.
        line = re.sub(
            r"(\w+)[ \t]+([\u2018\u2019'])[ \t]*(\w{1,3})\b",
            lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}",
            line,
        )
        # Spaces hugging quotes: " Work " -> "Work" (one side or both).
        line = _strip_quote_padding(line)
        # UUID/hex artifacts from sloppy model streaming, before the digit-join
        # below (which would first merge "3 5 8" and break the hex run).
        line = _join_split_hex_run(line)
        # Number/time artifacts from sloppy model streaming: stray spaces split
        # digits, ordinals, ranges and clock times ("4 - 12", "May 29th, 2027",
        # "4pm"). Handles en/em dash spacing too.
        # Number ranges: "4 - 12" / "4- 12" / "4\u201312" -> "4-12".
        line = re.sub(r"(\d)[ \t]*[\u2013\u2014-][ \t]*(\d)", r"\1-\2", line)
        # Split digits: "2 0 2 7" -> "2027", "May 2 9 th" -> "May 29 th".
        line = re.sub(r"(\d)[ \t]+(?=\d)", r"\1", line)
        # Ordinal suffixes: "2 9 th" -> "29th" (after the digit join above).
        line = re.sub(r"(?i)(\d)[ \t]+(?=(?:st|nd|rd|th)\b)", r"\1", line)
        # 12-hour clock: "4 pm" -> "4pm".
        line = re.sub(r"(?i)(\d)[ \t]+(?=(?:am|pm)\b)", r"\1", line)
        # Emphasis/code delimiters written with stray spaces around the inner text.
        for marker in ("**", "__", "*", "_", "`"):
            line = _strip_delimiter_spacing(line, marker)
        return line

    out: list[str] = []
    in_fence = False
    for line in text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            out.append(line)
            continue
        out.append(line if in_fence else _clean(line))
    return "\n".join(out)


_TEXT_TOOL_CALL_MARKER = "[TOOL_CALLS]"


def _extract_text_tool_calls(text: str) -> list[tuple[str, str]]:
    """Pull ``[TOOL_CALLS] <name> {json}`` blocks out of raw model text.

    Some models cannot emit structured ``tool_calls`` and instead write them as
    literal text (often carrying the same stray-spacing artifact that splits
    digits and punctuation). Each block yields ``(name, json_text)``. Braces
    inside JSON string values are ignored so nested objects survive.
    """
    if not text or _TEXT_TOOL_CALL_MARKER not in text:
        return []
    calls: list[tuple[str, str]] = []
    rest = text
    while True:
        idx = rest.find(_TEXT_TOOL_CALL_MARKER)
        if idx == -1:
            break
        rest = rest[idx + len(_TEXT_TOOL_CALL_MARKER):]
        m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*", rest)
        if not m:
            continue
        name = m.group(1)
        rest = rest[m.end():]
        ob = rest.find("{")
        if ob == -1:
            break
        rest = rest[ob:]
        depth = 0
        in_str = False
        esc = False
        close = -1
        for i, ch in enumerate(rest):
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    close = i
                    break
        if close == -1:
            break  # incomplete block (mid-stream) - keep everything after it
        calls.append((name, rest[: close + 1]))
        rest = rest[close + 1:]
    return calls


def _strip_text_tool_calls(text: str) -> str:
    """Remove ``[TOOL_CALLS] ...`` blocks so raw JSON never reaches the user."""
    if not text or _TEXT_TOOL_CALL_MARKER not in text:
        return text
    out: list[str] = []
    rest = text
    while True:
        idx = rest.find(_TEXT_TOOL_CALL_MARKER)
        if idx == -1:
            out.append(rest)
            break
        out.append(rest[:idx])
        rest = rest[idx + len(_TEXT_TOOL_CALL_MARKER):]
        m = re.match(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*", rest)
        if not m:
            out.append(_TEXT_TOOL_CALL_MARKER)
            continue
        name = m.group(1)
        rest = rest[m.end():]
        ob = rest.find("{")
        if ob == -1:
            out.append(_TEXT_TOOL_CALL_MARKER + m.group(0) + rest)
            break
        rest = rest[ob:]
        depth = 0
        in_str = False
        esc = False
        close = -1
        for i, ch in enumerate(rest):
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    close = i
                    break
        if close == -1:
            # Incomplete block: keep it whole so a mid-stream partial never
            # corrupts the running text (the closing brace may arrive later).
            out.append(_TEXT_TOOL_CALL_MARKER + m.group(0) + rest)
            break
        rest = rest[close + 1:]
    return "".join(out)


def _clean_text_tool_json(text: str) -> str:
    """Normalize a model-written JSON tool payload so json.loads can read it.

    Reuses the reply normalizer (quote padding, digit runs, punctuation) and
    collapses leftover newlines/spacing inside the JSON structure.
    """
    return re.sub(r"\s+", " ", _normalize_reply_markdown(text)).strip()


def _parse_text_tool_calls(content: str) -> list[dict] | None:
    """Convert ``[TOOL_CALLS] <name> {json}`` text blocks into tool_call dicts.

    Returns None when the content carries no usable text tool calls, so callers
    fall back to the normal "no tools this round" behavior.
    """
    calls = _extract_text_tool_calls(content or "")
    if not calls:
        return None
    parsed: list[dict] = []
    for name, json_text in calls:
        try:
            args = json.loads(_clean_text_tool_json(json_text))
        except json.JSONDecodeError:
            continue
        if not isinstance(args, dict):
            continue
        parsed.append({
            "id": f"text-call-{uuid4().hex[:16]}",
            "type": "function",
            "function": {"name": name, "arguments": json.dumps(args)},
        })
    return parsed or None


def _chunk_text(text: str, size: int = 400) -> list[str]:
    """Split already-computed final answer text into token-like chunks so the
    frontend can render it incrementally without a second model call."""
    text = text or ""
    if len(text) <= size:
        return [text]
    words = text.split(" ")
    chunks: list[str] = []
    cur = ""
    for w in words:
        if cur and len(cur) + len(w) + 1 > size:
            chunks.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip() if cur else w
    if cur:
        chunks.append(cur)
    return chunks


# Rough heuristic: ~4 chars per token, close enough for cost-usage visibility.
_CHARS_PER_TOKEN = 4


def _estimate_tokens(prompt_messages: list[dict], completion: str | None = None) -> int:
    """Estimate total tokens for a prompt + (optional) completion, so the user
    can see how expensive a turn was. Not a precise tokenizer - for visibility."""
    chars = 0
    for m in prompt_messages or []:
        content = m.get("content")
        if isinstance(content, str):
            chars += len(content)
        tool_calls = m.get("tool_calls")
        if isinstance(tool_calls, list):
            for tc in tool_calls:
                fn = (tc.get("function") or {}).get("name", "")
                args = (tc.get("function") or {}).get("arguments", "")
                chars += len(fn) + len(str(args))
    prompt_tokens = max(1, chars // _CHARS_PER_TOKEN)
    if completion:
        prompt_tokens += max(0, len(completion) // _CHARS_PER_TOKEN)
    return prompt_tokens


def _sanitize_chat_history(chat_history: list[dict]) -> list[dict]:
    sanitized_history = []
    for msg in chat_history[-MAX_CHAT_HISTORY:]:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role", "")
        if role not in ("user", "assistant"):
            continue
        content = str(msg.get("content", ""))[:MAX_MESSAGE_LENGTH]
        sanitized_history.append({"role": role, "content": content})
    return sanitized_history


class ChatRequest(BaseModel):
    message: str
    session_id: str | None = None
    chat_history: list[dict] = []
    provider: str = "openai"
    context: dict | None = None


async def get_user_api_key(session: AsyncSession, user: User, provider: str) -> str | None:
    result = await session.execute(
        select(ApiKey).where(
            ApiKey.user_id == user.id,
            ApiKey.provider == provider,
            ApiKey.is_active.is_(True),
        )
    )
    api_key = result.scalar_one_or_none()
    if api_key:
        from app.utils.encryption import decrypt_api_key
        return decrypt_api_key(api_key.encrypted_key)
    return None


def _resolve_chain(http_request: Request | None) -> tuple[str, list[str]]:
    """Resolve ``(primary, fallbacks)`` from the request's ``cf-ipcountry``.

    Restricted countries raise HTTP 403 before any model call or usage happens;
    missing/unknown countries fall through to the global compliant chain.
    """
    country = http_request.headers.get("cf-ipcountry") if http_request else None
    try:
        return resolve_ai_chain(country)
    except RegionBlockedError:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="PrysmAI is not available in your region.",
        ) from None


def _build_llm_client(provider: str, api_key: str | None, chain: tuple[str, list[str]] | None):
    """Construct the provider client, feeding the hosting chain to PrysmAI.

    ``chain`` is ``(primary, fallbacks)`` for the hosted ``prysmai`` provider
    and ``None`` for BYOK providers (which take only their key). ZDR is always
    forced for hosted calls.
    """
    if provider == "prysmai" and chain:
        return get_llm_client(
            provider,
            api_key or "",
            model=chain[0],
            fallbacks=chain[1],
            zdr=settings.prysm_ai_zdr,
        )
    return get_llm_client(provider, api_key or "")


async def resolve_llm_key(
    session: AsyncSession, user: User, provider: str, http_request: Request | None = None
) -> tuple[str, str | None, tuple[str, list[str]] | None]:
    """Resolve ``(provider, api_key, chain)`` for a chat request.

    For the hosted ``prysmai`` provider this validates the user's AI entitlement
    + allowance, resolves the region-routes model chain, and (EE build) returns
    the user's per-user OpenRouter sub-key; BYOK providers return the user's own
    stored key with ``chain=None`` (paid subscription required in the hosted
    build - the community build has no premium tier, so BYOK stays open there).
    Raises a 4xx HTTPException with a friendly message when access isn't allowed.
    """
    if provider == "prysmai":
        ent = await check_ai_allowance(str(user.id), session)
        if ent.get("mode") != "prysmai":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="PrysmAI requires an active plan or the 14-day free trial.",
            )
        if ent.get("blocked"):
            raise HTTPException(
                status_code=status.HTTP_402_PAYMENT_REQUIRED,
                detail="Your PrysmAI token allowance is used up for this month. Upgrade your plan or wait for it to reset.",
            )
        chain_primary, chain_fallbacks = _resolve_chain(http_request)


        # Community build (no EE key service): fall back to the legacy server-key
        # behavior. The client now targets OpenRouter, so prefer the server's
        # OpenRouter key (a DeepSeek key only ever worked against api.deepseek.com).
        server_key = os.getenv("OPENROUTER_API_KEY") or os.getenv("DEEPSEEK_API_KEY") or ""
        if not server_key:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="PrysmAI is not configured on this server yet.",
            )
        return "prysmai", server_key, (chain_primary, chain_fallbacks)

    if not await byok_allowed(str(user.id), session):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="AI with your own API key is available on paid plans only. Start the 14-day free trial for hosted PrysmAI, or upgrade to a paid plan.",
        )
    api_key = await get_user_api_key(session, user, provider)
    if not api_key:
        raise HTTPException(status_code=400, detail="Please provide an API key in Settings.")
    return provider, api_key, None


async def record_response_usage(
    session: AsyncSession, user_id, provider: str, response: dict
) -> None:
    """Record token usage from an OpenAI-style provider response (hosted only)."""
    if provider != "prysmai":
        return
    u = parse_usage(response)
    if u["input"] or u["output"]:
        await record_ai_usage(session, user_id, "prysmai", u["input"], u["output"], u["cached_input"])


async def record_estimated_usage(
    session: AsyncSession, user_id, provider: str, messages: list[dict], streamed: str
) -> None:
    """Estimate + record usage for a streamed hosted answer (no usage in stream)."""
    if provider != "prysmai":
        return
    inp = _estimate_tokens(messages, "")
    out = _estimate_tokens([{"role": "assistant", "content": streamed}], "")
    await record_ai_usage(session, user_id, "prysmai", inp, out, 0)


# In-flight request coalescing: keyed by cache_key; concurrent identical tool-round
# requests share ONE provider call instead of each re-billing it (batching). Entries
# are removed in a finally, so a stale key can't leak.
_in_flight: dict[str, asyncio.Future] = {}


async def chat_with_cache(
    session: AsyncSession, user_id, provider: str, client, messages: list[dict], tools: list[dict] | None
) -> dict:
    """Run a tool-round provider call, served from the response cache when the
    exact request was answered recently (saves provider spend - the point of the
    cache for hosted PrysmAI). Usage is only recorded for real (non-cached) calls.
    Identical concurrent requests are coalesced into a single provider call.
    """
    from app.services.ai_cache import make_cache_key

    cached = await get_cached_response(session, user_id, provider, messages, tools)
    if cached is not None:
        return cached

    key = make_cache_key(user_id, provider, messages, tools)
    fut = _in_flight.get(key)
    if fut is not None:
        # Another request is already running this exact call; await its result.
        return await asyncio.shield(fut)

    fut = asyncio.get_event_loop().create_future()
    _in_flight[key] = fut
    try:
        response = await client.chat(messages, tools=tools)
        await cache_response(session, user_id, provider, messages, tools, response)
        await record_response_usage(session, user_id, provider, response)
        if not fut.done():
            fut.set_result(response)
        return response
    except Exception as exc:
        if not fut.done():
            fut.set_exception(exc)
        raise
    finally:
        _in_flight.pop(key, None)


async def persist_conversation(
    session: AsyncSession,
    user_id: str,
    session_id: str,
    role: str,
    content: str,
    tool_calls: dict | None = None,
) -> AiConversation:
    conv = AiConversation(
        user_id=user_id,
        session_id=session_id,
        role=role,
        content=content,
        tool_calls=tool_calls,
    )
    session.add(conv)
    return conv


async def load_session_summary(session: AsyncSession, user_id: str, session_id: str) -> AiSession | None:
    result = await session.execute(
        select(AiSession).where(
            AiSession.user_id == user_id,
            AiSession.session_id == session_id,
        )
    )
    return result.scalar_one_or_none()


async def create_session_summary(session: AsyncSession, user_id: str, session_id: str) -> None:
    session.add(AiSession(user_id=user_id, session_id=session_id))


async def summarize_conversation(
    client,
    history: list[dict],
    existing_summary: str | None,
) -> str:
    prior = f"\nExisting summary:\n{existing_summary}" if existing_summary else ""
    transcript = "\n".join(
        f"{m.get('role')}: {str(m.get('content', ''))[:800]}"
        for m in history[-20:]
        if m.get("role") in ("user", "assistant", "tool")
    )
    prompt = (
        "You maintain a compact rolling summary of a task-management chat. "
        "Distill the ABSOLUTE essentials only: tasks discussed or created (title, date, priority), "
        "scheduling decisions, conflicts, dates resolved, and user preferences. "
        "Keep it to one concise paragraph (under ~120 words). "
        "Do NOT invent facts not in the conversation. Drop trivia.\n\n"
        f"{prior.strip()}\n\nLatest messages:\n{transcript.strip()}\n\n"
        "Updated one-paragraph summary:"
    )
    try:
        resp = await client.chat(
            [{"role": "user", "content": prompt}],
            tools=None,
            temperature=0.2,
            max_tokens=300,
        )
        content = (first_choice(resp).get("message", {}).get("content", "") or "").strip()
        if not content or len(content) < 20:
            return existing_summary or ""
        # Collapse the "Updated ..." wrapper if the model echoed it.
        return content
    except Exception:
        return existing_summary or ""


SUMMARIZE_MIN_HISTORY = 8


async def _maybe_update_summary(
    session: AsyncSession,
    user_id: str,
    session_id: str,
    client,
    sanitized_history: list[dict],
    user_message: str,
    assistant_content: str,
    current_summary: str | None,
) -> None:
    """Fold the latest turns into a rolling summary.

    Only runs once there's enough history for a summary to be useful, or when a
    summary already exists (so it keeps evolving). Failures fall back silently to
    the existing truncation behavior - never breaks the user request.
    """
    total_turns = len(sanitized_history) + 2  # + this user + assistant message
    if total_turns < SUMMARIZE_MIN_HISTORY and not current_summary:
        return

    combined_history = sanitized_history + [
        {"role": "user", "content": user_message},
        {"role": "assistant", "content": assistant_content},
    ]
    new_summary = await summarize_conversation(client, combined_history, current_summary)

    ai_session = await load_session_summary(session, user_id, session_id)
    if ai_session is None:
        await create_session_summary(session, user_id, session_id)
        ai_session = await load_session_summary(session, user_id, session_id)
    if ai_session is not None:
        ai_session.summary = new_summary
    await session.flush()


# Run memory extraction only when the turn plausibly produced something durable
# (a real assistant reply, or it replaced placeholder content when tools ran).
MEMORY_EXTRACT_MIN_CONTENT = 20


async def _maybe_extract_memories(
    session: AsyncSession,
    user_id: str,
    session_id: str,
    client,
    sanitized_history: list[dict],
    user_message: str,
    assistant_content: str,
) -> list[dict]:
    """After a turn, distill any durable cross-session facts into AiMemory rows.

    Fail-open and bounded (mirrors _maybe_update_summary): never raises into the
    turn, caps storage, dedupes. Only runs when there's a substantive reply and
    either meaningful history or the user actually wrote something new.
    """
    if not assistant_content or len(assistant_content) < MEMORY_EXTRACT_MIN_CONTENT:
        return []
    if not (user_message.strip() or sanitized_history):
        return []

    facts = await extract_memories(client, sanitized_history, user_message, assistant_content)
    if not facts:
        return facts
    await store_memories(session, user_id, session_id, facts)
    return facts


@router.get("/entitlement")
async def ai_entitlement(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    """Return the user's AI entitlement (PrysmAI allowance + usage, or BYOK)."""
    ent = await check_ai_allowance(str(user.id), session)
    return {
        "mode": ent.get("mode", "byok"),
        "allowance": ent.get("allowance", 0),
        "used": ent.get("used", 0),
        "remaining": ent.get("remaining"),
        "blocked": bool(ent.get("blocked")),
    }


@router.post("/chat")
async def chat(
    request: ChatRequest,
    http_request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _check_ai_rate_limit(str(user.id))

    provider, api_key, chain = await resolve_llm_key(session, user, request.provider, http_request)

    session_id = request.session_id or str(uuid4())
    client = await _build_llm_client(provider, api_key, chain)
    sanitized_history = _sanitize_chat_history(request.chat_history)
    ai_session = await load_session_summary(session, user.id, session_id)
    current_summary = ai_session.summary if ai_session else None
    memories = await retrieve_relevant_memories(session, str(user.id), request.message)
    premium = await is_premium(str(user.id), session)
    tools = tools_for_user(premium)
    messages = build_messages(sanitized_history, request.message, request.context, current_summary, memories, include_finance=premium)

    MAX_TOOL_ROUNDS = 4
    content = ""
    tool_calls = None
    try:
        try:
            for _round in range(MAX_TOOL_ROUNDS):
                response = await chat_with_cache(session, user.id, provider, client, messages, tools)
                choice = first_choice(response)
                assistant_message = choice.get("message", {})
                content = assistant_message.get("content", "") or ""
                tool_calls = assistant_message.get("tool_calls")

                if not tool_calls:
                    tool_calls = _parse_text_tool_calls(content)
                    if tool_calls:
                        content = _strip_text_tool_calls(content)

                if not tool_calls:
                    break

                messages.append({"role": "assistant", "content": content, "tool_calls": tool_calls})
                tool_results = await execute_tool_calls(tool_calls, user.id, session, client)
                messages.extend(tool_results)

                if _round == MAX_TOOL_ROUNDS - 1:
                    fallback = await client.chat(messages, tools=None)
                    await record_response_usage(session, user.id, provider, fallback)
                    content = (first_choice(fallback).get("message", {}).get("content", "")) or ""
                    tool_calls = None
        except Exception as exc:  # provider/auth/credit errors -> a clear, actionable message
            raise HTTPException(status_code=502, detail=_friendly_llm_error(exc, provider)) from exc

        # Durable tool side-effects before answering: commit any created/scheduled
        # tasks so a disconnect after the response can't roll them back.
        await session.commit()

        content = _strip_text_tool_calls(content)
        await persist_conversation(session, user.id, session_id, "user", request.message)
        await persist_conversation(session, user.id, session_id, "assistant", content, tool_calls)
        # The client must STILL be open here: summary + memory extraction make
        # their own LLM calls through it. Closing it in the earlier finally would
        # silently kill both (they fail open, so no error, just no summaries).
        await _maybe_update_summary(session, user.id, session_id, client, sanitized_history, request.message, content, current_summary)
        await _maybe_extract_memories(session, user.id, session_id, client, sanitized_history, request.message, content)
        await session.commit()

        return {
            "content": content,
            "tool_calls": tool_calls,
            "session_id": session_id,
            "estimated_tokens": _estimate_tokens(messages, content),
        }
    finally:
        await _safe_aclose(client)


async def _safe_aclose(client) -> None:
    """Close a per-request provider client, swallowing any teardown error."""
    try:
        await client.aclose()
    except Exception:
        pass


async def _distill_after_answer(
    user_id,
    session_id,
    client,
    sanitized_history: list[dict],
    user_message: str,
    assistant_content: str,
    current_summary: str | None,
) -> None:
    """Best-effort summary + memory distillation, run off the SSE done path.

    Opens its own DB session (never the request-scoped one, which is closed when
    the stream ends) and owns the provider client: it closes the client when the
    distillation finishes. Per-item try/except so one failure never loses the
    other's work.
    """
    try:
        async with async_session_factory() as bg_session:
            try:
                await _maybe_update_summary(
                    bg_session, user_id, session_id, client, sanitized_history,
                    user_message, assistant_content, current_summary,
                )
            except Exception:
                pass
            try:
                await _maybe_extract_memories(
                    bg_session, user_id, session_id, client, sanitized_history,
                    user_message, assistant_content,
                )
            except Exception:
                pass
            try:
                await bg_session.commit()
            except Exception:
                pass
    except Exception:
        pass
    finally:
        await _safe_aclose(client)


@router.post("/chat/stream")
async def chat_stream(
    req: ChatRequest,
    http_request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    _check_ai_rate_limit(str(user.id))

    provider, api_key, chain = await resolve_llm_key(session, user, req.provider, http_request)

    session_id = req.session_id or str(uuid4())
    client = await _build_llm_client(provider, api_key, chain)
    sanitized_history = _sanitize_chat_history(req.chat_history)
    ai_session = await load_session_summary(session, user.id, session_id)
    current_summary = ai_session.summary if ai_session else None
    memories = await retrieve_relevant_memories(session, str(user.id), req.message)
    premium = await is_premium(str(user.id), session)
    tools = tools_for_user(premium)
    messages = build_messages(sanitized_history, req.message, req.context, current_summary, memories, include_finance=premium)

    await persist_conversation(session, user.id, session_id, "user", req.message)

    async def event_generator():
        import json

        MAX_TOOL_ROUNDS = 4
        tool_calls = None
        content = ""
        placeholder = None
        bg_task = None

        try:
            try:
                for _round in range(MAX_TOOL_ROUNDS):
                    if await http_request.is_disconnected():
                        raise asyncio.CancelledError()
                    # Run the provider round as a task so we can heartbeat the
                    # connection every ~15s and abort when the client disconnects,
                    # instead of letting a gone client eat up to 90s of work.
                    round_task = asyncio.create_task(
                        chat_with_cache(session, user.id, provider, client, messages, tools)
                    )
                    try:
                        while not round_task.done():
                            if await http_request.is_disconnected():
                                round_task.cancel()
                                raise asyncio.CancelledError()
                            done_now, _ = await asyncio.wait({round_task}, timeout=15.0)
                            if done_now:
                                break
                            yield {"comment": "ping"}
                        response = await round_task
                    except asyncio.CancelledError:
                        round_task.cancel()
                        raise
                    choice = first_choice(response)
                    assistant_message = choice.get("message", {})
                    content = assistant_message.get("content", "") or ""
                    tool_calls = assistant_message.get("tool_calls")

                    if not tool_calls:
                        # Some models cannot emit structured tool_calls and
                        # instead write "[TOOL_CALLS] name {json}" as literal
                        # text. Parse and execute those so the turn still
                        # completes, and keep the prose (minus the block).
                        tool_calls = _parse_text_tool_calls(content)
                        if tool_calls:
                            content = _strip_text_tool_calls(content)

                    if not tool_calls:
                        break

                    # Run tool calls, feed their outputs back, and continue the loop so a
                    # search → create → conflict-check sequence can complete in one turn.
                    messages.append({"role": "assistant", "content": content, "tool_calls": tool_calls})
                    yield {
                        "event": "tool_start",
                        "data": json.dumps([tc.get("function", {}).get("name") for tc in tool_calls]),
                    }
                    tool_results = await execute_tool_calls(tool_calls, user.id, session, client)
                    messages.extend(tool_results)
                    yield {"event": "tool_results", "data": json.dumps([r["content"] for r in tool_results])}
            except Exception as exc:  # provider/auth/credit errors should be visible, not a dead stream
                yield {"event": "error", "data": _friendly_llm_error(exc, provider)}
                return

            # Commit tool side-effects, the user message (persisted at request time)
            # AND an assistant placeholder BEFORE streaming the final answer.
            # Persisting the assistant turn here - instead of after the tokens stream
            # - means a client abort/cancel mid-answer can never drop the reply: once
            # we reach this point the whole turn is durable. Tool-created tasks are
            # flushed in execute_tool_calls but not committed; this commit makes them
            # durable too.
            placeholder = await persist_conversation(session, user.id, session_id, "assistant", "", tool_calls)
            await session.commit()

            # Stream the final natural-language answer for real. The tool loop's
            # completed content is only a fallback; the final round re-invokes the
            # provider in streaming mode so tokens arrive incrementally (the cost of
            # one extra model call per turn is accepted).
            streamed = ""
            try:
                async for chunk in client.stream_chat(messages, tools=None):
                    streamed += chunk
                    yield {"event": "token", "data": chunk}
            except Exception as exc:
                # Fall back to the non-streaming loop output rather than an empty
                # answer, then surface the error so the client can show it. The
                # placeholder ALWAYS receives real content (partial stream or the
                # tool-loop fallback) so an interrupted turn never leaves an empty
                # bubble in history.
                if not streamed.strip():
                    streamed = _strip_text_tool_calls(content).strip() or "Interrupted."
                    for chunk in _chunk_text(streamed):
                        yield {"event": "token", "data": chunk}
                placeholder.content = _normalize_reply_markdown(_strip_text_tool_calls(streamed))
                try:
                    await session.commit()
                except Exception:
                    pass
                yield {"event": "error", "data": _friendly_llm_error(exc, provider)}
                return

            if not streamed.strip():
                # The streaming call produced nothing real (empty iterator or
                # whitespace-only tokens). Prefer the non-streaming tool-loop
                # output; as a last resort emit a human fallback instead of a
                # blank " " bubble that renders as an empty message in history.
                streamed = _strip_text_tool_calls(content).strip() or (
                    "I couldn't get a response from the AI on that turn. "
                    "Please try again or rephrase your request."
                )
                if streamed:
                    for chunk in _chunk_text(streamed):
                        yield {"event": "token", "data": chunk}

            # Normalize sloppy model formatting (stray-space emphasis/punctuation)
            # so the persisted reply renders as real markdown on reload. Any
            # literal [TOOL_CALLS] blocks the model wrote into its answer are
            # removed first so raw JSON never reaches the chat history.
            streamed = _normalize_reply_markdown(_strip_text_tool_calls(streamed))

            # Persist the streamed answer over the placeholder row FIRST: once the
            # reply is committed, a later bookkeeping failure (usage recording, SSE
            # teardown) can never leave an empty assistant row in history.
            placeholder.content = streamed
            try:
                await session.commit()
            except Exception:
                pass

            # Record the streamed hosted answer's (estimated) usage best-effort. A
            # usage failure must never drop or change the already-persisted reply.
            try:
                await record_estimated_usage(session, user.id, provider, messages, streamed)
                try:
                    await session.commit()
                except Exception:
                    pass
            except Exception:
                pass

            estimated_tokens = _estimate_tokens(messages, streamed)
            yield {"event": "usage", "data": json.dumps({"estimated_tokens": estimated_tokens})}

            # Summary/memory distillation are best-effort and slow, so they move OFF
            # the done path: the client sees "done" immediately and the distillation
            # runs as a background task with its own session (the background task
            # owns the provider client and closes it when finished).
            bg_task = asyncio.create_task(
                _distill_after_answer(
                    user.id, session_id, client, sanitized_history, req.message, streamed, current_summary
                )
            )
            yield {"event": "done", "data": ""}
        except asyncio.CancelledError:
            # Client disconnected: never leave an empty turn behind. The committed
            # placeholder gets marked interrupted so history shows a real row.
            if placeholder is not None and not placeholder.content:
                placeholder.content = "Interrupted."
                try:
                    await session.commit()
                except Exception:
                    pass
            if bg_task is not None:
                bg_task.cancel()
            raise
        finally:
            # Close the per-request provider client (httpx/AsyncOpenAI pool). When a
            # background distillation was scheduled it owns the client and closes it.
            if bg_task is None:
                await _safe_aclose(client)

    return EventSourceResponse(event_generator())


@router.get("/sessions")
async def list_sessions(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    from sqlalchemy import func as sa_func
    result = await session.execute(
        select(AiConversation.session_id, sa_func.count(AiConversation.id), sa_func.max(AiConversation.created_at))
        .where(AiConversation.user_id == user.id)
        .group_by(AiConversation.session_id)
        .order_by(sa_func.max(AiConversation.created_at).desc())
        .limit(50)
    )
    rows = result.all()

    titles: dict[str, str] = {}
    summ: dict[str, str | None] = {}
    if rows:
        ids = [str(r[0]) for r in rows]
        first_msgs = await session.execute(
            select(AiConversation)
            .where(
                AiConversation.user_id == user.id,
                AiConversation.session_id.in_(ids),
                AiConversation.role == "user",
            )
            .order_by(AiConversation.created_at)
        )
        seen: set[str] = set()
        for c in first_msgs.scalars().all():
            sid = str(c.session_id)
            if sid in seen:
                continue
            seen.add(sid)
            titles[sid] = (c.content or "").strip()[:60] or "New Chat"

        summaries = await session.execute(
            select(AiSession).where(AiSession.user_id == user.id, AiSession.session_id.in_(ids))
        )
        summ = {str(s.session_id): s.summary for s in summaries.scalars().all()}

    out = []
    for (sid, count, last_at) in rows:
        sid = str(sid)
        out.append({
            "session_id": sid,
            "title": titles.get(sid) or "New Chat",
            "message_count": count,
            "last_message_at": last_at.isoformat(),
            "summary": summ.get(sid),
        })
    return out


@router.get("/conversations/{session_id}")
async def get_conversation_history(
    session_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    result = await session.execute(
        select(AiConversation)
        .where(
            AiConversation.user_id == user.id,
            AiConversation.session_id == session_id,
        )
        .order_by(AiConversation.created_at)
    )
    return [
        {
            "role": c.role,
            "content": c.content,
            "tool_calls": c.tool_calls,
            "created_at": c.created_at.isoformat(),
        }
        for c in result.scalars().all()
    ]


@router.delete("/sessions/{session_id}")
async def delete_session(
    session_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    from sqlalchemy import delete
    await session.execute(
        delete(AiSession).where(
            AiSession.user_id == user.id,
            AiSession.session_id == session_id,
        )
    )
    await session.execute(
        delete(AiConversation).where(
            AiConversation.user_id == user.id,
            AiConversation.session_id == session_id,
        )
    )
    # Purge any durable memory facts extracted from this session so deleting a
    # chat also drops the "life" facts it produced.
    await purge_memories_for_session(session, str(user.id), session_id)
    await session.commit()
    return {"deleted": True, "session_id": session_id}


@router.get("/memories")
async def get_memories(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    memories = await list_active_memories(session, str(user.id))
    return memories


@router.delete("/memories/{memory_id}")
async def delete_memory(
    memory_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db),
):
    from sqlalchemy import delete
    from app.models.ai_memory import AiMemory
    result = await session.execute(
        delete(AiMemory).where(
            AiMemory.user_id == user.id,
            AiMemory.id == memory_id,
        )
    )
    await session.commit()
    return {"deleted": bool(result.rowcount), "memory_id": memory_id}
