"use client";

import { useRouter } from "next/navigation";
import type { WorkspaceView } from "@/components/layout/AppShell";

interface MobileTabBarProps {
  view: WorkspaceView;
  onSelectView: (v: WorkspaceView) => void;
  onOpenAi: () => void;
  showFinance: boolean;
  showWatchlist: boolean;
  showHabits: boolean;
  showQuadrant: boolean;
  showFocus: boolean;
  showCountdown: boolean;
}

const ACTIVE = "bg-accent font-semibold text-[var(--on-gradient)]";
const INACTIVE = "text-secondary hover:text-primary";

function TabButton({
  label,
  active,
  onClick,
  icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-full px-2 py-1 text-[10px] transition-colors ${active ? ACTIVE : INACTIVE}`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

/**
 * Mobile bottom navigation (rendered by AppShell on small screens only).
 * Today/Chat/Capture are always present; Finance + Watchlist tabs appear only
 * when their modules are enabled AND they render in this build. The center
 * Capture tab is the prominent mic entry to the voice diary.
 */
export function MobileTabBar({ view, onSelectView, onOpenAi, showFinance, showWatchlist, showHabits, showQuadrant, showFocus, showCountdown }: MobileTabBarProps) {
  const router = useRouter();

  return (
    <nav className="flex shrink-0 items-center gap-1 border-t border-border bg-surface px-2 pt-1.5 pb-safe" aria-label="Primary">
      <TabButton
        label="Today"
        active={view === "timeline"}
        onClick={() => onSelectView("timeline")}
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        }
      />
      <TabButton
        label="Chat"
        active={false}
        onClick={onOpenAi}
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        }
      />
      {showFinance && (
        <TabButton
          label="Finance"
          active={view === "finance"}
          onClick={() => onSelectView("finance")}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="1" x2="12" y2="23" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          }
        />
      )}
      {showHabits && (
        <TabButton
          label="Habits"
          active={view === "habits"}
          onClick={() => onSelectView("habits")}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
          }
        />
      )}
      {showFocus && (
        <TabButton
          label="Focus"
          active={view === "focus"}
          onClick={() => onSelectView("focus")}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9"/>
              <polyline points="12 7 12 12 15 14"/>
            </svg>
          }
        />
      )}
      {showCountdown && (
        <TabButton
          label="Countdown"
          active={view === "countdown"}
          onClick={() => onSelectView("countdown")}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9"/>
              <polyline points="12 7 12 12 14.5 13.5"/>
            </svg>
          }
        />
      )}
      {showWatchlist && (
        <TabButton
          label="Watchlist"
          active={view === "watchlist"}
          onClick={() => onSelectView("watchlist")}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5" />
            </svg>
          }
        />
      )}
    </nav>
  );
}
