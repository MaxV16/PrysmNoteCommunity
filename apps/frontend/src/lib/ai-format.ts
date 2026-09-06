// Cleanup for AI assistant replies so they render as real markdown.
//
// Some providers write emphasis with stray spaces ("** what should the task
// be ?**" or "* x *") which never renders as markdown, and insert spaces around
// punctuation ("e .g .", "daily ,", "I 'll"). Others stream fragmented BPE
// tokens that split words ("Fin ance") or merge them ("Trackand Manage").
// This mirrors the backend _normalize_reply_markdown (app/services/ai_shared.py)
// so the live stream and the persisted history both display cleanly.

import { COMMON_WORDS } from "./common-words";

const TOOL_CALL_MARKER = "[TOOL_CALLS]";

// Finds the matching close for the first JSON object in `rest` (which must
// start at the opening brace). Braces inside JSON string values are ignored so
// nested objects survive. Returns the index of the closing brace or -1 when
// the block is incomplete (mid-stream).
function findJsonClose(rest: string): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Removes "[TOOL_CALLS] name {json}" blocks so raw tool-call JSON never
// reaches the user. Incomplete blocks (the closing brace has not streamed yet)
// are kept as-is so a partial never corrupts the running text. Mirrors the
// backend _strip_text_tool_calls.
export function stripTextToolCalls(text: string): string {
  if (!text || !text.includes(TOOL_CALL_MARKER)) return text;
  const out: string[] = [];
  let rest = text;
  while (true) {
    const idx = rest.indexOf(TOOL_CALL_MARKER);
    if (idx === -1) {
      out.push(rest);
      break;
    }
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + TOOL_CALL_MARKER.length);
    const nameMatch = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)/.exec(rest);
    if (!nameMatch) {
      out.push(TOOL_CALL_MARKER);
      continue;
    }
    const name = nameMatch[2];
    rest = rest.slice(nameMatch[0].length);
    const ob = rest.indexOf("{");
    if (ob === -1) {
      out.push(TOOL_CALL_MARKER + nameMatch[0] + rest);
      break;
    }
    rest = rest.slice(ob);
    const close = findJsonClose(rest);
    if (close === -1) {
      // Incomplete block: keep it whole so a mid-stream partial never corrupts
      // the running text (the closing brace may arrive in the next chunk).
      out.push(TOOL_CALL_MARKER + nameMatch[0] + rest);
      break;
    }
    rest = rest.slice(close + 1);
  }
  return out.join("");
}

function stripDelimiterSpacing(line: string, marker: string): string {
  const positions: number[] = [];
  let i = 0;
  while (true) {
    const idx = line.indexOf(marker, i);
    if (idx === -1) break;
    positions.push(idx);
    i = idx + marker.length;
  }
  for (let p = 0; p < positions.length - 1; p += 2) {
    let openIdx = positions[p];
    let closeIdx = positions[p + 1];
    if ((marker === "*" || marker === "-") && line.slice(0, openIdx).trim() === "") {
      continue;
    }
    const afterOpen = openIdx + marker.length;
    if (afterOpen < line.length && /\s/.test(line[afterOpen])) {
      line = line.slice(0, afterOpen) + line.slice(afterOpen).replace(/^\s+/, "");
      closeIdx = line.indexOf(marker, afterOpen);
      if (closeIdx === -1) break;
    }
    const beforeClose = closeIdx;
    let k = beforeClose - 1;
    while (k >= 0 && /\s/.test(line[k])) k -= 1;
    if (k !== beforeClose - 1) {
      line = line.slice(0, k + 1) + line.slice(beforeClose);
    }
  }
  return line;
}

function joinSplitHexRun(line: string): string {
  // Rejoin streaming artifacts like "3 5 8 b 2 5 0 b" (single hex chars
  // separated by spaces) into "358b250b", and "4 0 d 8 -b 9 5 0" -> "40d8-b950".
  // Only runs of 6+ single-character hex tokens (dash-prefixed tokens allowed
  // so UUID dashes survive) are touched, and only when the run also contains a
  // digit - so ordinary words can never be collapsed ("a b c" stays intact).
  return line.replace(/\b-?[0-9a-fA-F](?: -?[0-9a-fA-F]){5,}\b/g, (m) => {
    const tokens = m.split(" ");
    const hasDigit = tokens.some((t) => /[0-9]/.test(t));
    return hasDigit ? tokens.join("") : m;
  });
}

// Dictionary-based repair for words split by fragmented streaming.
//
// A "fragment run" is a maximal sequence of pure-letter tokens where each
// consecutive pair is separated by whitespace only. Tokens that the earlier
// rules merged punctuation into ("(tom", "tasks:") still take part: only the
// letters are rejoined and the punctuation shell is preserved.
//
// Rejoin rule for a run:
//   1. Longest prefix that is a dictionary word (4..24 chars) coming right
//      before a standalone dictionary word takes priority, so "Pr ys m Note"
//      becomes "Prysm Note" (never "Prysmnote").
//   2. Otherwise the whole run rejoins when its joined form is a dictionary
//      word and at least one fragment is not ("Fin ance" -> "Finance",
//      "tom orrow" -> "tomorrow"). When every fragment is a dictionary word
//      ("in to", "new house") the run is left intact.
function isValidJoin(tokens: string[], i: number, k: number): boolean {
  const joined = tokens.slice(i, i + k).join("");
  if (joined.length < 4 || joined.length > 24) return false;
  if (!COMMON_WORDS.has(joined.toLowerCase())) return false;
  for (let t = i; t < i + k; t++) {
    if (!COMMON_WORDS.has(tokens[t].toLowerCase())) return true;
  }
  return false;
}

function rejoinLength(tokens: string[], i: number): number {
  const n = tokens.length;
  // Longest prefix that ends right before a standalone dictionary word.
  for (let k = Math.min(n - i - 1, 24); k >= 2; k--) {
    if (isValidJoin(tokens, i, k) && COMMON_WORDS.has(tokens[i + k].toLowerCase())) {
      return k;
    }
  }
  // Whole-run fallback (covers "Fin ance", "tom orrow", "go ing").
  for (let k = Math.min(n - i, 24); k >= 2; k--) {
    if (isValidJoin(tokens, i, k)) return k;
  }
  return 0;
}

function rejoinRun(tokens: string[], gaps: string[]): string {
  let result = "";
  let i = 0;
  let prevEnd = -1;
  while (i < tokens.length) {
    const gap = prevEnd === -1 ? "" : gaps[prevEnd];
    const k = rejoinLength(tokens, i);
    if (k >= 2) {
      result += gap + tokens.slice(i, i + k).join("");
      prevEnd = i + k - 1;
      i += k;
    } else {
      result += gap + tokens[i];
      prevEnd = i;
      i += 1;
    }
  }
  return result;
}

function rejoinWordFragments(line: string): string {
  const fragRe = /[A-Za-z]+/g;
  const items: Array<{ start: number; end: number; word: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = fragRe.exec(line)) !== null) {
    items.push({ start: m.index, end: m.index + m[0].length, word: m[0] });
  }
  if (items.length < 2) return line;

  const out: string[] = [];
  let pos = 0;
  let i = 0;
  while (i < items.length) {
    let j = i + 1;
    while (j < items.length && /^[ \t]*$/.test(line.slice(items[j - 1].end, items[j].start))) {
      j += 1;
    }
    const run = items.slice(i, j);
    out.push(line.slice(pos, run[0].start));
    if (run.length === 1) {
      out.push(run[0].word);
    } else {
      const tokens = run.map((it) => it.word);
      const gaps = run.slice(0, -1).map((it, k) => line.slice(it.end, run[k + 1].start));
      out.push(rejoinRun(tokens, gaps));
    }
    pos = run[run.length - 1].end;
    i = j;
  }
  out.push(line.slice(pos));
  return out.join("");
}

const NO_BREAK_HYPHEN = "\u2011";

const FRAGMENT_LINE_MAX = 24;
const FRAGMENT_LINE_SKIP_START = ["```", "~~~", "#", ">", "|", "`", "~"];
const FRAGMENT_LINE_SKIP_RE = /^([-*_=]{2,})$|^[*+]$|^\d+[.)]$/;
const ORDINAL_SUFFIXES = new Set(["st", "nd", "rd", "th"]);

// Inflected and function words the Oxford-3000-based COMMON_WORDS omits (it
// stores base forms like "be" not "is/was/been"). These must never absorb a
// neighbour, so "is an" and "has been" keep their space even though none of
// the tokens are dictionary words.
const INFLECTED_STOP = new Set([
  "i", "is", "am", "are", "was", "were", "been", "has", "had", "does",
  "did", "you", "we", "they", "he", "she", "me", "him", "her", "us",
  "them", "my", "our", "your", "their", "this", "that", "these", "those",
  "who", "whom", "whose", "which", "what", "when", "where", "why", "how",
  "than", "then", "now", "here", "there", "not", "no", "yes", "so", "if",
  "but", "yet", "nor", "all", "some", "any", "each", "every", "few",
  "more", "most", "other", "such", "own", "same", "both", "must", "shall",
  "should", "would", "could", "might", "cannot", "ive", "youve", "weve",
  "theyve",
]);

// A trimmed line is one atomic streamed token when it has no internal
// whitespace: a word fragment, a punctuation mark, or digits. Such lines can
// join their neighbours. Blank lines, fenced content, headings, list markers,
// and thematic breaks never can.
function isFragmentLine(stripped: string): boolean {
  if (!stripped || stripped.length > FRAGMENT_LINE_MAX) return false;
  if (/\s/.test(stripped)) return false;
  if (FRAGMENT_LINE_SKIP_START.some((m) => stripped.startsWith(m))) return false;
  if (FRAGMENT_LINE_SKIP_RE.test(stripped)) return false;
  return true;
}

// Separator between two reflowed tokens: "" when they are one unit
// (skipped-space contraction "don" + "'t", or a split dictionary word
// "communic" + "ation"), "-" for dated values (2026 / 09 / 05), and a single
// space otherwise so the per-line repair rules finish the job. Ordinal
// suffixes ("th", "st", "nd", "rd") are not dictionary words and never absorb
// a neighbour: keep the space so the per-line rule can join them to the
// number ("24 th" -> "24th").
function joinSeparator(prev: string, nxt: string): string {
  if (nxt.startsWith("'") || nxt.startsWith("\u2019") || nxt.startsWith("\u2018")) return "";
  if (prev.endsWith("-") || nxt === "-") return "";
  if (ORDINAL_SUFFIXES.has(prev) || ORDINAL_SUFFIXES.has(nxt)) return " ";
  if (/^\d{4}$/.test(prev) && /^\d{2}$/.test(nxt)) return "-";
  if (/^\d{2}$/.test(prev) && /^\d{2}$/.test(nxt)) return "-";
  if (/^[a-z]+$/.test(prev) && /^[a-z]+$/.test(nxt)) {
    const combined = prev + nxt;
    if (COMMON_WORDS.has(combined) && combined.length >= 4 && combined.length <= FRAGMENT_LINE_MAX) {
      return "";
    }
    if (
      !COMMON_WORDS.has(prev) &&
      !COMMON_WORDS.has(nxt) &&
      !INFLECTED_STOP.has(prev) &&
      !INFLECTED_STOP.has(nxt) &&
      combined.length >= 4 &&
      combined.length <= FRAGMENT_LINE_MAX
    ) {
      return "";
    }
  }
  return " ";
}

function joinFragmentRun(tokens: string[]): string {
  let result = tokens[0].trim();
  for (let i = 1; i < tokens.length; i++) {
    const nxt = tokens[i].trim();
    result += joinSeparator(tokens[i - 1].trim(), nxt) + nxt;
  }
  return result;
}

// Reflow streaming artifacts where the model put each token on its own line
// ("I\n'm\nsorry\n...\n2\n4\nth\nof\neach\nmonth\n."). Consecutive single-
// token lines (skipping fenced blocks) are joined into one line so the
// per-line repair rules can then fix contractions, ordinals and punctuation.
// Mirrors _reflow_single_token_lines in app/services/ai_shared.py.
export function reflowSingleTokenLines(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  const fragment: boolean[] = new Array(lines.length).fill(false);
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      inFence = !inFence;
    } else if (inFence) {
      continue;
    } else if (isFragmentLine(stripped)) {
      fragment[i] = true;
    }
  }
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!fragment[i]) {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    const run = [lines[i]];
    let j = i + 1;
    while (j < lines.length && fragment[j]) {
      run.push(lines[j]);
      j += 1;
    }
    out.push(run.length >= 2 ? joinFragmentRun(run) : lines[i]);
    i = j;
  }
  // Collapse runs of blank lines (outside fenced blocks) to a single
  // paragraph break - streamed tokens often arrive padded with "\n\n\n".
  const final: string[] = [];
  let prevBlank = false;
  inFence = false;
  for (const line of out) {
    const stripped = line.trim();
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      inFence = !inFence;
      prevBlank = false;
      final.push(line);
    } else if (inFence) {
      final.push(line);
    } else if (!stripped) {
      if (!prevBlank) {
        prevBlank = true;
        final.push(line);
      }
    } else {
      prevBlank = false;
      final.push(line);
    }
  }
  return final.join("\n");
}

// Repair a date that a model wrapped mid-value, e.g. "Due Date : 2026 -\n
// 09 - 05". The per-line pass already collapses "09 - 05" -> "09-05", but a
// year stranded at the end of a line ("2026 -") can never meet its month on
// the same line. When a line ends with a 4-digit year followed by a dash and
// the next line starts with a two-digit month, rejoin them as a single
// ISO date. Fenced code blocks are skipped so literal code never changes.
function repairLineBrokenDates(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  const skipped = new Set<number>();
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      inFence = !inFence;
      skipped.add(i);
    } else if (inFence) {
      skipped.add(i);
    }
  }
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const next = lines[i + 1];
    if (next !== undefined && !skipped.has(i) && !skipped.has(i + 1)) {
      const head = /([0-9]{4})[ \t]*-[ \t]*$/.exec(line);
      const tail = /^[ \t]*-?[ \t]*([0-9]{2})(?=[-\s]|$)/.exec(next);
      if (head && tail) {
        const joined = head[1] + "-" + tail[1];
        out.push(line.slice(0, head.index) + joined + next.slice(tail[0].length));
        i += 2;
        continue;
      }
    }
    out.push(line);
    i += 1;
  }
  return out.join("\n");
}

// Render-time guard against a date wrapping mid-value: replaces the hyphens in
// "YYYY-MM-DD" with non-breaking hyphens so CSS can never break the date into
// "2026-" / "09-" / "05". Display-only - the persisted message keeps plain
// hyphens (which the backend parses), and genuinely separate lines stay lines.
export function protectDateLineBreaks(text: string): string {
  if (!text) return text;
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      const stripped = line.trim();
      if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line.replace(
        /\b([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})\b/g,
        (_m, y: string, mo: string, d: string) => `${y}${NO_BREAK_HYPHEN}${mo}${NO_BREAK_HYPHEN}${d}`
      );
    })
    .join("\n");
}

// Dictionary-based repair for words merged by a dropped space ("Trackand
// Manage"). Only unknown 6+ letter tokens are candidates, and the split point
// must leave two dictionary-word halves on both sides, so known words like
// "into" or "alright" are never touched. The first non-suffix split wins;
// a trailing "s"/"ed"/"ing" split is only used when nothing else fits.
function splitMergedWord(line: string): string {
  return line.replace(/[A-Za-z]{6,}/g, (tok) => {
    const lower = tok.toLowerCase();
    if (COMMON_WORDS.has(lower)) return tok;
    let firstValid = -1;
    let firstClean = -1;
    for (let i = 4; i <= lower.length - 2; i++) {
      const right = lower.slice(i);
      if (!COMMON_WORDS.has(lower.slice(0, i))) continue;
      if (!COMMON_WORDS.has(right)) continue;
      if (firstValid === -1) firstValid = i;
      if (right !== "s" && right !== "ed" && right !== "ing") {
        firstClean = i;
        break;
      }
    }
    const splitAt = firstClean !== -1 ? firstClean : firstValid;
    if (splitAt === -1) return tok;
    return tok.slice(0, splitAt) + " " + tok.slice(splitAt);
  });
}

export function normalizeAssistantMarkdown(text: string): string {
  if (!text) return text;
  // Reflow one-token-per-line streaming artifacts first so the per-line pass
  // sees real sentences instead of lines that each hold one fragment.
  text = reflowSingleTokenLines(text);
  let inFence = false;
  const cleaned = text
    .split("\n")
    .map((line) => {
      const stripped = line.trim();
      if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      let s = line;
      // Space before punctuation: "e .g ." -> "e.g.", "daily ," -> "daily,".
      // "]" and "}" are excluded so GFM checkboxes "[ ]" stay intact.
      s = s.replace(/[ \t]+([,.;:?!>)])/g, "$1");
      // Space after an opening bracket/paren: "( e" -> "(e". An empty-bracket
      // checkbox "[ ]" is left alone (valid GFM task-list syntax).
      s = s.replace(/([(\[{<])[ \t]+(?![\]}])/g, "$1");
      // Contractions with a stray space: "I 'll" -> "I'll", "can 't" -> "can't",
      // "don ’t" -> "don’t", "I ’ ll" -> "I’ll". The apostrophe sits right after
      // the word, so contractions are fixed even mid-sentence; the suffix must
      // be 1-3 letters, so quoted words like "said 'hello'" are never collapsed.
      s = s.replace(
        /(\w+)[ \t]+([’'‘])[ \t]*(\w{1,3})\b/g,
        (_m, word, q, suffix) => word + q + suffix
      );
      // Spaces hugging quotes: " Work " -> "Work". The closing quote must be
      // followed by whitespace/punctuation (really ends the phrase), so a
      // clean pair next to the next opening quote ("Work" and " second ") is
      // never collapsed into a bogus padded pair.
      s = s.replace(
        /(?<![0-9A-Za-z])(["“”])[ \t]+(?=\S)([^\s"“”][^"“”\n]*?)[ \t]+(["“”])(?=\s|["",.;:!?)\]%>]|$)/g,
        (_m, openQ, content, closeQ) => openQ + content.trimEnd() + closeQ
      );
      // UUID/hex artifacts from sloppy model streaming, before the digit-join
      // below (which would first merge "3 5 8" and break the hex run).
      s = joinSplitHexRun(s);
      // Number/time artifacts from sloppy model streaming: stray spaces split
      // digits, ordinals, ranges and clock times ("4 - 12", "May 29th, 2027",
      // "4pm"). Handles en/em dash spacing too.
      // Number ranges: "4 - 12" / "4- 12" / "4\u201312" -> "4-12".
      s = s.replace(/(\d)[ \t]*[\u2013\u2014-][ \t]*(\d)/g, "$1-$2");
      // Split digits: "2 0 2 7" -> "2027", "May 2 9 th" -> "May 29 th".
      s = s.replace(/(\d)[ \t]+(?=\d)/g, "$1");
      // Ordinal suffixes: "2 9 th" -> "29th" (after the digit join above).
      s = s.replace(/(\d)[ \t]+(?=(?:st|nd|rd|th)\b)/gi, "$1");
      // 12-hour clock: "4 pm" -> "4pm".
      s = s.replace(/(\d)[ \t]+(?=(?:am|pm)\b)/gi, "$1");
      // Emphasis/code delimiters written with stray spaces around the inner text.
      for (const marker of ["**", "__", "*", "_", "`"]) {
        s = stripDelimiterSpacing(s, marker);
      }
      // A word split around a hyphen by a dropped/spurious space ("hyper -int",
      // "hyper- int", "hyper - int") collapses to the compound ("hyper-int").
      // Only when at least one side is NOT a dictionary word (a streaming
      // fragment), so a deliberate spaced dash clause ("mean - it works")
      // survives untouched.
      s = s.replace(/([A-Za-z]+)[ \t]*-[ \t]*([A-Za-z]+)/g, (_m, a, b) => {
        if (COMMON_WORDS.has(a.toLowerCase()) && COMMON_WORDS.has(b.toLowerCase())) return _m;
        return `${a}-${b}`;
      });
      // Words split by fragmented streaming ("Fin ance", "Pr ys m Note") and
      // words merged by dropped spaces ("Trackand Manage"). Runs with digits or
      // punctuation were already cleaned above; only pure-letter runs are tried.
      s = rejoinWordFragments(s);
      s = splitMergedWord(s);
      return s;
    })
    .join("\n");
  // A date split across a line break ("... 2026 -\n09 - 05") is repaired after
  // the per-line pass so the year and month can finally meet.
  return repairLineBrokenDates(cleaned);
}
