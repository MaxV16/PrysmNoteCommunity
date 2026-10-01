"use client";

import { memo, useMemo, useRef, useCallback } from "react";
import type { Task } from "@/types/task";
import { useAppStore } from "@/stores/app-store";
import { TaskBar } from "./TaskBar";
import { computeLaneLayout } from "./lane-layout";
import { MIN_LANE_HEIGHT } from "./constants";

interface TimelineLaneProps {
  tasks: Task[];
  days: Date[];
  dayWidth?: number;
  onTaskClick?: (id: string) => void;
  onDayDoubleClick?: (day: Date, sectionId?: string | null) => void;
  onDayAdd?: (day: Date, sectionId?: string | null) => void;
  onTaskContextMenu?: (e: React.MouseEvent, task: Task) => void;
  onDayContextMenu?: (
    e: React.MouseEvent,
    day: Date,
    section?: { id: string | null; title: string } | null
  ) => void;
  rowLabel?: React.ReactNode;
  rowHeight?: number;
  dragDisabled?: boolean;
  selectMode?: boolean;
  /** The board section this lane renders, so a day created from it lands there. */
  sectionId?: string | null;
  /** Display name of the lane's section, shown in the day context menu. */
  sectionLabel?: string | null;
}

/**
 * The per-day hover targets (double-click to add, right-click for the day menu,
 * the "+" button). Split out and memoized so the 260 cells per lane are not
 * re-rendered when the parent lane re-renders for an unrelated reason (a pan, a
 * selection change, a drag). Cell keys are slice indices, so a slice shift
 * patches them in place instead of recreating them.
 */
const LaneDayOverlay = memo(function LaneDayOverlay({
  days,
  dayWidth,
  onDayDoubleClick,
  onDayAdd,
  onDayContextMenu,
}: {
  days: Date[];
  dayWidth: number;
  onDayDoubleClick?: (day: Date) => void;
  onDayAdd?: (day: Date) => void;
  onDayContextMenu?: (e: React.MouseEvent, day: Date) => void;
}) {
  // Fallback double-click detection for Windows/macOS where onDoubleClick may not fire reliably
  const lastClickRef = useRef<{ time: number; day: Date } | null>(null);

  const handleMouseDown = useCallback(
    (day: Date) => {
      const now = Date.now();
      const last = lastClickRef.current;
      if (last && now - last.time < 300 && last.day === day) {
        // Double-click detected
        onDayDoubleClick?.(day);
        lastClickRef.current = null;
      } else {
        lastClickRef.current = { time: now, day };
      }
    },
    [onDayDoubleClick]
  );

  return (
    <div className="absolute inset-0 flex pointer-events-none z-0">
      {days.map((day, index) => (
        <div
          key={`lane-day-${index}`}
          className="group pointer-events-auto relative cursor-pointer"
          style={{ width: dayWidth, minWidth: dayWidth, flex: `0 0 ${dayWidth}px` }}
          onDoubleClick={() => onDayDoubleClick?.(day)}
          onMouseDown={() => handleMouseDown(day)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDayContextMenu?.(e, day);
          }}
        >
          {onDayAdd && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDayAdd(day);
              }}
              aria-label={`Add task on ${day.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`}
              className="absolute left-1/2 top-1.5 z-30 hidden h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-elevated text-secondary opacity-0 transition-opacity hover:bg-hover hover:text-primary group-hover:opacity-100 md:flex"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          )}
        </div>
      ))}
    </div>
  );
});

/**
 * One task bar, split out and memoized so a bar whose task/position/selection
 * did not change is not re-rendered when the parent lane re-renders (pan,
 * selection change, another task's drag). The style object and click handler are
 * built here (and kept stable) instead of inline in the map, which is what
 * previously defeated `TaskBar`'s memo on every parent render.
 */
const TimelineTaskBar = memo(function TimelineTaskBar({
  task,
  left,
  top,
  width,
  onTaskClick,
  onTaskContextMenu,
  dragDisabled,
  selected,
  selectMode,
}: {
  task: Task;
  left: number | string;
  top: number | string;
  width: number | string;
  onTaskClick?: (id: string) => void;
  onTaskContextMenu?: (e: React.MouseEvent, task: Task) => void;
  dragDisabled?: boolean;
  selected: boolean;
  selectMode?: boolean;
}) {
  const style = useMemo(() => ({ left, width, top }), [left, width, top]);
  const handleClick = useCallback(() => onTaskClick?.(task.id), [onTaskClick, task.id]);
  return (
    <TaskBar
      task={task}
      style={style}
      onClick={handleClick}
      onContextMenu={onTaskContextMenu}
      dragDisabled={dragDisabled}
      selected={selected}
      selectMode={selectMode}
    />
  );
});

/**
 * One swimlane: a row of task bars over the day columns. Memoized so a parent
 * re-render that does not change this lane's tasks/days does not recompute the
 * lane layout or rebuild any bars.
 */
export const TimelineLane = memo(function TimelineLane({ tasks, days, dayWidth = 120, onTaskClick, onDayDoubleClick, onDayAdd, onTaskContextMenu, onDayContextMenu, rowHeight, dragDisabled, selectMode, sectionId = null, sectionLabel = null }: TimelineLaneProps) {
  const selectedTaskIds = useAppStore((s) => s.selectedTaskIds);
  const { positioned, height } = useMemo(() => computeLaneLayout(tasks, days), [tasks, days]);
  const laneHeight = rowHeight ?? height;

  const handleDayDoubleClick = useCallback(
    (day: Date) => onDayDoubleClick?.(day, sectionId),
    [onDayDoubleClick, sectionId]
  );
  const handleDayAdd = useCallback(
    (day: Date) => onDayAdd?.(day, sectionId),
    [onDayAdd, sectionId]
  );
  const handleDayContextMenu = useCallback(
    (e: React.MouseEvent, day: Date) =>
      onDayContextMenu?.(
        e,
        day,
        sectionId ? { id: sectionId, title: sectionLabel ?? "" } : null
      ),
    [onDayContextMenu, sectionId, sectionLabel]
  );

  return (
    <div
      className="relative border-b border-border/30 hover:bg-hover/10 transition-colors"
      style={{ minHeight: MIN_LANE_HEIGHT, height: laneHeight }}
    >
      {(onDayDoubleClick || onDayAdd) && (
        <LaneDayOverlay
          days={days}
          dayWidth={dayWidth}
          onDayDoubleClick={onDayDoubleClick ? handleDayDoubleClick : undefined}
          onDayAdd={onDayAdd ? handleDayAdd : undefined}
          onDayContextMenu={onDayContextMenu ? handleDayContextMenu : undefined}
        />
      )}
      <div className="absolute inset-0 z-20 pointer-events-none">
        {positioned.map(({ task, pos }) => (
          <TimelineTaskBar
            key={task.id}
            task={task}
            left={pos.left}
            top={pos.top}
            width={pos.width}
            onTaskClick={onTaskClick}
            onTaskContextMenu={onTaskContextMenu}
            dragDisabled={dragDisabled}
            selected={selectedTaskIds.includes(task.id)}
            selectMode={selectMode}
          />
        ))}
      </div>
    </div>
  );
});
