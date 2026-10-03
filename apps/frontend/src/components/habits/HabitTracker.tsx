"use client";

import { toLocalDateString } from "@/lib/utils";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function getLast7Days(): Date[] {
  const dates: Date[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d);
  }
  return dates;
}

function dateStr(d: Date): string {
  return toLocalDateString(d);
}

interface HabitTrackerProps {
  habits: Array<{
    id: string;
    title: string;
    frequency: string;
    target_count: number;
    color: string | null;
    streak: number;
    created_at: string;
  }>;
  loading: boolean;
  toggleLog: (habitId: string) => Promise<unknown>;
  deleteHabit: (habitId: string) => Promise<unknown>;
}

export function HabitTracker({ habits, loading, toggleLog, deleteHabit }: HabitTrackerProps) {
  const weekDays = getLast7Days();
  const today = dateStr(new Date());

  const isToday = (d: Date) => dateStr(d) === today;

  if (loading) {
    return (
      <div className="card p-4 space-y-3">
        <h3 className="text-sm font-semibold text-primary">Habits</h3>
        <div className="text-xs text-muted text-center py-4">Loading...</div>
      </div>
    );
  }

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-primary">Habits</h3>
        <span className="text-[10px] text-muted">{habits.length} tracking</span>
      </div>

      {habits.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-3 py-4 text-center">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
          </span>
          <p className="text-xs font-semibold text-primary">No habits yet</p>
          <p className="text-[11px] text-secondary">Add one with the button above.</p>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center gap-1 pl-[100px]">
          {weekDays.map((d) => (
            <div
              key={d.toISOString()}
              className={`flex-1 text-center text-[9px] font-medium ${isToday(d) ? "text-accent" : "text-muted"}`}
            >
              {DAYS[new Date(d).getDay() === 0 ? 6 : new Date(d).getDay() - 1]}
            </div>
          ))}
        </div>

        {habits.map((habit) => (
          <div key={habit.id} className="flex items-center gap-1">
            <div className="w-[100px] flex items-center gap-2 shrink-0">
              <span className="text-xs text-secondary truncate flex-1">{habit.title}</span>
            </div>
            <div className="flex gap-1 flex-1">
              {weekDays.map((d) => (
                <button
                  key={d.toISOString()}
                  onClick={() => isToday(d) && toggleLog(habit.id)}
                  className={`flex-1 h-7 rounded-md transition-all ${
                    isToday(d)
                      ? `cursor-pointer hover:opacity-80`
                      : "cursor-default opacity-40"
                  }`}
                  style={{ backgroundColor: habit.color || "var(--bg-elevated)" }}
                />
              ))}
            </div>
            <span className="text-[10px] text-muted w-8 text-right">{habit.streak}d</span>
            <button
              onClick={() => deleteHabit(habit.id)}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-base text-muted transition-colors hover:bg-danger/20 hover:text-danger"
              aria-label={`Delete ${habit.title}`}
              title="Delete habit"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}