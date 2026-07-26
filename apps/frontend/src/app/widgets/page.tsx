"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

export default function WidgetsPage() {
  const [tasks, setTasks] = useState<any[]>([]);
  const [currentMonth, setCurrentMonth] = useState(() => new Date().getMonth());
  const [currentYear, setCurrentYear] = useState(() => new Date().getFullYear());

  useEffect(() => {
    try {
      const raw = localStorage.getItem("prysm_tasks");
      if (raw) setTasks(JSON.parse(raw));
    } catch {}
  }, []);

  const activeTasks = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled").length;
  const today = new Date().toISOString().split("T")[0];
  const dueToday = tasks.filter((t) => t.due_date === today).length;

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const firstDay = new Date(currentYear, currentMonth, 1);
  const lastDay = new Date(currentYear, currentMonth + 1, 0);
  const startOffset = (firstDay.getDay() + 6) % 7;

  const daysWithTasks = tasks.filter((t) => t.due_date).reduce((acc: Record<string, number>, t: any) => {
    acc[t.due_date] = (acc[t.due_date] || 0) + 1;
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-base p-4" style={{ fontFamily: "var(--font-ui)" }}>
      <div className="max-w-sm mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-bold text-primary">Prysm Widgets</h1>
          <Link href="/" className="text-xs text-accent hover:underline">Open Main App</Link>
        </div>

        <div className="rounded-xl bg-surface border border-border p-4">
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

        <div className="rounded-xl bg-surface border border-border p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold text-secondary uppercase tracking-wider">Calendar</h2>
            <div className="flex gap-2">
              <button onClick={() => { if (currentMonth === 0) { setCurrentMonth(11); setCurrentYear(y => y - 1); } else setCurrentMonth(m => m - 1); }} className="text-xs text-muted hover:text-primary">&lt;</button>
              <span className="text-xs font-medium text-primary">{monthNames[currentMonth]} {currentYear}</span>
              <button onClick={() => { if (currentMonth === 11) { setCurrentMonth(0); setCurrentYear(y => y + 1); } else setCurrentMonth(m => m + 1); }} className="text-xs text-muted hover:text-primary">&gt;</button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center">
            {["Mo","Tu","We","Th","Fr","Sa","Su"].map((d) => (
              <span key={d} className="text-[9px] text-muted font-medium py-0.5">{d}</span>
            ))}
            {Array.from({ length: startOffset }).map((_, i) => <div key={`e${i}`} />)}
            {Array.from({ length: lastDay.getDate() }, (_, i) => i + 1).map((d) => {
              const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
              const count = daysWithTasks[dateStr] || 0;
              const isToday = dateStr === today;
              return (
                <div key={d} className={`text-xs py-1 rounded-md relative ${isToday ? "bg-accent text-base font-semibold" : "text-secondary"}`}>
                  {d}
                  {count > 0 && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-accent" />}
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl bg-surface border border-border p-4">
          <h2 className="text-xs font-semibold text-secondary uppercase tracking-wider mb-3">Today&apos;s Tasks</h2>
          <div className="space-y-1">
            {tasks.filter((t) => t.due_date === today).slice(0, 5).map((t: any) => (
              <div key={t.id} className="flex items-center gap-2 py-1">
                <div className={`w-1.5 h-1.5 rounded-full ${t.status === "done" ? "bg-success" : "bg-accent"}`} />
                <span className={`text-xs ${t.status === "done" ? "line-through text-muted" : "text-primary"} truncate`}>{t.title}</span>
              </div>
            ))}
            {tasks.filter((t) => t.due_date === today).length === 0 && (
              <p className="text-[10px] text-muted text-center py-2">No tasks due today</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
