"use client";

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

export function AIHeader({
  provider,
  onProviderChange,
  providers,
  onNewChat,
  onHistoryToggle,
  historyOpen,
  onClose,
}: AIHeaderProps) {
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
          className="pointer-coarse:h-11 pointer-coarse:w-11 inline-flex h-8 w-8 items-center justify-center gap-1 rounded-lg bg-accent/10 text-xs font-medium text-accent transition-colors hover:bg-accent/20"
          title="New chat"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          <span className="hidden sm:inline">New chat</span>
        </button>

        <div className="relative min-w-0">
          <select
            value={provider}
            onChange={(e) => onProviderChange(e.target.value)}
            aria-label="AI provider"
            title={providers.find((p) => p.value === provider)?.label ?? provider}
            className="pointer-coarse:h-11 w-[5.75rem] max-w-full cursor-pointer appearance-none truncate rounded-lg border border-border bg-elevated py-1 pl-2 pr-5 text-[11px] text-secondary outline-none transition-colors hover:border-border hover:text-primary focus:border-accent/50 sm:w-auto sm:pl-2.5 sm:pr-6 sm:text-xs"
          >
            {providers.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}{p.configured ? " ✓" : ""}
              </option>
            ))}
          </select>
          <svg className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-muted" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
        </div>

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
