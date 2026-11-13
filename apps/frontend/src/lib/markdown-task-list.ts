// Checklist helpers for user-authored markdown (task descriptions and subtask
// text). GitHub-flavoured task list items are `- [ ]` / `- [x]`; the renderer
// shows them as checkboxes, and ticking one has to rewrite exactly that line of
// the source. Kept pure and dependency-free so it can be unit-tested without a
// DOM (see markdown-task-list.test.ts).

/**
 * Matches one task list item line. Leading indentation (up to three spaces) and
 * any `>` quote markers are allowed, so a checklist inside a quote still maps
 * back to its source line.
 */
const TASK_LIST_LINE = /^(\s{0,3}(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/;

/** True when the line is a GFM task list item (`- [ ]` / `- [x]`). */
export function isTaskListLine(line: string): boolean {
  return TASK_LIST_LINE.test(line);
}

/**
 * Line indexes (0-based) of every task list item in `markdown`, in document
 * order. A rendered checkbox has no line number of its own, so the renderer
 * counts checkboxes and uses its ordinal to look the source line up here.
 */
export function taskListLineIndexes(markdown: string): number[] {
  if (!markdown) return [];
  const indexes: number[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (TASK_LIST_LINE.test(lines[i])) indexes.push(i);
  }
  return indexes;
}

/**
 * Set the checkbox on one source line. Returns the original string unchanged
 * when the index is out of range or the line is not a task list item, so a
 * caller can pass a stale index without corrupting the text.
 */
export function toggleTaskListCheckboxAtLine(
  markdown: string,
  lineIndex: number,
  checked: boolean
): string {
  if (!markdown || lineIndex < 0) return markdown;
  const lines = markdown.split("\n");
  const line = lines[lineIndex];
  if (line === undefined) return markdown;
  const next = line.replace(
    TASK_LIST_LINE,
    (_match, prefix: string, _mark: string, close: string) =>
      `${prefix}${checked ? "x" : " "}${close}`
  );
  if (next === line) return markdown;
  lines[lineIndex] = next;
  return lines.join("\n");
}

/**
 * Toggle by checkbox ordinal (the order the rendered checkboxes appear in),
 * which is the only identity a markdown renderer can supply.
 */
export function toggleTaskListCheckbox(
  markdown: string,
  ordinal: number,
  checked: boolean
): string {
  const indexes = taskListLineIndexes(markdown);
  const lineIndex = indexes[ordinal];
  if (lineIndex === undefined) return markdown;
  return toggleTaskListCheckboxAtLine(markdown, lineIndex, checked);
}
