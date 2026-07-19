"use client";

import { useMemo } from "react";
import type { Task } from "@/types/task";
import { TaskBar } from "./TaskBar";

interface TimelineLaneProps {
  label: string;
  tasks: Task[];
  days: Date[];
  projectId?: string;
  onTaskClick?: (id: string) => void;
  onDayDoubleClick?: (day: Date) => void;
}

function getTaskPosition(task: Task, days: Date[]) {
  const taskStart = task.start_date ? new Date(task.start_date) : null;
  const taskEnd = task.due_date ? new Date(task.due_date) : null;
  if (!taskStart && !taskEnd) return null;

  const startOfFirstDay = new Date(days[0]);
  startOfFirstDay.setHours(0, 0, 0, 0);
  const endOfLastDay = new Date(days[days.length - 1]);
  endOfLastDay.setHours(23, 59, 59, 999);
  const dayWidth = 100 / days.length;

  const refDate = taskStart || taskEnd!;
  if (refDate < startOfFirstDay || refDate > endOfLastDay) return null;

  let dayIndex = 0;
  for (let i = 0; i < days.length; i++) {
    const d = new Date(days[i]);
    d.setHours(0, 0, 0, 0);
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    if (refDate >= d && refDate < next) {
      dayIndex = i;
      break;
    }
  }

  let span = 1;
  if (taskStart && taskEnd) {
    const diffMs = taskEnd.getTime() - taskStart.getTime();
    span = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1);
  }

  return {
    left: `${dayIndex * dayWidth}%`,
    width: `${span * dayWidth}%`,
  };
}

export function TimelineLane({ label, tasks, days, onTaskClick, onDayDoubleClick }: TimelineLaneProps) {
  const dayWidth = `${100 / days.length}%`;

  const positionedTasks = useMemo(
    () =>
      tasks
        .map((task) => ({ task, pos: getTaskPosition(task, days) }))
        .filter((t): t is { task: Task; pos: NonNullable<ReturnType<typeof getTaskPosition>> } => t.pos !== null),
    [tasks, days]
  );

  return (
    <div className="group flex border-b border-border/60 hover:bg-hover/20 transition-colors">
      <div className="flex w-40 shrink-0 items-center gap-2 border-r border-border px-3 py-2">
        <span className="truncate text-xs font-medium text-secondary">{label}</span>
        {tasks.length > 0 && (
          <span className="text-[10px] text-muted opacity-0 group-hover:opacity-100 transition-opacity">
            {tasks.length}
          </span>
        )}
      </div>
      <div className="relative flex-1" style={{ minHeight: 48 }}>
        {positionedTasks.map(({ task, pos }) => (
          <TaskBar
            key={task.id}
            task={task}
            style={{ left: pos.left, width: pos.width, top: task.priority === 1 ? 2 : 4 }}
            onClick={() => onTaskClick?.(task.id)}
          />
        ))}
        {onDayDoubleClick && (
          <div className="absolute inset-0 flex pointer-events-none">
            {days.map((day) => (
              <div
                key={day.toISOString()}
                className="pointer-events-auto"
                style={{ width: dayWidth }}
                onDoubleClick={() => onDayDoubleClick(day)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}