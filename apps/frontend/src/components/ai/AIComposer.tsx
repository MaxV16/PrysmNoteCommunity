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
}

const MAX_LENGTH = 2000;

export function AIComposer({
  onSend,
  disabled,
  isLoading,
  hasUndo,
  onAbort,
  onUndo,
  additionalAction,
}: AIComposerProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 132) + "px";
  }, [input]);

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
          <button
            type="submit"
            disabled={disabled || !input.trim()}
            aria-label="Send message"
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
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
