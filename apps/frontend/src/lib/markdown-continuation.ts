// Pressing Enter at the end of a markdown list item should start the next item
// of the same kind, the way every notes app behaves. Two things made that feel
// broken in Prysm Note: a checklist item (`- [ ]`) and a bullet (`- `) both
// looked "done" but Enter produced a plain paragraph, so a user writing a
// checklist had to re-press the toolbar for every line.
//
// This module is the pure half: given the textarea value and the caret it
// returns the rewritten value and the new caret, or `null` when Enter should
// keep its default behaviour. No DOM, no React, so it is unit-tested directly
// (markdown-continuation.test.ts). The editors only call `preventDefault` when
// a non-null result comes back.

export interface Continuation {
  value: string;
  /** Caret offset in `value` after the new marker. */
  caret: number;
}

/** `- [ ] text`, `* [x] text`, `1. [ ] text`, with optional indent and quotes. */
const TASK_ITEM = /^((?:[ \t]*(?:>[ \t]?)*)?)([-*+]|\d+[.)])([ \t]+)\[([ xX])\]([ \t]+)(.*)$/;
/** `- text`, `* text`, `+ text`, `1. text`, with optional indent and quotes. */
const LIST_ITEM = /^((?:[ \t]*(?:>[ \t]?)*)?)([-*+]|\d+[.)])([ \t]+)(.*)$/;
/** `> text` and nested quotes. */
const QUOTE_ITEM = /^((?:[ \t]*>[ \t]?)+)(.*)$/;

function lineBounds(value: string, caret: number): { start: number; end: number; line: string } {
  const start = value.lastIndexOf("\n", caret - 1) + 1;
  const newline = value.indexOf("\n", caret);
  const end = newline === -1 ? value.length : newline;
  return { start, end, line: value.slice(start, end) };
}

function nextOrderedMarker(marker: string): string {
  const match = marker.match(/^(\d+)([.)])$/);
  if (!match) return marker;
  return `${Number(match[1]) + 1}${match[2]}`;
}

/** The marker a new line should start with, or `null` for non-list lines. */
function continuationPrefix(line: string): { prefix: string; body: string } | null {
  const task = line.match(TASK_ITEM);
  if (task) {
    const [, indent, marker, gap, , space] = task;
    return {
      prefix: `${indent}${nextOrderedMarker(marker)}${gap}[ ]${space}`,
      body: task[6],
    };
  }
  const list = line.match(LIST_ITEM);
  if (list) {
    const [, indent, marker, gap] = list;
    return { prefix: `${indent}${nextOrderedMarker(marker)}${gap}`, body: list[4] };
  }
  const quote = line.match(QUOTE_ITEM);
  if (quote) {
    const [, indent] = quote;
    return { prefix: `${indent}`, body: quote[2] };
  }
  return null;
}

/** Remove the list/quote marker from a line (used to end a list on Enter). */
function stripPrefix(line: string): string | null {
  const task = line.match(TASK_ITEM);
  if (task) return `${task[1]}${task[6]}`;
  const list = line.match(LIST_ITEM);
  if (list) return `${list[1]}${list[4]}`;
  const quote = line.match(QUOTE_ITEM);
  if (quote) return `${quote[1].replace(/>[ \t]?$/, "")}${quote[2]}`;
  return null;
}

/**
 * Handle Enter inside a markdown list.
 *
 * - On a non-empty item: insert a newline plus the next marker.
 * - On an empty item (the user pressed Enter twice): drop the marker so the
 *   list ends instead of growing forever.
 * - Anywhere else (plain paragraph, mid-selection, or a caret outside the
 *   current line): return `null` and let the textarea do its normal thing.
 */
export function continueMarkdownList(
  value: string,
  selectionStart: number,
  selectionEnd: number = selectionStart
): Continuation | null {
  if (selectionStart !== selectionEnd) return null;
  const caret = Math.max(0, Math.min(selectionStart, value.length));
  const { start, end, line } = lineBounds(value, caret);
  const found = continuationPrefix(line);
  if (!found) return null;

  if (found.body.trim() === "") {
    // Empty item: remove the marker and keep the caret where the marker began.
    const stripped = stripPrefix(line);
    if (stripped === null) return null;
    const nextValue = value.slice(0, start) + stripped + value.slice(end);
    return { value: nextValue, caret: start + stripped.length };
  }

  const insertion = `\n${found.prefix}`;
  // Splitting a line right before a word's leading space should not carry that
  // space into the new item ("alpha |beta" -> "beta", not " beta").
  const skip = value[caret] === " " ? 1 : 0;
  const nextValue = value.slice(0, caret) + insertion + value.slice(caret + skip);
  return { value: nextValue, caret: caret + insertion.length };
}
