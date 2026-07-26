"use client";

import { useHabits } from "@/hooks/useHabits";

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
  return d.toISOString().slice(0, 10);
}

export function HabitTracker() {
  const { habits, loading, toggleLog, deleteHabit } = useHabits();
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
        <div className="text-xs text-muted text-center py-3">No habits yet. Add one below.</div>
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
          <div key={habit.id} className="flex items-center gap-1 group">
            <div className="w-[100px] flex items-center gap-2 shrink-0">
              <button
                onClick={() => deleteHabit(habit.id)}
                className="opacity-0 group-hover:opacity-100 text-[10px] text-muted hover:text-danger transition-all"
              >
                ×
              </button>
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
          </div>
        ))}
      </div>
    </div>
  );
}
