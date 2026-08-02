"use client";

import { useMemo } from "react";
import type { Task } from "@/types/task";
import { TaskBar } from "./TaskBar";
import { parseLocalDate } from "@/lib/utils";
import { DAY_WIDTH, BAR_HEIGHT, BAR_GAP, TOP_PADDING } from "./constants";

interface TimelineLaneProps {
  tasks: Task[];
  days: Date[];
  onTaskClick?: (id: string) => void;
  onDayDoubleClick?: (day: Date) => void;
  rowLabel?: React.ReactNode;
  rowHeight?: number;
}

interface PositionedTask {
  task: Task;
  pos: { left: number; width: number; dayIndex: number };
}

function getTaskDayInfo(task: Task, days: Date[]): { index: number; endIndex: number } | null {
  const taskStart = task.start_date ? parseLocalDate(task.start_date) : null;
  const taskEnd = task.due_date ? parseLocalDate(task.due_date) : null;
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

  let endIndex = dayIndex;
  if (taskStart && taskEnd) {
    const diffMs = taskEnd.getTime() - taskStart.getTime();
    const span = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1);
    endIndex = dayIndex + span - 1;
  }

  return { index: dayIndex, endIndex };
}

export function TimelineLane({ tasks, days, onTaskClick, onDayDoubleClick, rowHeight }: TimelineLaneProps) {
  const { positioned, maxStack } = useMemo(() => {
    // Determine day column spans for each task.
    const candidates: { task: Task; info: { index: number; endIndex: number } }[] = [];
    for (const task of tasks) {
      const info = getTaskDayInfo(task, days);
      if (info) candidates.push({ task, info });
    }

    // Assign a vertical stack row per task. A task may reuse a row across the
    // whole day range it spans if that row is free on every day it occupies.
    const occupiedByRow: Record<number, number[]> = {}; // row -> occupied day indices
    const assigned: { task: Task; info: { index: number; endIndex: number }; row: number }[] = [];

    for (const c of candidates) {
      let row = 0;
      for (;; row++) {
        const occ = occupiedByRow[row] || [];
        const daysOccupied: number[] = [];
        for (let i = c.info.index; i <= c.info.endIndex; i++) daysOccupied.push(i);
        const conflicts = daysOccupied.some((d) => occ.includes(d));
        if (!conflicts) {
          occupiedByRow[row] = occ.concat(daysOccupied);
          break;
        }
      }
      assigned.push({ ...c, row });
    }

    const totalRows = assigned.reduce((m, a) => Math.max(m, a.row + 1), 0);

    const positioned = assigned.map(({ task, info, row }) => ({
      task,
      pos: {
        left: `${info.index * (100 / days.length)}%`,
        width: `${(info.endIndex - info.index + 1) * (100 / days.length)}%`,
        dayIndex: info.index,
        top: TOP_PADDING + row * (BAR_HEIGHT + BAR_GAP),
      },
    }));

    return { positioned, maxStack: totalRows };
  }, [tasks, days]);

  const computedHeight = TOP_PADDING * 2 + Math.max(1, maxStack) * (BAR_HEIGHT + BAR_GAP) - BAR_GAP;
  const laneHeight = rowHeight ?? computedHeight;

  return (
    <div
      className="relative border-b border-border/30 hover:bg-hover/10 transition-colors"
      style={{ minHeight: 48, height: laneHeight }}
    >
      {onDayDoubleClick && (
        <div className="absolute inset-0 flex pointer-events-none z-0">
          {days.map((day) => (
            <div
              key={day.toISOString()}
              className="pointer-events-auto cursor-pointer"
              style={{ width: DAY_WIDTH, minWidth: DAY_WIDTH, flex: "0 0 120px" }}
              onDoubleClick={() => onDayDoubleClick(day)}
            />
          ))}
        </div>
      )}
      <div className="absolute inset-0 z-20 pointer-events-none">
        {positioned.map(({ task, pos }) => (
          <TaskBar
            key={task.id}
            task={task}
            style={{ left: pos.left, width: pos.width, top: pos.top }}
            onClick={() => onTaskClick?.(task.id)}
          />
        ))}
      </div>
    </div>
  );
}
