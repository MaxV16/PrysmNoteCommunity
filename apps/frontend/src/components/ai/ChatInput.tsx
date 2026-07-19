"use client";

import { useState, useRef, useEffect } from "react";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

const MAX_LENGTH = 2000;

export function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + "px";
    }
  }, [input]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || disabled) return;
    onSend(input.trim());
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const remaining = MAX_LENGTH - input.length;
  const isNearLimit = remaining < 100;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="relative">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value.slice(0, MAX_LENGTH))}
          onKeyDown={handleKeyDown}
          placeholder="What would you like me to do? e.g., 'Schedule GP appointment next Monday at 12pm'"
          className="input-field resize-none pr-12 text-sm rounded-2xl shadow-inner"
          rows={1}
          disabled={disabled}
          autoFocus
        />
        <div className="absolute right-2 bottom-2 flex items-center gap-1.5">
          {input.length > 0 && (
            <span className={`text-[10px] ${isNearLimit ? "text-warning" : "text-muted"}`}>
              {remaining}
            </span>
          )}
          <button
            type="submit"
            disabled={disabled || !input.trim()}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-accent to-purple-500 text-base text-sm hover:from-accent-hover hover:to-purple-600 hover:shadow-glow disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:shadow-none transition-all"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          </button>
        </div>
      </div>
      {input.length > 5 && (
        <span className={`text-[10px] text-muted ${isNearLimit ? "text-warning" : ""}`}>
          {remaining} characters remaining
        </span>
      )}
    </form>
  );
}
