"use client";

import { useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { insertImageAtCursor } from "@/lib/upload";

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

/** A line-start marker for each prefix action. Bullet deliberately excludes the
 * checklist form (`- [ ]`) so the two never shadow each other. */
const MARKER: Partial<Record<MarkdownAction, RegExp>> = {
  heading: /^#{1,6}\s+/,
  bullet: /^[-*+]\s+(?!\[[ xX]\])/,
  checklist: /^[-*+]\s+\[[ xX]\]\s+/,
  numbered: /^\d+\.\s+/,
  quote: /^>\s+/,
};

/** Any line-start marker, used to replace one list/heading kind with another
 * instead of stacking them (`- one` + checklist used to make `- [ ] - one`). */
const ANY_MARKER = /^(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+\.\s+|>\s+)/;

function splitIndent(line: string): { indent: string; body: string } {
  const indent = line.match(/^\s*/)?.[0] ?? "";
  return { indent, body: line.slice(indent.length) };
}

/**
 * Apply one markdown action to a textarea in place. Exported so the toolbar and
 * its tests share exactly one implementation. Inline actions wrap or unwrap the
 * selection (an empty selection inserts a placeholder), prefix actions add or
 * remove a line marker across the selected lines, and code/link insert a fenced
 * block / `[text](url)` pair.
 *
 * Edge cases handled: selecting a whole `**bold**` unwraps instead of nesting;
 * a caret sitting inside `**|**` toggles the markers off; whitespace around a
 * selection is kept outside the emphasis so it still renders; italic never
 * mistakes the outer star of `**bold**` for its own marker; prefix actions
 * replace a conflicting marker, number lists through, recognise every heading
 * level, and keep the user's selection instead of collapsing the caret.
 */
export function applyMarkdownAction(ta: HTMLTextAreaElement, action: MarkdownAction): void {
  const value = ta.value;
  const start = ta.selectionStart ?? value.length;
  const end = ta.selectionEnd ?? start;

  const inline = INLINE[action];
  if (inline) {
    const before = inline.before;
    const after = inline.after;
    const single = before === "*";
    const selected = value.slice(start, end);

    // Markers immediately surrounding the selection (adjacent outside).
    const beforeOk =
      value.slice(start - before.length, start) === before &&
      (!single || value[start - before.length - 1] !== "*");
    const afterOk =
      value.slice(end, end + after.length) === after &&
      (!single || value[end + after.length] !== "*");
    // The selection itself is `before … after`.
    const selfWrapped =
      selected.length >= before.length + after.length &&
      selected.startsWith(before) &&
      selected.endsWith(after) &&
      (!single || (!selected.startsWith("**") && !selected.endsWith("**")));

    if (selected.length === 0) {
      if (beforeOk && afterOk) {
        replaceRange(ta, "", start - before.length, end + after.length);
        return;
      }
      const inserted = `${before}${inline.placeholder}${after}`;
      replaceRange(ta, inserted, start, end, {
        from: before.length,
        to: before.length + inline.placeholder.length,
      });
      return;
    }

    if (beforeOk && afterOk) {
      replaceRange(ta, selected, start - before.length, end + after.length, {
        from: 0,
        to: selected.length,
      });
      return;
    }

    if (selfWrapped) {
      const inner = selected.slice(before.length, selected.length - after.length);
      replaceRange(ta, inner, start, end, { from: 0, to: inner.length });
      return;
    }

    const lead = selected.match(/^\s*/)?.[0] ?? "";
    const trail = selected.match(/\s*$/)?.[0] ?? "";
    const inner = selected.slice(lead.length, selected.length - trail.length);
    if (inner.length === 0) {
      const inserted = `${before}${inline.placeholder}${after}`;
      replaceRange(ta, inserted, start, end, {
        from: before.length,
        to: before.length + inline.placeholder.length,
      });
      return;
    }
    const inserted = `${lead}${before}${inner}${after}${trail}`;
    const from = lead.length + before.length;
    replaceRange(ta, inserted, start, end, { from, to: from + inner.length });
    return;
  }

  if (action === "code") {
    const selected = value.slice(start, end);
    const body = selected || "code";
    const leadNewline = start > 0 && value[start - 1] !== "\n";
    const trailNewline = end < value.length && value[end] !== "\n";
    const inserted = `${leadNewline ? "\n" : ""}\`\`\`\n${body}\n\`\`\`${trailNewline ? "\n" : ""}`;
    const bodyStart = (leadNewline ? 1 : 0) + 4;
    replaceRange(ta, inserted, start, end, selected ? { from: bodyStart, to: bodyStart + body.length } : undefined);
    return;
  }

  if (action === "link") {
    const label = (value.slice(start, end) || "link text").replace(/\]/g, "\\]");
    const inserted = `[${label}](url)`;
    const urlStart = inserted.length - 4;
    replaceRange(ta, inserted, start, end, { from: urlStart, to: urlStart + 3 });
    return;
  }

  const prefix = PREFIX[action];
  const marker = MARKER[action];
  if (prefix !== undefined && marker !== undefined) {
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    let lineEnd = value.indexOf("\n", end);
    if (lineEnd === -1) lineEnd = value.length;
    const lines = value.slice(lineStart, lineEnd).split("\n");
    const nonEmpty = lines.filter((l) => l.trim() !== "");
    const allActive = nonEmpty.length > 0 && nonEmpty.every((l) => marker.test(l));
    let counter = 0;
    const next = lines
      .map((line) => {
        if (line.trim() === "") return line;
        const { indent, body } = splitIndent(line);
        if (allActive) return indent + body.replace(marker, "");
        const cleaned = body.replace(ANY_MARKER, "");
        if (action === "numbered") {
          counter += 1;
          return `${indent}${counter}. ${cleaned}`;
        }
        return `${indent}${prefix}${cleaned}`;
      })
      .join("\n");
    replaceRange(ta, next, lineStart, lineEnd, { from: 0, to: next.length });
  }
}

const ICON_BUTTON =
  "pointer-coarse:h-10 pointer-coarse:w-10 flex h-7 w-7 items-center justify-center rounded-md text-secondary transition-colors hover:bg-hover hover:text-primary disabled:cursor-wait disabled:opacity-60";

const IMAGE_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.5" fill="currentColor" stroke="none" />
    <path d="M21 15l-5-5L5 20" />
  </svg>
);

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
  /**
   * `inline` keeps only single-line formatting (bold, italic, strike, code,
   * link). The image picker stays available because subtasks can carry images
   * in their markdown too; headings and lists remain hidden so a one-line
   * subtask row cannot grow a block layout.
   */
  variant?: "full" | "inline";
}

/**
 * Icon toolbar that inserts markdown into the referenced textarea. Insertion is
 * done through `applyMarkdownAction` (setRangeText), so browser undo keeps
 * working and a controlled React textarea receives the new string via onChange.
 * Buttons prevent the mousedown focus change so the textarea never blurs (which
 * would otherwise commit a blur-to-save edit) before the action runs.
 */
export function MarkdownToolbar({
  textareaRef,
  onChange,
  className,
  variant = "full",
}: MarkdownToolbarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const inline = variant === "inline";
  const actions = inline
    ? ACTIONS.filter((action) =>
        ["bold", "italic", "strikethrough", "code", "link"].includes(action.id)
      )
    : ACTIONS;

  const run = (action: MarkdownAction) => {
    const ta = textareaRef.current;
    if (!ta) return;
    applyMarkdownAction(ta, action);
    onChange(ta.value);
  };

  const handleImage = async (file: File | undefined) => {
    if (!file) return;
    const ta = textareaRef.current;
    if (!ta) return;
    setImageError(null);
    setUploading(true);
    try {
      await insertImageAtCursor(ta, file, onChange);
    } catch (err) {
      setImageError(err instanceof Error ? err.message : "Could not upload that image.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className={`flex flex-wrap items-center gap-0.5 ${className ?? ""}`}
    >
      {actions.map((action) => (
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
      <button
        type="button"
        aria-label={uploading ? "Uploading image" : "Add image"}
        title={uploading ? "Uploading image..." : "Add image (PNG, JPEG, GIF, WebP up to 5 MB)"}
        onMouseDown={(e) => e.preventDefault()}
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className={ICON_BUTTON}
      >
        {uploading ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-spin">
            <path d="M21 12a9 9 0 1 1-6.2-8.56" strokeLinecap="round" />
          </svg>
        ) : (
          IMAGE_ICON
        )}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void handleImage(file);
        }}
      />
      {imageError && (
        <span role="alert" className="basis-full px-1 pt-0.5 text-[10px] text-danger">
          {imageError}
        </span>
      )}
    </div>
  );
}
