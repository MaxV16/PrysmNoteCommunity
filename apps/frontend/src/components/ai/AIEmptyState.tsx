"use client";

interface AIEmptyStateProps {
  onSuggest: (prompt: string) => void;
}

const SUGGESTIONS: { label: string; prompt: string; icon: string }[] = [
  { label: "Plan my day", prompt: "Plan my day", icon: "sun" },
  { label: "Schedule a task", prompt: "Schedule a task for me", icon: "plus" },
  { label: "Review my week", prompt: "Review my week", icon: "calendar" },
  { label: "Analyze my finances", prompt: "Analyze my finances", icon: "trending" },
];

function Icon({ name }: { name: string }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "sun":
      return <svg {...common}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>;
    case "plus":
      return <svg {...common}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>;
    case "calendar":
      return <svg {...common}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>;
    case "trending":
      return <svg {...common}><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>;
    default:
      return null;
  }
}

export function AIEmptyState({ onSuggest }: AIEmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
      </div>
      <h2 className="mt-5 text-lg font-semibold text-primary">What can I help you organize?</h2>
      <p className="mt-2 max-w-xs text-sm leading-relaxed text-secondary">
        Create tasks, schedule events, review your week, or analyze your finances.
      </p>
      <div className="mt-7 grid w-full max-w-sm grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.label}
            onClick={() => onSuggest(s.prompt)}
            className="group flex items-center gap-2.5 rounded-xl border border-border/70 bg-elevated px-3.5 py-2.5 text-left text-sm text-secondary transition-colors hover:border-accent/40 hover:bg-hover hover:text-primary"
          >
            <span className="text-accent"><Icon name={s.icon} /></span>
            <span className="font-medium">{s.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
