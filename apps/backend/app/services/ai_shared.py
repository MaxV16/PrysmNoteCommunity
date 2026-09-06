"""Shared utilities for AI routers and the background turn runner.

Avoids circular imports: ai.py and ai_turn_runner.py both need these helpers.
"""

import re
import json
from uuid import uuid4


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
