"use client";

import { useRef, useState } from "react";
import { PopoverMenu } from "@/components/ui/PopoverMenu";

interface ProviderOption {
  value: string;
  label: string;
  configured: boolean;
}

interface AIHeaderProps {
  provider: string;
  onProviderChange: (p: string) => void;
  providers: ProviderOption[];
  onNewChat: () => void;
  onHistoryToggle: () => void;
  historyOpen: boolean;
  onClose: () => void;
}

/**
 * Header of the AI pane. Actions are icons only: the row has to survive a
 * 412px phone, so "new chat" is a plus and the model picker is one small pill
 * captioned "AI" instead of a full-width select with the provider name in it.
 */
export function AIHeader({
  provider,
  onProviderChange,
  providers,
  onNewChat,
  onHistoryToggle,
  historyOpen,
  onClose,
}: AIHeaderProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLButtonElement>(null);
  const current = providers.find((p) => p.value === provider);

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2.5 py-2 sm:gap-3 sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
          </svg>
        </div>
        {/* A phone only has ~412px for the whole row, so the title shrinks to
            "AI" there and gets its full name from sm up. */}
        <h2 data-testid="ai-panel-header" className="truncate text-sm font-semibold text-primary">
          <span className="sm:hidden">AI</span>
          <span className="hidden sm:inline">AI Command</span>
        </h2>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={onHistoryToggle}
          aria-label="Chat history"
          aria-expanded={historyOpen}
          className={`icon-btn pointer-coarse:h-11 pointer-coarse:w-11 ${historyOpen ? "bg-hover text-primary" : ""}`}
          title="Chat history"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button
          onClick={onNewChat}
          aria-label="New chat"
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent transition-colors hover:bg-accent/20 pointer-coarse:h-11 pointer-coarse:w-11"
          title="New chat"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>

        <span className="ml-0.5 hidden text-[10px] font-medium uppercase tracking-wide text-muted sm:inline">
          AI
        </span>
        <button
          ref={pickerRef}
          onClick={() => setPickerOpen((v) => !v)}
          aria-label="AI provider"
          aria-haspopup="listbox"
          aria-expanded={pickerOpen}
          title={current?.label ?? provider}
          className="flex h-8 max-w-[6.5rem] items-center gap-1 rounded-full border border-border bg-elevated pl-2.5 pr-1 text-[11px] text-secondary transition-colors hover:border-accent/50 hover:text-primary focus-visible:border-accent pointer-coarse:h-11 pointer-coarse:pr-2"
        >
          <span className="truncate">{current?.label ?? provider}</span>
          <svg className="shrink-0 text-muted" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <PopoverMenu
          open={pickerOpen}
          triggerRef={pickerRef}
          align="right"
          onClose={() => setPickerOpen(false)}
          className="min-w-[11rem]"
        >
          <div role="listbox" aria-label="AI provider">
            {providers.map((option) => {
              const selected = option.value === provider;
              return (
                <button
                  key={option.value}
                  role="option"
                  aria-selected={selected}
                  onClick={() => {
                    onProviderChange(option.value);
                    setPickerOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left text-xs hover:bg-hover focus:bg-hover ${
                    selected ? "text-primary" : "text-secondary"
                  }`}
                >
                  <span className="truncate">{option.label}</span>
                  {selected ? (
                    <svg className="shrink-0 text-accent" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  ) : option.configured ? null : (
                    <span className="shrink-0 text-[10px] text-muted">no key</span>
                  )}
                </button>
              );
            })}
          </div>
          <p className="border-t border-border/60 px-2.5 pb-1 pt-1.5 text-[10px] text-muted">
            Add keys in Settings to use your own provider.
          </p>
        </PopoverMenu>

        <button
          onClick={onClose}
          aria-label="Close AI panel"
          className="icon-btn pointer-coarse:h-11 pointer-coarse:w-11"
          title="Close"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
  );
}
