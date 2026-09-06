"""Shared utilities for AI routers and the background turn runner.

Avoids circular imports: ai.py and ai_turn_runner.py both need these helpers.
"""

import re
import json
from uuid import uuid4

from app.services.common_words import COMMON_WORDS


_TEXT_TOOL_CALL_MARKER = "[TOOL_CALLS]"


def _normalize_reply_markdown(text: str) -> str:
    """Clean up sloppy model output before it is persisted or displayed."""
    if not text:
        return text

    def _strip_delimiter_spacing(line: str, marker: str) -> str:
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
        def _repl(m: re.Match) -> str:
            tokens = m.group(0).split()
            if not any(c.isdigit() for t in tokens for c in t):
                return m.group(0)
            return "".join(tokens)

        return re.sub(r"\b-?[0-9a-fA-F](?: -?[0-9a-fA-F]){5,}\b", _repl, line)

    _QUOTE_CHARS = '"\u201c\u201d'

    def _strip_quote_padding(line: str) -> str:
        return re.sub(
            rf'(?<![0-9A-Za-z])([{_QUOTE_CHARS}])[ \t]+(?=\S)([^\s{_QUOTE_CHARS}][^{_QUOTE_CHARS}\n]*?)[ \t]+([{_QUOTE_CHARS}])(?=\s|[",.;:!?)\]%>]|$)',
            lambda m: f"{m.group(1)}{m.group(2).rstrip()}{m.group(3)}",
            line,
        )

    def _collapse_hyphen_spacing(line: str) -> str:
        # A word split around a hyphen by a dropped/spurious space ("hyper -int",
        # "hyper- int", "hyper - int") collapses to the compound ("hyper-int").
        # Only when at least one side is NOT a dictionary word (a streaming
        # fragment), so a deliberate spaced dash clause ("mean - it works")
        # survives untouched. Mirrors ai-format.ts.
        def _repl(m: re.Match) -> str:
            a, b = m.group(1), m.group(2)
            if a.lower() in COMMON_WORDS and b.lower() in COMMON_WORDS:
                return m.group(0)
            return f"{a}-{b}"

        return re.sub(r"([A-Za-z]+)[ \t]*-[ \t]*([A-Za-z]+)", _repl, line)

    def _clean(line: str) -> str:
        line = re.sub(r"[ \t]+([,.;:?!>)])", r"\1", line)
        line = re.sub(r"([(\[{<])[ \t]+(?![\]}])", r"\1", line)
        line = re.sub(
            r"(\w+)[ \t]+([\u2018\u2019'])[ \t]*(\w{1,3})\b",
            lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}",
            line,
        )
        line = _strip_quote_padding(line)
        line = _join_split_hex_run(line)
        line = re.sub(r"(\d)[ \t]*[\u2013\u2014-][ \t]*(\d)", r"\1-\2", line)
        line = re.sub(r"(\d)[ \t]+(?=\d)", r"\1", line)
        line = re.sub(r"(?i)(\d)[ \t]+(?=(?:st|nd|rd|th)\b)", r"\1", line)
        line = re.sub(r"(?i)(\d)[ \t]+(?=(?:am|pm)\b)", r"\1", line)
        for marker in ("**", "__", "*", "_", "`"):
            line = _strip_delimiter_spacing(line, marker)
        line = _collapse_hyphen_spacing(line)
        # Words split by fragmented streaming ("Fin ance", "Pr ys m Note") and
        # words merged by dropped spaces ("Trackand Manage"). Runs with digits
        # or punctuation were already cleaned above; only letter runs are tried.
        line = _rejoin_fragmented_words(line)
        line = _split_merged_words(line)
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


_FRAGMENT_RE = re.compile(r"[A-Za-z]+")


def _rejoin_fragmented_words(line: str) -> str:
    """Rejoin words split by fragmented streaming ("Fin ance", "Pr ys m Note").

    A fragment run is a maximal sequence of pure-letter tokens where each
    consecutive pair is separated by whitespace only. Tokens that the earlier
    rules merged punctuation into ("(tom", "tasks:") still take part: only the
    letters are rejoined and the punctuation shell is preserved. Mirrors the
    rejoin pass in apps/frontend/src/lib/ai-format.ts.
    """
    items = [(m.start(), m.end(), m.group(0)) for m in _FRAGMENT_RE.finditer(line)]
    if len(items) < 2:
        return line
    out: list[str] = []
    pos = 0
    i = 0
    n = len(items)
    while i < n:
        j = i + 1
        while j < n and not line[items[j - 1][1]: items[j][0]].strip():
            j += 1
        run = items[i:j]
        out.append(line[pos: run[0][0]])
        if len(run) == 1:
            out.append(run[0][2])
        else:
            tokens = [it[2] for it in run]
            gaps = [line[run[k][1]: run[k + 1][0]] for k in range(len(run) - 1)]
            out.append(_rejoin_run(tokens, gaps))
        pos = run[-1][1]
        i = j
    out.append(line[pos:])
    return "".join(out)


def _is_valid_join(tokens: list[str], i: int, k: int) -> bool:
    joined = "".join(tokens[i: i + k])
    if not (4 <= len(joined) <= 24) or joined.lower() not in COMMON_WORDS:
        return False
    return any(t.lower() not in COMMON_WORDS for t in tokens[i: i + k])


def _rejoin_length(tokens: list[str], i: int) -> int:
    n = len(tokens)
    # Longest prefix that ends right before a standalone dictionary word, so a
    # real word like "Note" in "Pr ys m Note" is never absorbed.
    for k in range(min(n - i - 1, 24), 1, -1):
        if _is_valid_join(tokens, i, k) and tokens[i + k].lower() in COMMON_WORDS:
            return k
    # Whole-run fallback (covers "Fin ance", "tom orrow", "go ing").
    for k in range(min(n - i, 24), 1, -1):
        if _is_valid_join(tokens, i, k):
            return k
    return 0


def _rejoin_run(tokens: list[str], gaps: list[str]) -> str:
    result: list[str] = []
    i = 0
    prev_end = -1
    while i < len(tokens):
        gap = "" if prev_end == -1 else gaps[prev_end]
        k = _rejoin_length(tokens, i)
        if k >= 2:
            result.append(gap + "".join(tokens[i: i + k]))
            prev_end = i + k - 1
            i += k
        else:
            result.append(gap + tokens[i])
            prev_end = i
            i += 1
    return "".join(result)


def _split_merged_words(line: str) -> str:
    """Reinsert a space in words merged by a dropped space ("Trackand Manage").

    Only unknown 6+ letter tokens are candidates, and the split point must
    leave two dictionary-word halves on both sides, so known words like "into"
    or "alright" are never touched. The first non-suffix split wins; a trailing
    "s"/"ed"/"ing" split is only used when nothing else fits. Mirrors
    splitMergedWord in apps/frontend/src/lib/ai-format.ts.
    """

    def _repl(m: re.Match) -> str:
        tok = m.group(0)
        lower = tok.lower()
        if lower in COMMON_WORDS:
            return tok
        first_valid = -1
        first_clean = -1
        for i in range(4, len(lower) - 1):
            left = lower[:i]
            right = lower[i:]
            if left not in COMMON_WORDS or right not in COMMON_WORDS:
                continue
            if first_valid == -1:
                first_valid = i
            if right not in ("s", "ed", "ing"):
                first_clean = i
                break
        at = first_clean if first_clean != -1 else first_valid
        if at == -1:
            return tok
        return tok[:at] + " " + tok[at:]

    return re.sub(r"[A-Za-z]{6,}", _repl, line)


def _strip_text_tool_calls(text: str) -> str:
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
            out.append(_TEXT_TOOL_CALL_MARKER + m.group(0) + rest)
            break
        rest = rest[close + 1:]
    return "".join(out)


def _clean_text_tool_json(text: str) -> str:
    return re.sub(r"\s+", " ", _normalize_reply_markdown(text)).strip()


def _parse_text_tool_calls(content: str) -> list[dict] | None:
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


def _extract_text_tool_calls(text: str) -> list[tuple[str, str]]:
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
            break
        calls.append((name, rest[: close + 1]))
        rest = rest[close + 1:]
    return calls


def _chunk_text(text: str, size: int = 400) -> list[str]:
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


async def _safe_aclose(client) -> None:
    try:
        await client.aclose()
    except Exception:
        pass
