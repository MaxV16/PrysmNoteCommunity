"use client";

interface AiPanelButtonProps {
  onClick: () => void;
  title?: string;
}

/** Shared "AI" toggle used by workspace headers so every view has a consistent
 * way to open the AI panel (matches the TimelineView AI button exactly). */
export function AiPanelButton({ onClick, title = "AI" }: AiPanelButtonProps) {
  return (
    <button
      onClick={onClick}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-elevated text-secondary transition-colors hover:bg-hover hover:text-primary"
      title={title}
      aria-label={title}
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 2.5l1.7 4.8 4.8 1.7-4.8 1.7L12 15.5l-1.7-4.8L5.5 9l4.8-1.7L12 2.5z" />
        <path d="M18.6 14.4l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
      </svg>
    </button>
  );
}