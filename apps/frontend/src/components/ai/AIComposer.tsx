"use client";

import { useRef, useState, useEffect, type ReactNode } from "react";

interface AIComposerProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  isLoading?: boolean;
  hasUndo?: boolean;
  onAbort?: () => void;
  onUndo?: () => void;
  additionalAction?: ReactNode;
  /** External components (e.g. speech-to-text) register an insert fn that
   *  APPENDS text to whatever is already in the composer (with spacing) and
   *  focuses the textarea, so voice dictation keeps building on the draft. */
  onRegisterInsert?: (insert: (text: string) => void) => void;
}

const MAX_LENGTH = 2000;

// A small, curated set: the emoji people actually send in a note app. Kept
// inline (no icon library) per the repo's assets/licensing rules.
const EMOJI = [
  "😀", "😂", "🙂", "😍", "👍", "🙏",
  "🎉", "🔥", "✅", "❌", "❤️", "💡",
  "📌", "⏰", "🚀", "✨", "😅", "🤔",
  "👀", "💪", "📝", "⭐", "☕", "🌙",
];

export function AIComposer({
  onSend,
  disabled,
  isLoading,
  hasUndo,
  onAbort,
  onUndo,
  additionalAction,
  onRegisterInsert,
}: AIComposerProps) {
  const [input, setInput] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const emojiPopoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!onRegisterInsert) return;
    onRegisterInsert((text: string) => {
      setInput((prev) => {
        const sep = prev && !prev.endsWith(" ") && !prev.endsWith("\n") ? " " : "";
        return (prev + sep + text).slice(0, MAX_LENGTH);
      });
      textareaRef.current?.focus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 132) + "px";
  }, [input]);

  // Escape or an outside click closes the emoji picker.
  useEffect(() => {
    if (!emojiOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        emojiPopoverRef.current &&
        !emojiPopoverRef.current.contains(e.target as Node) &&
        !emojiButtonRef.current?.contains(e.target as Node)
      ) {
        setEmojiOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEmojiOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [emojiOpen]);

  /** Insert at the caret through setRangeText so browser undo keeps working. */
  const insertAtCaret = (text: string) => {
    const el = textareaRef.current;
    if (!el) {
      setInput((prev) => (prev + text).slice(0, MAX_LENGTH));
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    if (typeof el.setRangeText === "function") {
      el.setRangeText(text, start, end, "end");
    } else {
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
    }
    setInput(el.value.slice(0, MAX_LENGTH));
    el.focus();
  };

  const submit = () => {
    if (!input.trim() || disabled) return;
    onSend(input.trim());
    setInput("");
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const remaining = MAX_LENGTH - input.length;
  const nearLimit = remaining < 100;

  return (
    <div className="border-t border-border bg-surface/90 px-3 pb-3 pt-2.5">
      <div className="flex items-center gap-1.5 pb-1.5">
        {isLoading && (
          <button
            onClick={onAbort}
            className="inline-flex items-center gap-1.5 rounded-full bg-danger/10 px-2.5 py-1 text-[11px] font-medium text-danger hover:bg-danger/20"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
            Stop
          </button>
        )}
        {hasUndo && (
          <button
            onClick={onUndo}
            className="inline-flex items-center gap-1.5 rounded-full bg-elevated px-2.5 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            Undo
          </button>
        )}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); submit(); }}
        className="flex items-end gap-2 rounded-2xl border border-border bg-elevated p-2 focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15"
      >
        <textarea
          id="ai-input"
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value.slice(0, MAX_LENGTH))}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder="Ask Prysm Note…"
          disabled={disabled}
          className="max-h-[132px] min-h-[24px] flex-1 resize-none bg-transparent px-1.5 py-1 text-sm leading-relaxed text-primary placeholder:text-muted outline-none"
        />
        <div className="flex shrink-0 items-center gap-1">
          {input.length > 0 && (
            <span className={`pr-0.5 text-[10px] tabular-nums ${nearLimit ? "text-warning" : "text-muted"}`}>
              {remaining}
            </span>
          )}
          {additionalAction}
          <div className="relative">
            <button
              ref={emojiButtonRef}
              type="button"
              onClick={() => setEmojiOpen((v) => !v)}
              aria-label="Insert emoji"
              aria-haspopup="dialog"
              aria-expanded={emojiOpen}
              className="pointer-coarse:h-10 pointer-coarse:w-10 flex h-8 w-8 items-center justify-center rounded-xl text-secondary transition-colors hover:bg-hover hover:text-primary"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9" />
                <path d="M8.5 14.5a4.5 4.5 0 0 0 7 0" />
                <line x1="9" y1="9.5" x2="9.01" y2="9.5" />
                <line x1="15" y1="9.5" x2="15.01" y2="9.5" />
              </svg>
            </button>
            {emojiOpen && (
              <div
                ref={emojiPopoverRef}
                role="dialog"
                aria-label="Pick an emoji"
                className="absolute bottom-full right-0 z-20 mb-2 grid w-[13.5rem] grid-cols-6 gap-0.5 rounded-xl border border-border bg-surface p-1.5 shadow-lg"
              >
                {EMOJI.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    aria-label={`Insert ${emoji}`}
                    onClick={() => {
                      insertAtCaret(emoji);
                      setEmojiOpen(false);
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-base transition-colors hover:bg-hover"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="submit"
            disabled={disabled || !input.trim()}
            aria-label="Send message"
            className="gradient-bg pointer-coarse:h-10 pointer-coarse:w-10 flex h-8 w-8 items-center justify-center rounded-xl text-[var(--on-gradient)] shadow-glow transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}
