"use client";

import { useMemo } from "react";
import { useAppStore, type NavFilter } from "@/stores/app-store";

function isToday(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const today = new Date();
  return (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  );
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

const NAV_ITEMS: { label: string; icon: string; filter: NavFilter }[] = [
  { label: "Inbox", icon: "📥", filter: "inbox" },
  { label: "Today", icon: "📅", filter: "today" },
  { label: "Next 7 Days", icon: "📋", filter: "next7" },
];

export function NavSection() {
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

  return (
    <nav className="flex flex-col gap-1">
      {NAV_ITEMS.map((item) => {
        const isActive = navFilter === item.filter;
        const count = counts[item.filter as keyof typeof counts];
        return (
          <button
            key={item.label}
            onClick={() => setNavFilter(isActive ? null : item.filter)}
            className={`sidebar-item group ${isActive ? "active" : ""}`}
          >
            <span className="text-base">{item.icon}</span>
            <span className="flex-1 text-left">{item.label}</span>
            {count > 0 && (
              <span
                className={`badge ${
                  isActive ? "bg-accent/20 text-accent" : "bg-elevated text-muted"
                }`}
              >
                {count}
              </span>
            )}
            <span className="text-[10px] text-muted opacity-0 group-hover:opacity-100 transition-opacity ml-auto">
              {item.filter === "inbox" ? "I" : item.filter === "today" ? "T" : "N"}
            </span>
          </button>
        );
      })}
    </nav>
  );
}