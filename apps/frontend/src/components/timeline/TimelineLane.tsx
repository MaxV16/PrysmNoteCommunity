"use client";

import { memo, useMemo, useRef, useCallback } from "react";
import type { Task } from "@/types/task";
import { useAppStore } from "@/stores/app-store";
import { TaskBarView } from "./TaskBar";
import { computeLaneLayout } from "./lane-layout";
import { MIN_LANE_HEIGHT, useTimelineMetrics, type TimelineMetrics } from "./constants";

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
 * The lane's day hit layer: ONE element instead of one div (plus one "+"
 * button) per rendered day. The slice is 260 days wide and the timeline mounts
 * a lane per section, so the old shape created thousands of nodes and thousands
 * of handlers, all re-rendered on a slice shift. Here the day is derived from
 * the pointer position at event time (one rect read, no layout writes) and a
 * single "+" button is parked over the hovered day imperatively, so hovering
 * costs no React render at all.
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
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const hoverIndexRef = useRef(-1);
  // Fallback double-click detection for Windows/macOS where onDoubleClick may not fire reliably
  const lastClickRef = useRef<{ time: number; index: number } | null>(null);
  // Set when the mousedown fallback already fired, so the native dblclick that
  // follows the same press does not create the task twice.
  const suppressUntilRef = useRef(0);

  const indexAt = useCallback(
    (clientX: number): number => {
      const el = overlayRef.current;
      if (!el || days.length === 0) return -1;
      const rect = el.getBoundingClientRect();
      const index = Math.floor((clientX - rect.left) / dayWidth);
      if (index < 0 || index >= days.length) return -1;
      return index;
    },
    [dayWidth, days.length]
  );

  const placeAddButton = useCallback(
    (index: number) => {
      const button = addRef.current;
      if (!button) return;
      if (index < 0) {
        button.style.opacity = "0";
        button.style.pointerEvents = "none";
        return;
      }
      button.style.left = `${index * dayWidth + dayWidth / 2}px`;
      button.style.opacity = "1";
      button.style.pointerEvents = "auto";
    },
    [dayWidth]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === "touch") return;
      const index = indexAt(e.clientX);
      // Only touch the DOM when the hovered day actually changed.
      if (index === hoverIndexRef.current) return;
      hoverIndexRef.current = index;
      placeAddButton(index);
    },
    [indexAt, placeAddButton]
  );

  const handlePointerLeave = useCallback(() => {
    if (hoverIndexRef.current === -1) return;
    hoverIndexRef.current = -1;
    placeAddButton(-1);
  }, [placeAddButton]);

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!onDayDoubleClick) return;
      if (Date.now() < suppressUntilRef.current) return;
      const index = indexAt(e.clientX);
      if (index < 0) return;
      onDayDoubleClick(days[index]);
    },
    [days, indexAt, onDayDoubleClick]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!onDayDoubleClick) return;
      const index = indexAt(e.clientX);
      if (index < 0) return;
      const now = Date.now();
      const last = lastClickRef.current;
      if (last && now - last.time < 300 && last.index === index) {
        suppressUntilRef.current = now + 400;
        lastClickRef.current = null;
        onDayDoubleClick(days[index]);
      } else {
        lastClickRef.current = { time: now, index };
      }
    },
    [days, indexAt, onDayDoubleClick]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!onDayContextMenu) return;
      const index = indexAt(e.clientX);
      if (index < 0) return;
      onDayContextMenu(e, days[index]);
    },
    [days, indexAt, onDayContextMenu]
  );

  const handleAddClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      const index = hoverIndexRef.current;
      if (!onDayAdd || index < 0 || index >= days.length) return;
      onDayAdd(days[index]);
    },
    [days, onDayAdd]
  );

  return (
    <div
      ref={overlayRef}
      data-lane-day-overlay={true}
      className="group absolute inset-0 z-0 cursor-pointer"
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
      onDoubleClick={handleDoubleClick}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
    >
      {onDayAdd && (
        <button
          ref={addRef}
          onClick={handleAddClick}
          aria-label="Add task on this day"
          style={{ left: 0, opacity: 0, pointerEvents: "none" }}
          className="absolute top-1.5 z-30 hidden h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-elevated text-secondary transition-opacity hover:bg-hover hover:text-primary md:flex"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}
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
  metrics,
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
  metrics: TimelineMetrics;
}) {
  const style = useMemo(() => ({ left, width, top }), [left, width, top]);
  const handleClick = useCallback(() => onTaskClick?.(task.id), [onTaskClick, task.id]);
  return (
    <TaskBarView
      task={task}
      style={style}
      onClick={handleClick}
      onContextMenu={onTaskContextMenu}
      dragDisabled={dragDisabled}
      selected={selected}
      selectMode={selectMode}
      metrics={metrics}
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
  // O(1) membership per bar instead of an O(n) `includes` scan per bar (which
  // is O(n^2) across a lane) on every selection change or parent render.
  const selectedSet = useMemo(() => new Set(selectedTaskIds), [selectedTaskIds]);
  const metrics = useTimelineMetrics();
  const { positioned, height } = useMemo(() => computeLaneLayout(tasks, days, metrics, dayWidth), [tasks, days, metrics, dayWidth]);
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
      className="relative border-b border-border/30 hover:bg-hover/10"
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
      <div className="absolute inset-0 z-10 pointer-events-none">
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
            selected={selectedSet.has(task.id)}
            selectMode={selectMode}
            metrics={metrics}
          />
        ))}
      </div>
    </div>
  );
});
