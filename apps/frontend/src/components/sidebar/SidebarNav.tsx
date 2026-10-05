"use client";

import { useMemo, useState } from "react";
import { useAppStore, type NavFilter } from "@/stores/app-store";
import type { WorkspaceView } from "@/components/layout/AppShell";
import { useLocalBool } from "@/lib/use-local-bool";
import { NotesSection } from "@/components/sidebar/NotesSection";
import { SidebarLists } from "@/components/sidebar/SidebarLists";
import { isToday, smartListCounts } from "@/lib/task-filters";
import { ContextMenu, ContextMenuItem } from "@/components/ui/ContextMenu";
import { useToast } from "@/lib/toast-context";
import {
  PREF_DEFAULT_LIST,
  readDefaultList,
} from "@/lib/preferences";
import { usePreferencesStore } from "@/stores/preferences-store";

interface SidebarNavProps {
  view: WorkspaceView;
  onSelectView: (v: WorkspaceView) => void;
  financeOn: boolean;
  watchlistOn: boolean;
  habitsOn: boolean;
  quadrantOn: boolean;
  focusOn: boolean;
  countdownOn: boolean;
}

interface FilterItem {
  label: string;
  filter: NavFilter;
  storageKey?: string;
  icon: JSX.Element;
}

const FILTERS: FilterItem[] = [
  {
    label: "Today",
    filter: "today",
    storageKey: "prysm_smartlist_today",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>,
  },
  {
    label: "Next 7 Days",
    filter: "next7",
    storageKey: "prysm_smartlist_next7",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
  },
  {
    label: "All Tasks",
    filter: "all",
    storageKey: "prysm_smartlist_all",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/><circle cx="7" cy="6" r="1" fill="currentColor"/><circle cx="7" cy="12" r="1" fill="currentColor"/><circle cx="7" cy="18" r="1" fill="currentColor"/></svg>,
  },
  {
    label: "Completed",
    filter: "completed",
    storageKey: "prysm_smartlist_completed",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/><circle cx="12" cy="12" r="9"/></svg>,
  },
];

const VIEWS: { label: string; view: WorkspaceView; icon: JSX.Element }[] = [
  {
    label: "Timeline",
    view: "timeline",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="5" x2="21" y2="5"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="19" x2="21" y2="19"/><circle cx="9" cy="5" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="11" cy="19" r="2" fill="currentColor" stroke="none"/></svg>,
  },
  {
    label: "Habits",
    view: "habits",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
  },
  {
    label: "Quadrant",
    view: "quadrant",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>,
  },
  {
    label: "Focus Timer",
    view: "focus",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>,
  },
  {
    label: "Countdown",
    view: "countdown",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 14.5 13.5"/></svg>,
  },
  {
    label: "Finance",
    view: "finance",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>,
  },
  {
    label: "Shows & Movies",
    view: "watchlist",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5"/></svg>,
  },
];

const StarIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M12 2.5l2.9 6.02 6.6.84-4.85 4.52 1.24 6.62L12 17.9 6.11 20.5l1.24-6.62L2.5 9.36l6.6-.84L12 2.5Z" />
  </svg>
);

export function SidebarNav({ view, onSelectView, financeOn, watchlistOn, habitsOn, quadrantOn, focusOn, countdownOn }: SidebarNavProps) {
  const tasks = useAppStore((s) => s.tasks);
  const navFilter = useAppStore((s) => s.navFilter);
  const setNavFilter = useAppStore((s) => s.setNavFilter);
  const setActiveListId = useAppStore((s) => s.setActiveListId);
  const { showToast } = useToast();

  const rawDefaultList = usePreferencesStore((s) => s.prefs[PREF_DEFAULT_LIST]);
  const defaultList =
    typeof rawDefaultList === "string" && rawDefaultList ? rawDefaultList : readDefaultList();

  const [defaultMenu, setDefaultMenu] = useState<{ x: number; y: number; value: NavFilter; label: string } | null>(null);

  const setDefaultLanding = (value: NavFilter, label: string) => {
    setDefaultMenu(null);
    usePreferencesStore.getState().setPreference(PREF_DEFAULT_LIST, value);
    showToast(`"${label}" is now your default list`, "success");
  };

  const smartPrefs = {
    today: useLocalBool("prysm_smartlist_today", true),
    next7: useLocalBool("prysm_smartlist_next7", true),
    all: useLocalBool("prysm_smartlist_all", true),
    completed: useLocalBool("prysm_smartlist_completed", true),
  };

  const counts = useMemo(() => smartListCounts(tasks), [tasks]);

  // Today's done/total for the progress ring and the "all done" note.
  const todayStats = useMemo(() => {
    const relevant = tasks.filter(
      (t) => !t.is_archived && t.status !== "cancelled" && (isToday(t.start_date) || isToday(t.due_date))
    );
    const total = relevant.length;
    const done = relevant.filter((t) => t.status === "done").length;
    return { total, done, remaining: total - done };
  }, [tasks]);

  // Consecutive days (ending today or yesterday) with at least one completed
  // task. Derived from completed_at, no stored counter.
  const streak = useMemo(() => {
    const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const days = new Set<string>();
    for (const t of tasks) {
      if (t.status !== "done" || !t.completed_at) continue;
      const d = new Date(t.completed_at);
      if (!Number.isNaN(d.getTime())) days.add(dayKey(d));
    }
    const cursor = new Date();
    if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
    let count = 0;
    while (days.has(dayKey(cursor)) && count < 400) {
      count += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return count;
  }, [tasks]);

  const visibleFilters = FILTERS.filter((f) => {
    // "All Tasks" is a permanent, non-hideable entry: it is the built-in
    // fallback landing and must always be reachable.
    if (f.filter === "all") return true;
    if (!f.storageKey) return true;
    return smartPrefs[f.filter as keyof typeof smartPrefs];
  });

  const selectView = (v: WorkspaceView) => {
    onSelectView(v);
    if (v === "timeline") setNavFilter(null);
    // Lists are task-scoped; leaving the workspace clears the active list so a
    // Finance/Watchlist session doesn't leave a stale task filter on return.
    if (v !== "timeline") setActiveListId(null);
  };

  return (
    <nav className="space-y-5" aria-label="Primary">
      <div>
        <p className="nav-label px-2 pb-1.5">Smart lists</p>
        <div className="space-y-0.5">
          {visibleFilters.map((item) => {
            const isActive = view === "timeline" && navFilter === item.filter;
            const count = counts[item.filter as keyof typeof counts];
            return (
              <button
                key={item.filter}
                onClick={() => {
                  if (view !== "timeline") onSelectView("timeline");
                  setActiveListId(null);
                  setNavFilter(isActive ? null : item.filter);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setDefaultMenu({ x: e.clientX, y: e.clientY, value: item.filter, label: item.label });
                }}
                className={`sidebar-item text-[13px] ${isActive ? "active" : ""}`}
                aria-current={isActive ? "page" : undefined}
              >
                <span className="text-secondary group-hover:text-primary">{item.icon}</span>
                <span className="flex-1 text-left">{item.label}</span>
                {defaultList === item.filter && (
                  <span className="ml-1 shrink-0 text-accent" title="Default landing" aria-label="Default landing">
                    <StarIcon />
                  </span>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {item.filter === "today" && todayStats.total > 0 && (
                    <span
                      className="flex shrink-0"
                      title={`${todayStats.done} of ${todayStats.total} done today`}
                      aria-label={`${todayStats.done} of ${todayStats.total} tasks done today`}
                      data-testid="today-progress"
                    >
                      <svg viewBox="0 0 36 36" className="h-3.5 w-3.5 -rotate-90">
                        <circle cx="18" cy="18" r="15" fill="none" stroke="var(--border)" strokeWidth="6" />
                        <circle
                          cx="18"
                          cy="18"
                          r="15"
                          fill="none"
                          stroke="var(--accent)"
                          strokeWidth="6"
                          strokeLinecap="round"
                          strokeDasharray={`${(todayStats.done / todayStats.total) * 94.25} 94.25`}
                        />
                      </svg>
                    </span>
                  )}
                  {item.filter === "today" && streak >= 2 && (
                    <span className="badge bg-accent/15 text-accent" title={`${streak}-day completion streak`}>
                      {streak}d
                    </span>
                  )}
                  {count > 0 && (
                    <span className={`badge ${isActive ? "bg-accent/20 text-accent" : "bg-elevated text-muted"}`}>
                      {count}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        {smartPrefs.today && todayStats.total > 0 && todayStats.remaining === 0 && (
          <p className="px-2 pt-1.5 text-[11px] text-muted" data-testid="all-done-today">
            All done for today.
          </p>
        )}
      </div>

      <NotesSection />

      <SidebarLists view={view} onSelectView={onSelectView} />

      <p className="nav-label px-2 pb-1.5">Workspace</p>
      <div className="space-y-0.5">
        {VIEWS.map((item) => {
          const isActive = view === item.view;
          if (item.view === "finance" && !financeOn) return null;
          if (item.view === "watchlist" && !watchlistOn) return null;
          if (item.view === "habits" && !habitsOn) return null;
          if (item.view === "quadrant" && !quadrantOn) return null;
          if (item.view === "focus" && !focusOn) return null;
          if (item.view === "countdown" && !countdownOn) return null;
          return (
            <button
              key={item.view}
              onClick={() => selectView(item.view)}
              className={`sidebar-item text-[13px] ${isActive ? "active" : ""}`}
              aria-current={isActive ? "page" : undefined}
            >
              <span className="text-secondary group-hover:text-primary">{item.icon}</span>
              <span className="flex-1 text-left">{item.label}</span>
            </button>
          );
        })}
      </div>

      {defaultMenu && (
        <ContextMenu
          open
          x={defaultMenu.x}
          y={defaultMenu.y}
          onClose={() => setDefaultMenu(null)}
        >
          <ContextMenuItem
            disabled={defaultList === defaultMenu.value}
            onClick={() => setDefaultLanding(defaultMenu.value, defaultMenu.label)}
          >
            {defaultList === defaultMenu.value ? "Default list" : "Set as default"}
          </ContextMenuItem>
        </ContextMenu>
      )}
    </nav>
  );
}
