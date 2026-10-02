"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkspaceView } from "@/components/layout/AppShell";
import { Modal } from "@/components/ui/Modal";

type PanelView = Exclude<WorkspaceView, "timeline">;

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
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className="flex min-w-0 flex-1 basis-0 flex-col items-center gap-0.5 px-0.5 py-1 transition-colors"
    >
      <span
        className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
          active ? "bg-accent text-[var(--on-gradient)]" : "text-secondary hover:text-primary"
        }`}
      >
        {icon}
      </span>
      <span
        className={`w-full truncate text-center text-[10px] leading-tight ${
          active ? "font-semibold text-accent" : "text-muted"
        }`}
      >
        {label}
      </span>
    </button>
  );
}

const ICONS = {
  today: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  chat: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  more: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  ),
  habits: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  ),
  quadrant: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  focus: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  ),
  countdown: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 14.5 13.5" />
    </svg>
  ),
  finance: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  ),
  watchlist: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5" />
    </svg>
  ),
};

const WORKSPACE_VIEWS: PanelView[] = [
  "habits",
  "quadrant",
  "focus",
  "countdown",
  "finance",
  "watchlist",
];

/**
 * Mobile bottom navigation (rendered by AppShell on small screens only).
 * Four fixed slots - Today / Chat / Capture / More - so nothing is clipped on a
 * phone. The less-used workspaces (Habits, Quadrant, Focus, Countdown, Finance,
 * Watchlist) live behind the More sheet and appear only when their module is
 * enabled. The Capture slot is the prominent mic entry to the voice diary.
 */
export function MobileTabBar({ view, onSelectView, onOpenAi, showFinance, showWatchlist, showHabits, showQuadrant, showFocus, showCountdown }: MobileTabBarProps) {
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);

  const enabled: Record<WorkspaceView, boolean> = {
    timeline: true,
    habits: Boolean(showHabits),
    quadrant: Boolean(showQuadrant),
    focus: Boolean(showFocus),
    countdown: Boolean(showCountdown),
    finance: Boolean(showFinance),
    watchlist: Boolean(showWatchlist),
  };
  const entries = WORKSPACE_VIEWS.filter((v) => enabled[v]);
  const workspaceActive = WORKSPACE_VIEWS.includes(view as PanelView);

  const selectWorkspace = (v: PanelView) => {
    setMoreOpen(false);
    onSelectView(v);
  };

  return (
    <>
      <nav className="flex shrink-0 items-center gap-1 border-t border-border bg-surface pl-safe pr-safe px-2 pt-1.5 pb-safe" aria-label="Primary">
        <TabButton
          label="Today"
          active={view === "timeline"}
          onClick={() => onSelectView("timeline")}
          icon={ICONS.today}
        />
        <TabButton label="Chat" active={false} onClick={onOpenAi} icon={ICONS.chat} />
        <TabButton
          label="More"
          active={workspaceActive}
          onClick={() => setMoreOpen(true)}
          icon={ICONS.more}
        />
      </nav>

      <Modal isOpen={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <div className="space-y-1">
          {entries.length === 0 ? (
            <p className="px-1 py-2 text-sm text-secondary">No extra workspaces are enabled.</p>
          ) : (
            entries.map((v) => {
              const isActive = view === v;
              return (
                <button
                  key={v}
                  onClick={() => selectWorkspace(v)}
                  aria-current={isActive ? "page" : undefined}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm transition-colors ${
                    isActive ? "bg-accent/10 font-semibold text-accent" : "text-primary hover:bg-hover"
                  }`}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-elevated text-secondary">
                    {ICONS[v]}
                  </span>
                  <span className="flex-1 text-left">
                    {v === "watchlist" ? "Shows & Movies" : v.charAt(0).toUpperCase() + v.slice(1)}
                  </span>
                  {isActive ? (
                    <span className="text-accent" aria-hidden>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </Modal>
    </>
  );
}
