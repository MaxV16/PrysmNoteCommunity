"use client";

import { useState, useEffect, useCallback } from "react";

interface Widget {
  id: string;
  type: "calendar" | "tasks" | "habits";
  visible: boolean;
  order: number;
}

const STORAGE_KEY = "prysm_widget_config";

function generateId(): string {
  return `widget_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

const DEFAULT_WIDGETS: Widget[] = [
  { id: generateId(), type: "calendar", visible: true, order: 0 },
  { id: generateId(), type: "tasks", visible: true, order: 1 },
  { id: generateId(), type: "habits", visible: true, order: 2 },
];

function loadWidgets(): Widget[] {
  if (typeof window === "undefined") return DEFAULT_WIDGETS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : DEFAULT_WIDGETS;
  } catch {
    return DEFAULT_WIDGETS;
  }
}

function saveWidgets(widgets: Widget[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widgets));
  } catch {}
}

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function CalendarWidget() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const isToday = (d: number) =>
    today.getFullYear() === year && today.getMonth() === month && today.getDate() === d;

  const monthName = new Date(year, month).toLocaleString("default", { month: "long" });

  return (
    <div className="card bg-surface rounded-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => {
            if (month === 0) { setMonth(11); setYear((y) => y - 1); }
            else setMonth((m) => m - 1);
          }}
          className="text-xs text-secondary hover:text-primary px-1"
        >
          {"<"}
        </button>
        <span className="text-sm font-medium text-primary">
          {monthName} {year}
        </span>
        <button
          onClick={() => {
            if (month === 11) { setMonth(0); setYear((y) => y + 1); }
            else setMonth((m) => m + 1);
          }}
          className="text-xs text-secondary hover:text-primary px-1"
        >
          {">"}
        </button>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center">
        {DAYS.map((d) => (
          <div key={d} className="text-[10px] text-muted font-medium py-0.5">
            {d}
          </div>
        ))}
        {Array.from({ length: firstDay }).map((_, i) => (
          <div key={`empty-${i}`} />
        ))}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const d = i + 1;
          return (
            <div
              key={d}
              className={`text-xs py-0.5 rounded ${
                isToday(d)
                  ? "bg-accent text-white font-bold"
                  : "text-primary hover:bg-hover"
              }`}
            >
              {d}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TasksWidget() {
  const [counts, setCounts] = useState({ total: 0, todo: 0, done: 0, overdue: 0 });

  useEffect(() => {
    try {
      const raw = localStorage.getItem("prysm_tasks");
      if (!raw) return;
      const tasks: { status: string; dueDate?: string }[] = JSON.parse(raw);
      const now = new Date();
      const total = tasks.length;
      const done = tasks.filter((t) => t.status === "done").length;
      const overdue = tasks.filter((t) => t.status !== "done" && t.dueDate && new Date(t.dueDate) < now).length;
      const todo = total - done;
      setCounts({ total, todo, done, overdue });
    } catch {
      setCounts({ total: 0, todo: 0, done: 0, overdue: 0 });
    }
  }, []);

  return (
    <div className="card bg-surface rounded-xl p-3">
      <h3 className="text-sm font-semibold text-primary mb-2">Tasks</h3>
      <div className="grid grid-cols-2 gap-2">
        <div className="bg-elevated rounded-lg p-2 text-center">
          <div className="text-lg font-bold text-primary">{counts.total}</div>
          <div className="text-[10px] text-muted uppercase tracking-wider">Total</div>
        </div>
        <div className="bg-elevated rounded-lg p-2 text-center">
          <div className="text-lg font-bold text-accent">{counts.todo}</div>
          <div className="text-[10px] text-muted uppercase tracking-wider">To Do</div>
        </div>
        <div className="bg-elevated rounded-lg p-2 text-center">
          <div className="text-lg font-bold text-success">{counts.done}</div>
          <div className="text-[10px] text-muted uppercase tracking-wider">Done</div>
        </div>
        <div className="bg-elevated rounded-lg p-2 text-center">
          <div className="text-lg font-bold text-danger">{counts.overdue}</div>
          <div className="text-[10px] text-muted uppercase tracking-wider">Overdue</div>
        </div>
      </div>
    </div>
  );
}

const HABIT_ITEMS = ["Exercise", "Read", "Meditate", "Water", "Sleep"];

function HabitsWidget() {
  const [completed, setCompleted] = useState<string[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("prysm_habits");
      if (raw) setCompleted(JSON.parse(raw));
    } catch {
      setCompleted([]);
    }
  }, []);

  const toggleHabit = useCallback(
    (name: string) => {
      let next: string[];
      if (completed.includes(name)) {
        next = completed.filter((h) => h !== name);
      } else {
        next = [...completed, name];
      }
      setCompleted(next);
      if (typeof window !== "undefined") {
        localStorage.setItem("prysm_habits", JSON.stringify(next));
      }
    },
    [completed]
  );

  const progress = HABIT_ITEMS.length > 0 ? Math.round((completed.length / HABIT_ITEMS.length) * 100) : 0;

  return (
    <div className="card bg-surface rounded-xl p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-primary">Today&apos;s Progress</h3>
        <span className="text-xs font-bold text-accent">{progress}%</span>
      </div>
      <div className="w-full bg-elevated rounded-full h-1.5 mb-3">
        <div
          className="bg-accent h-1.5 rounded-full transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>
      <div className="flex gap-2 justify-center">
        {HABIT_ITEMS.map((habit) => {
          const isDone = completed.includes(habit);
          return (
            <button
              key={habit}
              onClick={() => toggleHabit(habit)}
              className={`h-8 w-8 rounded-full border-2 flex items-center justify-center text-xs font-medium transition-all ${
                isDone
                  ? "bg-accent border-accent text-white"
                  : "border-border text-secondary hover:border-accent"
              }`}
              title={habit}
            >
              {habit[0]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function WidgetPanel() {
  const [widgets, setWidgets] = useState<Widget[]>([]);

  useEffect(() => {
    setWidgets(loadWidgets());
  }, []);

  const hideWidget = useCallback(
    (id: string) => {
      const updated = widgets.map((w) => (w.id === id ? { ...w, visible: false } : w));
      setWidgets(updated);
      saveWidgets(updated);
    },
    [widgets]
  );

  const sorted = [...widgets].filter((w) => w.visible).sort((a, b) => a.order - b.order);

  return (
    <div className="w-[320px] h-full border-r border-border bg-base overflow-y-auto">
      <div className="p-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-primary uppercase tracking-wider">Widgets</h2>
      </div>
      <div className="flex flex-col gap-3 px-3 pb-4">
        {sorted.map((w) => (
          <div key={w.id} className="relative">
            <button
              onClick={() => hideWidget(w.id)}
              className="absolute top-2 right-2 z-10 text-xs text-muted hover:text-danger transition-colors"
              title="Hide widget"
            >
              ✕
            </button>
            {w.type === "calendar" && <CalendarWidget />}
            {w.type === "tasks" && <TasksWidget />}
            {w.type === "habits" && <HabitsWidget />}
          </div>
        ))}
        {sorted.length === 0 && (
          <p className="text-xs text-muted text-center py-6">No widgets visible</p>
        )}
      </div>
    </div>
  );
}
