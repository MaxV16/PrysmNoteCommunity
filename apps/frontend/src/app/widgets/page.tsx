"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { calendarOffset, weekdayHeaders, todayISO } from "@/lib/dates";
import { api } from "@/lib/api";
import type { Task } from "@/types/task";
import type { Habit } from "@/types/habit";

interface WidgetConfig {
  calendar: boolean;
  tasks: boolean;
  habits: boolean;
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw) === true;
  } catch {
    return fallback;
  }
}

export default function WidgetsPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState<WidgetConfig>({ calendar: true, tasks: true, habits: true });
  const [currentMonth, setCurrentMonth] = useState(() => new Date().getMonth());
  const [currentYear, setCurrentYear] = useState(() => new Date().getFullYear());

  useEffect(() => {
    setConfig({
      calendar: readBool("prysm_widget_calendar", true),
      tasks: readBool("prysm_widget_tasks", true),
      habits: readBool("prysm_widget_habits", true),
    });

    let cancelled = false;
    (async () => {
      const [taskResult, habitResult] = await Promise.allSettled([
        api.get<Task[]>("/tasks/?limit=200&offset=0"),
        api.get<Habit[]>("/habits/"),
      ]);
      if (cancelled) return;
      if (taskResult.status === "fulfilled" && Array.isArray(taskResult.value)) {
        setTasks(taskResult.value);
        try { localStorage.setItem("prysm_tasks", JSON.stringify(taskResult.value)); } catch {}
      }
      if (habitResult.status === "fulfilled" && Array.isArray(habitResult.value)) {
        setHabits(habitResult.value);
        try { localStorage.setItem("prysm_habits", JSON.stringify(habitResult.value)); } catch {}
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const activeTasks = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled").length;
  const today = todayISO();
  const dueTodayTasks = tasks.filter((t) => t.due_date === today);
  const dueToday = dueTodayTasks.length;

  const habitsDone = habits.filter((h) => h.completed_today).length;

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const firstDay = new Date(currentYear, currentMonth, 1);
  const lastDay = new Date(currentYear, currentMonth + 1, 0);
  const startOffset = calendarOffset(firstDay);
  const dayHeaders = weekdayHeaders();

  const daysWithTasks = tasks.filter((t) => t.due_date).reduce((acc: Record<string, number>, t) => {
    acc[t.due_date as string] = (acc[t.due_date as string] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="min-h-dvh bg-base p-4" style={{ fontFamily: "var(--font-ui)" }}>
      <div className="max-w-sm mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-bold text-primary">Prysm Widgets</h1>
          <Link href="/" className="text-xs text-accent hover:underline">Open Main App</Link>
        </div>

        {config.tasks && (
          <div className="card p-4">
            <h2 className="text-xs font-semibold text-secondary uppercase tracking-wider mb-3">Task Overview</h2>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-elevated p-3 text-center border border-border">
                <p className="text-2xl font-bold text-accent">{activeTasks}</p>
                <p className="text-[10px] text-muted">Active</p>
              </div>
              <div className="rounded-lg bg-elevated p-3 text-center border border-border">
                <p className="text-2xl font-bold text-warning">{dueToday}</p>
                <p className="text-[10px] text-muted">Due Today</p>
              </div>
            </div>
          </div>
        )}

        {config.habits && (
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold text-secondary uppercase tracking-wider">Habit Progress</h2>
              <span className="text-xs font-medium text-primary">
                {habits.length ? `${habitsDone} / ${habits.length}` : ""}
              </span>
            </div>
            {loading ? (
              <p className="text-[10px] text-muted text-center py-2">Loading...</p>
            ) : habits.length === 0 ? (
              <p className="text-[10px] text-muted text-center py-2">No habits yet</p>
            ) : (
              <div className="space-y-2">
                <div className="h-2 rounded-full bg-elevated border border-border overflow-hidden">
                  <div
                    className="h-full gradient-bg rounded-full transition-all"
                    style={{ width: `${habits.length ? (habitsDone / habits.length) * 100 : 0}%` }}
                  />
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5">
                  {habits.slice(0, 6).map((h) => (
                    <div key={h.id} className="flex items-center gap-1.5">
                      <div className={`w-1.5 h-1.5 rounded-full ${h.completed_today ? "bg-success" : "bg-accent/40"}`} />
                      <span className={`text-[10px] truncate ${h.completed_today ? "text-muted line-through" : "text-secondary"}`}>
                        {h.title}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {config.calendar && (
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs font-semibold text-secondary uppercase tracking-wider">Calendar</h2>
              <div className="flex gap-2">
                <button onClick={() => { if (currentMonth === 0) { setCurrentMonth(11); setCurrentYear(y => y - 1); } else setCurrentMonth(m => m - 1); }} className="text-xs text-muted hover:text-primary">&lt;</button>
                <span className="text-xs font-medium text-primary">{monthNames[currentMonth]} {currentYear}</span>
                <button onClick={() => { if (currentMonth === 11) { setCurrentMonth(0); setCurrentYear(y => y + 1); } else setCurrentMonth(m => m + 1); }} className="text-xs text-muted hover:text-primary">&gt;</button>
              </div>
            </div>
            <div className="grid grid-cols-7 gap-0.5 text-center">
              {dayHeaders.map((d) => (
                <span key={d} className="text-[9px] text-muted font-medium py-0.5">{d}</span>
              ))}
              {Array.from({ length: startOffset }).map((_, i) => <div key={`e${i}`} />)}
              {Array.from({ length: lastDay.getDate() }, (_, i) => i + 1).map((d) => {
                const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
                const count = daysWithTasks[dateStr] || 0;
                const isToday = dateStr === today;
                return (
                  <div key={d} className={`text-xs py-1 rounded-md relative ${isToday ? "gradient-bg text-[var(--on-gradient)] font-semibold" : "text-secondary"}`}>
                    {d}
                    {count > 0 && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-accent" />}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {config.tasks && (
          <div className="card p-4">
            <h2 className="text-xs font-semibold text-secondary uppercase tracking-wider mb-3">Today&apos;s Tasks</h2>
            <div className="space-y-1">
              {dueTodayTasks.slice(0, 5).map((t) => (
                <div key={t.id} className="flex items-center gap-2 py-1">
                  <div className={`w-1.5 h-1.5 rounded-full ${t.status === "done" ? "bg-success" : "bg-accent"}`} />
                  <span className={`text-xs ${t.status === "done" ? "line-through text-muted" : "text-primary"} truncate`}>{t.title}</span>
                </div>
              ))}
              {!loading && dueTodayTasks.length === 0 && (
                <p className="text-[10px] text-muted text-center py-2">No tasks due today</p>
              )}
              {loading && <p className="text-[10px] text-muted text-center py-2">Loading...</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
