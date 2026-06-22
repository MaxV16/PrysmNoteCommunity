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
          placeholder="Ask the AI assistant... (Enter to send, Shift+Enter for new line)"
          className="input-field resize-none pr-16 text-sm"
          rows={1}
          disabled={disabled}
          autoFocus
        />
        <div className="absolute right-2 bottom-2 flex items-center gap-1">
          {input.length > 0 && (
            <span className={`text-[10px] ${isNearLimit ? "text-warning" : "text-muted"}`}>
              {remaining}
            </span>
          )}
          <button
            type="submit"
            disabled={disabled || !input.trim()}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-base text-sm hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            &#8593;
          </button>
        </div>
      </div>
    </form>
  );
}
