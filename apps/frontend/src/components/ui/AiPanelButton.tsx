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
      className="gradient-bg flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--on-gradient)] shadow-glow hover:brightness-110"
      title={title}
      aria-label={title}
    >
      ⚡
    </button>
  );
}