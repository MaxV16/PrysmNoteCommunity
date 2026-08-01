"use client";

import { useState, useMemo } from "react";
import { useAppStore } from "@/stores/app-store";
import type { Task } from "@/types/task";
import { Modal } from "@/components/ui/Modal";
import { TaskForm } from "@/components/tasks/TaskForm";
import { useTasks } from "@/hooks/useTasks";
import { TIER_COLORS, normalizePriority } from "@/lib/priority";

const PRIORITY_COLORS = TIER_COLORS;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAY_HEADERS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function CalendarView() {
  const tasks = useAppStore((s) => s.tasks);
  const setSelectedTaskId = useAppStore((s) => s.setSelectedTaskId);
  const { createTask } = useTasks();
  const [viewDate, setViewDate] = useState(() => new Date());
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [formDefaultDate, setFormDefaultDate] = useState<Date | null>(null);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startOffset = (firstDay.getDay() + 6) % 7;

  const tasksByDate = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const task of tasks) {
      if (task.is_archived || task.status === "done" || task.status === "cancelled") continue;
      const dates = new Set<string>();
      if (task.start_date) dates.add(task.start_date);
      if (task.due_date) dates.add(task.due_date);
      for (const ds of dates) {
        if (!map[ds]) map[ds] = [];
        map[ds].push(task);
      }
    }
    return map;
  }, [tasks]);

  const prevMonth = () => setViewDate(new Date(year, month - 1, 1));
  const nextMonth = () => setViewDate(new Date(year, month + 1, 1));

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const handleDayDoubleClick = (day: number) => {
    setFormDefaultDate(new Date(year, month, day));
    setShowTaskForm(true);
  };

  const handleCreateTask = async (data: Record<string, unknown>) => {
    await createTask(data);
    setShowTaskForm(false);
    setFormDefaultDate(null);
  };

  return (
    <div className="flex flex-col h-full bg-base">
      <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2 shrink-0">
        <button onClick={prevMonth} className="btn bg-elevated px-3 py-1.5 text-xs text-secondary hover:bg-hover">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <span className="text-sm font-semibold text-primary">{MONTHS[month]} {year}</span>
        <button onClick={nextMonth} className="btn bg-elevated px-3 py-1.5 text-xs text-secondary hover:bg-hover">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </button>
      </div>

      <div className="grid grid-cols-7 border-b border-border bg-surface shrink-0">
        {DAY_HEADERS.map((h) => (
          <div key={h} className="text-center text-[10px] font-semibold uppercase text-muted py-2 border-r border-border/30 last:border-r-0">
            {h}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 flex-1" style={{ gridTemplateRows: `repeat(${Math.ceil((lastDay.getDate() + startOffset) / 7)}, minmax(0, 1fr))` }}>
        {Array.from({ length: startOffset }).map((_, i) => (
          <div key={`empty-${i}`} className="border-r border-b border-border/20" />
        ))}
        {Array.from({ length: lastDay.getDate() }, (_, i) => i + 1).map((d) => {
          const ds = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const isToday = ds === todayStr;
          const dayTasks = tasksByDate[ds] || [];
          const maxShown = 3;

          return (
            <div
              key={d}
              className="border-r border-b border-border/20 p-1 overflow-hidden hover:bg-hover/20 transition-colors cursor-pointer"
              onDoubleClick={() => handleDayDoubleClick(d)}
            >
              <span
                className={`inline-flex items-center justify-center text-xs font-medium w-6 h-6 rounded-full mb-0.5 ${
                  isToday ? "bg-accent text-base" : "text-secondary"
                }`}
              >
                {d}
              </span>
              <div className="space-y-0.5">
                {dayTasks.slice(0, maxShown).map((task) => (
                  <div
                    key={task.id}
                    onClick={(e) => { e.stopPropagation(); setSelectedTaskId(task.id); }}
                    className="truncate text-[10px] rounded px-1 py-0.5 leading-tight cursor-pointer hover:brightness-110"
                    style={{
                      backgroundColor: (PRIORITY_COLORS[normalizePriority(task.priority)] || "#9E9E9E") + "22",
                      borderLeft: `2px solid ${PRIORITY_COLORS[normalizePriority(task.priority)] || "#9E9E9E"}`,
                      color: "var(--text-primary)",
                    }}
                  >
                    {task.title}
                  </div>
                ))}
                {dayTasks.length > maxShown && (
                  <span className="text-[9px] text-muted px-1">+{dayTasks.length - maxShown} more</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Modal
        isOpen={showTaskForm && !!formDefaultDate}
        onClose={() => { setShowTaskForm(false); setFormDefaultDate(null); }}
        title="Create Task"
      >
        <TaskForm
          onSubmit={handleCreateTask}
          onCancel={() => { setShowTaskForm(false); setFormDefaultDate(null); }}
          defaultDate={formDefaultDate?.toISOString().split("T")[0]}
        />
      </Modal>
    </div>
  );
}
