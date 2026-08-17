"use client";

import { useMemo } from "react";
import { useAppStore, type NavFilter } from "@/stores/app-store";
import type { WorkspaceView } from "@/components/layout/AppShell";

function isToday(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const today = new Date();
  return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
}

function isWithinNext7Days(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekLater = new Date(today);
  weekLater.setDate(weekLater.getDate() + 7);
  d.setHours(0, 0, 0, 0);
  return d >= today && d <= weekLater;
}

interface SidebarNavProps {
  view: WorkspaceView;
  onSelectView: (v: WorkspaceView) => void;
  financeOn: boolean;
}

const FILTERS: { label: string; filter: NavFilter; icon: JSX.Element }[] = [
  {
    label: "Inbox",
    filter: "inbox",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>,
  },
  {
    label: "Today",
    filter: "today",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>,
  },
  {
    label: "Next 7 Days",
    filter: "next7",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
  },
];

const VIEWS: { label: string; view: WorkspaceView; icon: JSX.Element }[] = [
  {
    label: "Timeline",
    view: "timeline",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="5" x2="21" y2="5"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="19" x2="21" y2="19"/><circle cx="9" cy="5" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="11" cy="19" r="2" fill="currentColor" stroke="none"/></svg>,
  },
  {
    label: "Finance",
    view: "finance",
    icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>,
  },
];

export function SidebarNav({ view, onSelectView, financeOn }: SidebarNavProps) {
  const tasks = useAppStore((s) => s.tasks);
  const navFilter = useAppStore((s) => s.navFilter);
  const setNavFilter = useAppStore((s) => s.setNavFilter);

  const counts = useMemo(() => {
    const active = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled" && !t.is_archived);
    return {
      inbox: active.filter((t) => !t.start_date && !t.due_date).length,
      today: active.filter((t) => isToday(t.start_date) || isToday(t.due_date)).length,
      next7: active.filter((t) => isWithinNext7Days(t.start_date) || isWithinNext7Days(t.due_date)).length,
    };
  }, [tasks]);

  const selectView = (v: WorkspaceView) => {
    onSelectView(v);
    if (v === "timeline") setNavFilter(null);
  };

  return (
    <nav className="space-y-5" aria-label="Primary">
      <div>
        <p className="nav-label px-2 pb-1.5">Workspace</p>
        <div className="space-y-0.5">
          {FILTERS.map((item) => {
            const isActive = view === "timeline" && navFilter === item.filter;
            const count = counts[item.filter as keyof typeof counts];
            return (
              <button
                key={item.filter}
                onClick={() => {
                  if (view !== "timeline") onSelectView("timeline");
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

      <div className="space-y-0.5">
        {VIEWS.map((item) => {
          const isActive = view === item.view;
          if (item.view === "finance" && !financeOn) return null;
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
