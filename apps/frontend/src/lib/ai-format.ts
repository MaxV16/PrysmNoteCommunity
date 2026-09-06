// Cleanup for AI assistant replies so they render as real markdown.
//
// Some providers write emphasis with stray spaces ("** what should the task
// be ?**" or "* x *") which never renders as markdown, and insert spaces around
// punctuation ("e .g .", "daily ,", "I 'll"). This mirrors the backend
// _normalize_reply_markdown (app/routers/ai.py) so the live stream and the
// persisted history both display cleanly.

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

export function normalizeAssistantMarkdown(text: string): string {
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
      return s;
    })
    .join("\n");
}
