"use client";

import { useMemo } from "react";
import { useAppStore, type NavFilter } from "@/stores/app-store";
import type { WorkspaceView } from "@/components/layout/AppShell";
import { useLocalBool } from "@/lib/use-local-bool";
import { todayISO } from "@/lib/dates";
import { NotesSection } from "@/components/sidebar/NotesSection";
import { SidebarLists } from "@/components/sidebar/SidebarLists";

function isToday(dateStr: string | null): boolean {
  if (!dateStr) return false;
  return dateStr === todayISO();
}

function isWithinNext7Days(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const start = new Date(`${todayISO()}T00:00:00`);
  const weekLater = new Date(start);
  weekLater.setDate(weekLater.getDate() + 7);
  const d = new Date(`${dateStr}T00:00:00`);
  return d >= start && d <= weekLater;
}

interface SidebarNavProps {
  view: WorkspaceView;
  onSelectView: (v: WorkspaceView) => void;
  financeOn: boolean;
  watchlistOn: boolean;
  habitsOn: boolean;
}

interface FilterItem {
  label: string;
  filter: NavFilter;
  storageKey?: string;
  icon: JSX.Element;
}

const FILTERS: FilterItem[] = [
  {
    label: "Inbox",
    filter: "inbox",
    storageKey: "prysm_smartlist_inbox",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>,
  },
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

export function SidebarNav({ view, onSelectView, financeOn, watchlistOn, habitsOn }: SidebarNavProps) {
  const tasks = useAppStore((s) => s.tasks);
  const navFilter = useAppStore((s) => s.navFilter);
  const setNavFilter = useAppStore((s) => s.setNavFilter);
  const setActiveListId = useAppStore((s) => s.setActiveListId);

  const smartPrefs = {
    inbox: useLocalBool("prysm_smartlist_inbox", true),
    today: useLocalBool("prysm_smartlist_today", true),
    next7: useLocalBool("prysm_smartlist_next7", true),
    all: useLocalBool("prysm_smartlist_all", true),
    completed: useLocalBool("prysm_smartlist_completed", true),
  };

  const counts = useMemo(() => {
    const active = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled" && !t.is_archived);
    return {
      inbox: active.filter((t) => !t.start_date && !t.due_date).length,
      today: active.filter((t) => isToday(t.start_date) || isToday(t.due_date)).length,
      next7: active.filter((t) => isWithinNext7Days(t.start_date) || isWithinNext7Days(t.due_date)).length,
      all: active.length,
      completed: tasks.filter((t) => t.status === "done" && !t.is_archived).length,
    };
  }, [tasks]);

  const visibleFilters = FILTERS.filter((f) => {
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
        <p className="nav-label px-2 pb-1.5">Workspace</p>
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
                className={`sidebar-item text-[13px] ${isActive ? "active" : ""}`}
                aria-current={isActive ? "page" : undefined}
              >
                <span className="text-secondary group-hover:text-primary">{item.icon}</span>
                <span className="flex-1 text-left">{item.label}</span>
                {count > 0 && (
                  <span className={`badge ml-auto ${isActive ? "bg-accent/20 text-accent" : "bg-elevated text-muted"}`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <NotesSection />

      <SidebarLists view={view} onSelectView={onSelectView} />

      <div className="space-y-0.5">
        {VIEWS.map((item) => {
          const isActive = view === item.view;
          if (item.view === "finance" && !financeOn) return null;
          if (item.view === "watchlist" && !watchlistOn) return null;
          if (item.view === "habits" && !habitsOn) return null;
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
    </nav>
  );
}
