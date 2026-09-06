"""Shared utilities for AI routers and the background turn runner.

Avoids circular imports: ai.py and ai_turn_runner.py both need these helpers.
"""

import re
import json
from uuid import uuid4

from app.services.common_words import COMMON_WORDS


_TEXT_TOOL_CALL_MARKER = "[TOOL_CALLS]"


_FRAGMENT_LINE_MAX = 24

_ORDINAL_SUFFIXES = frozenset({"st", "nd", "rd", "th"})

# Inflected and function words the Oxford-3000-based COMMON_WORDS omits (it
# stores base forms like "be" not "is/was/been"). These must never absorb a
# neighbour, so "is an" and "has been" keep their space even though none of
# the tokens are dictionary words.
_INFLECTED_STOP = frozenset({
    "i", "is", "am", "are", "was", "were", "been", "has", "had", "does",
    "did", "you", "we", "they", "he", "she", "me", "him", "her", "us",
    "them", "my", "our", "your", "their", "this", "that", "these", "those",
    "who", "whom", "whose", "which", "what", "when", "where", "why", "how",
    "than", "then", "now", "here", "there", "not", "no", "yes", "so", "if",
    "but", "yet", "nor", "all", "some", "any", "each", "every", "few",
    "more", "most", "other", "such", "own", "same", "both", "must", "shall",
    "should", "would", "could", "might", "cannot", "ive", "youve", "weve",
    "theyve",
})

# A single-token line that must never be reflowed: markdown structure, bare
# list/quote markers, thematic breaks, and numbered list markers.
_FRAGMENT_LINE_SKIP_START = ("```", "~~~", "#", ">", "|", "`", "~")
_FRAGMENT_LINE_SKIP_RE = re.compile(r"^([-*_=]{2,})$|^[*+]$|^\d+[.)]$")


def _is_fragment_line(stripped: str) -> bool:
    """True when a trimmed line is one atomic streamed token (no internal
    whitespace) that can join its neighbours: word fragments, punctuation,
    digits. Never true for blank lines, fenced content, headings, list markers,
    or thematic breaks."""
    if not stripped or len(stripped) > _FRAGMENT_LINE_MAX:
        return False
    if re.search(r"\s", stripped):
        return False
    if stripped.startswith(_FRAGMENT_LINE_SKIP_START):
        return False
    if _FRAGMENT_LINE_SKIP_RE.search(stripped):
        return False
    return True


def _loose_common_word(word: str) -> bool:
    """True when word is a dictionary word or a simple inflection of one
    ("conflicting" -> conflict, "tasks" -> task, "created" -> create), so a
    fragment run never welds two real words together ("conflicting tasks" must
    not become "conflictingtasks") while still rejoining broken halves like
    "communic" + "ation". Mirrors isLooseCommonWord in
    apps/frontend/src/lib/ai-format.ts."""
    w = re.sub(r"[\u2018\u2019']", "", word.lower())
    if not w:
        return False
    if w in COMMON_WORDS:
        return True
    candidates: list[str] = []
    if w.endswith("ies"):
        candidates.append(w[:-3] + "y")
    if w.endswith("ing"):
        candidates.append(w[:-3])
        candidates.append(w[:-3] + "e")
    if w.endswith("ied"):
        candidates.append(w[:-3] + "y")
    if w.endswith("ed"):
        candidates.append(w[:-2])
        candidates.append(w[:-2] + "e")
    if w.endswith("es"):
        candidates.append(w[:-2])
        candidates.append(w[:-2] + "e")
    elif w.endswith("s"):
        candidates.append(w[:-1])
    return any(len(c) >= 3 and c in COMMON_WORDS for c in candidates)


def _join_separator(prev: str, nxt: str) -> str:
    """Separator between two reflowed tokens: "" when they are one unit
    (skipped-space contraction "don" + "'t", a split dictionary word
    "communic" + "ation", or two non-dictionary fragments that form a word
    "inconven" + "ience"), "-" for dated values (2026 / 09 / 05), and a single
    space otherwise so the per-line repair rules finish the job. Ordinal
    suffixes ("th", "st", "nd", "rd") never absorb a neighbour, and neither do
    inflected/function words that the word list omits ("is an", "has been"):
    those keep the space."""
    if nxt.startswith(("'", "\u2019", "\u2018")):
        return ""
    if prev.endswith("-") or nxt == "-":
        return ""
    if prev in _ORDINAL_SUFFIXES or nxt in _ORDINAL_SUFFIXES:
        return " "
    if re.fullmatch(r"\d{4}", prev) and re.fullmatch(r"\d{2}", nxt):
        return "-"
    if re.fullmatch(r"\d{2}", prev) and re.fullmatch(r"\d{2}", nxt):
        return "-"
    if re.fullmatch(r"[a-z]+", prev) and re.fullmatch(r"[a-z]+", nxt):
        combined = prev + nxt
        if combined in COMMON_WORDS and 4 <= len(combined) <= _FRAGMENT_LINE_MAX:
            return ""
        if (
            prev not in COMMON_WORDS
            and nxt not in COMMON_WORDS
            and not _loose_common_word(prev)
            and not _loose_common_word(nxt)
            and prev not in _INFLECTED_STOP
            and nxt not in _INFLECTED_STOP
            and 4 <= len(combined) <= _FRAGMENT_LINE_MAX
        ):
            return ""
    return " "


def _join_fragment_run(tokens: list[str]) -> str:
    """Join a run of single-token lines into one line, spacing or compressing
    each adjacent pair via _join_separator."""
    result = tokens[0].strip()
    for i in range(1, len(tokens)):
        nxt = tokens[i].strip()
        result += _join_separator(tokens[i - 1].strip(), nxt) + nxt
    return result


def _reflow_single_token_lines(text: str) -> str:
    """Reflow streaming artifacts where the model put each token on its own
    line ("I\\n'm\\nsorry\\n...\\n2\\n4\\nth\\nof\\neach\\nmonth\\n."). Consecutive
    single-token lines (skipping fenced blocks) are joined into one line so the
    per-line repair rules can then fix contractions, ordinals and punctuation.
    Mirrors reflowSingleTokenLines in apps/frontend/src/lib/ai-format.ts."""
    if not text:
        return text
    lines = text.split("\n")
    in_fence = False
    fragment = [False] * len(lines)
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
        elif in_fence:
            continue
        elif _is_fragment_line(stripped):
            fragment[i] = True
    out: list[str] = []
    i = 0
    n = len(lines)
    # Blank-line padding a streaming model leaves inside a one-token-per-line
    # reply is not a paragraph break: "to the\n\n2 4 th" is just noise. A blank
    # block collapses to a space when the previous non-blank line is a fragment
    # that does not end a sentence and the next non-blank line is also a
    # fragment. Real breaks (a sentence end followed by a blank, a blank before
    # a fence/heading/list marker, leading/trailing blanks) are preserved.
    swallowed: list[bool] = [False] * n
    in_fence = False
    for b, line_b in enumerate(lines):
        stripped_b = line_b.strip()
        if stripped_b.startswith("```") or stripped_b.startswith("~~~"):
            in_fence = not in_fence
            continue
        if in_fence or stripped_b:
            continue
        p = b - 1
        while p >= 0 and not lines[p].strip():
            p -= 1
        nx = b + 1
        while nx < n and not lines[nx].strip():
            nx += 1
        if p < 0 or nx >= n:
            continue
        if not fragment[p] or not fragment[nx]:
            continue
        if re.search(r"[.!?:;]$", lines[p].strip()):
            continue
        swallowed[b] = True
    while i < n:
        if not fragment[i]:
            out.append(lines[i])
            i += 1
            continue
        run = [lines[i]]
        j = i + 1
        while j < n:
            if fragment[j]:
                run.append(lines[j])
                j += 1
            elif not lines[j].strip() and swallowed[j]:
                # Transparent padding blank: the run continues across it.
                j += 1
            else:
                break
        out.append(_join_fragment_run(run) if len(run) >= 2 else lines[i])
        i = j
    # Collapse runs of blank lines (outside fenced blocks) to a single
    # paragraph break - streamed tokens often arrive padded with "\n\n\n".
    final: list[str] = []
    prev_blank = False
    in_fence = False
    for line in out:
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            prev_blank = False
            final.append(line)
        elif in_fence:
            final.append(line)
        elif not stripped:
            if not prev_blank:
                prev_blank = True
                final.append(line)
        else:
            prev_blank = False
            final.append(line)
    return "\n".join(final)


def _normalize_reply_markdown(text: str) -> str:
    """Clean up sloppy model output before it is persisted or displayed."""
    if not text:
        return text
    # Reflow one-token-per-line streaming artifacts first so the per-line pass
    # sees real sentences instead of lines that each hold one fragment.
    text = _reflow_single_token_lines(text)

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
        # Fragmented abbreviations: "3 p . m ." -> "3 p.m.", "e . g ." -> "e.g."
        # (the punctuation rule above already reattached the dots, but a space
        # can still sit between the two abbreviation letters).
        line = re.sub(r"(?i)([a-z])\.([ \t]+)([a-z])(?=\.)", lambda m: f"{m.group(1)}.{m.group(3)}", line)
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
    # A date split across a line break ("... 2026 -\n09 - 05") is repaired after
    # the per-line pass so the year and month can finally meet.
    return _repair_line_broken_dates("\n".join(out))


_FRAGMENT_RE = re.compile(r"[A-Za-z]+")


def _repair_line_broken_dates(text: str) -> str:
    """Rejoin an ISO date a model wrapped mid-value ("Due Date: 2026 -\n
    09 - 05"). The per-line pass collapses "09 - 05" -> "09-05", but a year
    stranded at a line end ("2026 -") never meets its month on the same line.
    When a line ends with a 4-digit year plus a dash and the next line starts
    with a two-digit month, join them into one ISO date. Fenced code blocks are
    skipped so literal code never changes. Mirrors repairLineBrokenDates in
    apps/frontend/src/lib/ai-format.ts.
    """
    if not text:
        return text
    lines = text.split("\n")
    skipped: set[int] = set()
    in_fence = False
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            skipped.add(i)
        elif in_fence:
            skipped.add(i)
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        nxt = lines[i + 1] if i + 1 < len(lines) else None
        if nxt is not None and i not in skipped and (i + 1) not in skipped:
            head = re.search(r"([0-9]{4})[ \t]*-[ \t]*$", line)
            tail = re.match(r"[ \t]*-?[ \t]*([0-9]{2})(?=[-\s]|$)", nxt)
            if head and tail:
                joined = head.group(1) + "-" + tail.group(1)
                out.append(line[: head.start()] + joined + nxt[tail.end():])
                i += 2
                continue
        out.append(line)
        i += 1
    return "\n".join(out)


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
    """Reinsert a space in words merged by a dropped space ("Trackand Manage",
    "conflictingtasks").

    Only unknown 6+ letter tokens are candidates, and the split point must
    leave two word halves (dictionary words or simple inflections of them) on
    both sides, so known words like "into" or "alright" are never touched and
    a real standalone inflected word ("conflicting", "changing") never splits.
    The first non-suffix split wins; a trailing "s"/"ed"/"ing" split is only
    used when nothing else fits. Mirrors splitMergedWord in
    apps/frontend/src/lib/ai-format.ts.
    """

    def _repl(m: re.Match) -> str:
        tok = m.group(0)
        lower = tok.lower()
        if lower in COMMON_WORDS or _loose_common_word(lower):
            return tok
        first_valid = -1
        first_clean = -1
        for i in range(4, len(lower) - 1):
            left = lower[:i]
            right = lower[i:]
            if len(left) < 3 or not _loose_common_word(left):
                continue
            if not _loose_common_word(right):
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
