// Cleanup for AI assistant replies so they render as real markdown.
//
// Some providers write emphasis with stray spaces ("** what should the task
// be ?**" or "* x *") which never renders as markdown, and insert spaces around
// punctuation ("e .g .", "daily ,", "I 'll"). This mirrors the backend
// _normalize_reply_markdown (app/routers/ai.py) so the live stream and the
// persisted history both display cleanly.

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
      // Contractions: "I 'll" -> "I'll", "don 't" -> "don't".
      s = s.replace(/\b(\w) '(\w)/g, "$1'$2");
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
