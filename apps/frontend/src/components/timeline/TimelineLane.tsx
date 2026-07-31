"use client";

import { useMemo } from "react";
import type { Task } from "@/types/task";
import { TaskBar } from "./TaskBar";

interface TimelineLaneProps {
  tasks: Task[];
  days: Date[];
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

  const refDate = taskStart || taskEnd!;
  if (refDate < startOfFirstDay || refDate > endOfLastDay) return null;

  let dayIndex = -1;
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
  if (dayIndex === -1) return null;

  let span = 1;
  if (taskStart && taskEnd) {
    const diffMs = taskEnd.getTime() - taskStart.getTime();
    span = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1);
  }

  return {
    left: `${dayIndex * (100 / days.length)}%`,
    width: `${span * (100 / days.length)}%`,
  };
}

export function TimelineLane({ tasks, days, onTaskClick, onDayDoubleClick }: TimelineLaneProps) {
  const positionedTasks = useMemo(
    () =>
      tasks
        .map((task) => ({ task, pos: getTaskPosition(task, days) }))
        .filter((t): t is { task: Task; pos: NonNullable<ReturnType<typeof getTaskPosition>> } => t.pos !== null),
    [tasks, days]
  );

  return (
    <div className="relative border-b border-border/30 hover:bg-hover/10 transition-colors" style={{ minHeight: 48 }}>
      {positionedTasks.map(({ task, pos }) => (
        <TaskBar
          key={task.id}
          task={task}
          style={{ left: pos.left, width: pos.width, top: 5 }}
          onClick={() => onTaskClick?.(task.id)}
        />
      ))}
      {onDayDoubleClick && (
        <div className="absolute inset-0 flex pointer-events-none z-10">
          {days.map((day) => (
            <div
              key={day.toISOString()}
              className="pointer-events-auto cursor-pointer"
              style={{ minWidth: 120, flex: 1 }}
              onDoubleClick={() => onDayDoubleClick(day)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
