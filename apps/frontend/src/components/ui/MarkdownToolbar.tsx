"use client";

import type { ReactNode, RefObject } from "react";

export type MarkdownAction =
  | "bold"
  | "italic"
  | "strikethrough"
  | "heading"
  | "bullet"
  | "numbered"
  | "checklist"
  | "quote"
  | "code"
  | "link";

const INLINE: Partial<Record<MarkdownAction, { before: string; after: string; placeholder: string }>> = {
  bold: { before: "**", after: "**", placeholder: "bold text" },
  italic: { before: "*", after: "*", placeholder: "italic text" },
  strikethrough: { before: "~~", after: "~~", placeholder: "strikethrough" },
};

const PREFIX: Partial<Record<MarkdownAction, string>> = {
  heading: "## ",
  bullet: "- ",
  numbered: "1. ",
  checklist: "- [ ] ",
  quote: "> ",
};

/** Replace a range through setRangeText so the browser's native undo still works. */
function replaceRange(
  ta: HTMLTextAreaElement,
  text: string,
  start: number,
  end: number,
  select?: { from: number; to: number }
) {
  if (typeof ta.setRangeText === "function") {
    ta.setRangeText(text, start, end, "end");
  } else {
    ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
  }
  if (select) {
    ta.setSelectionRange?.(start + select.from, start + select.to);
  }
  ta.focus?.();
}

/**
 * Apply one markdown action to a textarea in place. Exported so the toolbar and
 * its tests share exactly one implementation. Inline actions wrap/ unwrap the
 * selection (an empty selection inserts a placeholder), prefix actions add or
 * remove a line marker across the selected lines, and code/link insert a
 * fenced block / `[text](url)` pair.
 */
export function applyMarkdownAction(ta: HTMLTextAreaElement, action: MarkdownAction): void {
  const value = ta.value;
  const start = ta.selectionStart ?? value.length;
  const end = ta.selectionEnd ?? start;

  const inline = INLINE[action];
  if (inline) {
    const selected = value.slice(start, end);
    const text = selected || inline.placeholder;
    const beforeStart = start - inline.before.length;
    const afterEnd = end + inline.after.length;
    const alreadyWrapped =
      selected.length > 0 &&
      value.slice(beforeStart, start) === inline.before &&
      value.slice(end, afterEnd) === inline.after;
    if (alreadyWrapped) {
      replaceRange(ta, text, beforeStart, afterEnd, { from: 0, to: text.length });
    } else {
      const inserted = `${inline.before}${text}${inline.after}`;
      replaceRange(ta, inserted, start, end, {
        from: inline.before.length,
        to: inline.before.length + text.length,
      });
    }
    return;
  }

  if (action === "code") {
    const body = value.slice(start, end) || "code";
    const block = `\`\`\`\n${body}\n\`\`\``;
    replaceRange(ta, block, start, end);
    return;
  }

  if (action === "link") {
    const label = value.slice(start, end) || "link text";
    const inserted = `[${label}](url)`;
    const urlStart = label.length + 3;
    replaceRange(ta, inserted, start, end, { from: urlStart, to: urlStart + 3 });
    return;
  }

  const prefix = PREFIX[action];
  if (prefix !== undefined) {
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    let lineEnd = value.indexOf("\n", end);
    if (lineEnd === -1) lineEnd = value.length;
    const lines = value.slice(lineStart, lineEnd).split("\n");
    const nonEmpty = lines.filter((l) => l.trim() !== "");
    const allPrefixed = nonEmpty.length > 0 && nonEmpty.every((l) => l.startsWith(prefix));
    const next = lines
      .map((line) => {
        if (line.trim() === "") return line;
        if (allPrefixed) return line.startsWith(prefix) ? line.slice(prefix.length) : line;
        return line.startsWith(prefix) ? line : prefix + line;
      })
      .join("\n");
    replaceRange(ta, next, lineStart, lineEnd);
  }
}

const ICON_BUTTON =
  "pointer-coarse:h-10 pointer-coarse:w-10 flex h-7 w-7 items-center justify-center rounded-md text-secondary transition-colors hover:bg-hover hover:text-primary";

const ACTIONS: { id: MarkdownAction; label: string; icon: ReactNode }[] = [
  { id: "bold", label: "Bold", icon: <span className="text-[12px] font-bold">B</span> },
  { id: "italic", label: "Italic", icon: <span className="text-[12px] font-semibold italic">I</span> },
  {
    id: "strikethrough",
    label: "Strikethrough",
    icon: <span className="text-[12px] font-semibold line-through">S</span>,
  },
  { id: "heading", label: "Heading", icon: <span className="text-[12px] font-bold">H</span> },
  {
    id: "bullet",
    label: "Bullet list",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="5" cy="7" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
        <circle cx="5" cy="17" r="1.4" fill="currentColor" stroke="none" />
        <line x1="10" y1="7" x2="20" y2="7" />
        <line x1="10" y1="12" x2="20" y2="12" />
        <line x1="10" y1="17" x2="20" y2="17" />
      </svg>
    ),
  },
  { id: "numbered", label: "Numbered list", icon: <span className="text-[11px] font-semibold">1.</span> },
  {
    id: "checklist",
    label: "Checklist",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="8" height="8" rx="1.5" />
        <polyline points="5 8 6.5 9.5 9.5 6.5" />
        <line x1="14" y1="8" x2="21" y2="8" />
      </svg>
    ),
  },
  { id: "quote", label: "Quote", icon: <span className="text-[14px] font-semibold leading-none">&#8220;</span> },
  { id: "code", label: "Code block", icon: <span className="text-[10px] font-semibold">&lt;/&gt;</span> },
  {
    id: "link",
    label: "Link",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11 5" />
        <path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L13 19" />
      </svg>
    ),
  },
];

interface MarkdownToolbarProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (next: string) => void;
  className?: string;
}

/**
 * Icon toolbar that inserts markdown into the referenced textarea. Insertion is
 * done through `applyMarkdownAction` (setRangeText), so browser undo keeps
 * working and a controlled React textarea receives the new string via onChange.
 * Buttons prevent the mousedown focus change so the textarea never blurs (which
 * would otherwise commit a blur-to-save edit) before the action runs.
 */
export function MarkdownToolbar({ textareaRef, onChange, className }: MarkdownToolbarProps) {
  const run = (action: MarkdownAction) => {
    const ta = textareaRef.current;
    if (!ta) return;
    applyMarkdownAction(ta, action);
    onChange(ta.value);
  };

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className={`flex flex-wrap items-center gap-0.5 ${className ?? ""}`}
    >
      {ACTIONS.map((action) => (
        <button
          key={action.id}
          type="button"
          aria-label={action.label}
          title={action.label}
          onMouseDown={(e) => e.preventDefault()}
          onPointerDown={(e) => e.preventDefault()}
          onClick={() => run(action.id)}
          className={ICON_BUTTON}
        >
          {action.icon}
        </button>
      ))}
    </div>
  );
}
