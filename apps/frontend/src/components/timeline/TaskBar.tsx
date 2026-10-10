"use client";

import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Task } from "@/types/task";
import { useAppStore } from "@/stores/app-store";
import { TIER_COLORS, TIER_LABELS, normalizePriority, type PriorityTier } from "@/lib/priority";
import { taskTimeLabel } from "@/lib/task-time";
import { parseLocalDate } from "@/lib/utils";
import { useTimelineBarDrag } from "@/hooks/useTimelineBarDrag";
import { useUiScale } from "@/lib/ui-scale-context";
import { BAR_HEIGHT } from "./constants";

/** Compact "Mar 5 - Mar 12" label for the live resize preview. */
function formatResizeRange(start: string, due: string) {
  const fmt = (iso: string) =>
    parseLocalDate(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return start === due ? fmt(start) : `${fmt(start)} - ${fmt(due)}`;
}

interface TaskBarProps {
  task: Task;
  style: React.CSSProperties;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent, task: Task) => void;
  dragDisabled?: boolean;
  selected?: boolean;
  selectMode?: boolean;
}

/**
 * A resize handle on the left or right edge of a task bar. It shares the bar's
 * pointer engine (so move/resize/auto-scroll all behave the same) and is a
 * touch-sized hit area that sits just outside the bar edge, so a finger can
 * grab it on a phone. On a fine pointer (desktop) it is hidden until the bar is
 * hovered; on a coarse pointer (touch) it is inert until the task is armed by a
 * long press, so a stray tap near an edge moves the task instead of resizing it
 * and the whole bar stays long-pressable. It activates on movement like a mouse
 * so a touch grab resizes immediately.
 */
function ResizeHandle({
  task,
  side,
  disabled,
  armed,
}: {
  task: Task;
  side: "left" | "right";
  disabled?: boolean;
  armed?: boolean;
}) {
  const { ref, onPointerDown, resizePreview } = useTimelineBarDrag(
    task,
    side === "left" ? "resize-left" : "resize-right",
    disabled,
    { touchActivateOnMove: true }
  );
  // The preview badge is portaled to the body and pinned just above the bar
  // using its live rect.
  const [badgePos, setBadgePos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!resizePreview || !ref.current) {
      setBadgePos(null);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    setBadgePos({ top: r.top - 30, left: r.left + r.width / 2 });
  }, [resizePreview, ref]);
  return (
    <>
      <div
        ref={ref}
        data-resize-handle={side}
        onPointerDown={onPointerDown}
        role="separator"
        aria-orientation="vertical"
        aria-label={`${side === "left" ? "Resize start" : "Resize end"}`}
        className={`absolute inset-y-0 z-10 flex items-center justify-center transition-opacity duration-150 ${
          armed
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0 group-hover/bar:opacity-100 group-focus-within/bar:opacity-100 pointer-fine:pointer-events-auto"
        }`}
        style={{
          [side]: side === "left" ? "-8px" : undefined,
          right: side === "right" ? "-8px" : undefined,
          width: 24,
          cursor: side === "left" ? "w-resize" : "e-resize",
          touchAction: "none",
        }}
      >
        <span
          className="pointer-events-none h-4 w-1 rounded-full bg-primary/80 shadow-sm"
          aria-hidden="true"
        />
      </div>
      {resizePreview &&
        badgePos &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[120] whitespace-nowrap rounded-md border border-border bg-elevated px-2 py-0.5 text-[10px] font-semibold text-primary shadow-lg"
            style={{ top: badgePos.top, left: badgePos.left, transform: "translateX(-50%)" }}
          >
            {formatResizeRange(resizePreview.start, resizePreview.due)}
          </div>,
          document.body
        )}
    </>
  );
}

export const TaskBar = memo(function TaskBar({ task, style, onClick, onContextMenu, dragDisabled, selected, selectMode }: TaskBarProps) {
  // A stationary touch hold opens the mobile action bar on release. The pointer
  // engine owns the whole gesture, for draggable and drag-disabled (done) bars
  // alike, so there is exactly one long-press system and one timer.
  const { ref, onPointerDown, dragging } = useTimelineBarDrag(task, "move", dragDisabled, {
    onLongPress: () => useAppStore.getState().setMobileActionTaskId(task.id),
  });
  // When this task is armed by a long press, its resize handles stay visible so
  // the finger can grab one without hovering. On desktop they show on hover.
  const armed = useAppStore((s) => s.mobileActionTaskId === task.id);
  // Bar height follows the device-local interface size (floor 24px) so a task
  // shrinks with the rest of the UI but stays tappable.
  const { scale } = useUiScale();
  // Which pointer started the current press. A touch hold already opens the
  // bottom action bar, so the floating right-click menu must stay closed on
  // touch (it would duplicate the same actions and cover the task being moved).
  const lastPointerTypeRef = useRef<string>("mouse");

  const tier: PriorityTier = normalizePriority(task.priority);
  const colors = { bg: TIER_COLORS[tier], border: TIER_COLORS[tier], text: "#ffffff" };
  const isDone = task.status === "done";
  const isInProgress = task.status === "in_progress";
  const timeLabel = taskTimeLabel(task);

  const barStyle = {
    ...style,
    position: "absolute",
    height: Math.max(24, Math.round(BAR_HEIGHT * scale)),
    backgroundColor: colors.bg,
    backgroundClip: "padding-box",
    border: `1px solid ${colors.border}`,
    borderLeftWidth: 0,
    borderRightWidth: 0,
    borderRadius: 6,
    padding: "6px 12px",
    display: "flex",
    alignItems: "center",
    cursor: "move",
    // The bar owns its gesture so the browser never turns a touch drag on a bar
    // into a canvas pan (which would cancel the pointer sequence mid-drag).
    touchAction: "none",
    userSelect: "none",
    WebkitTouchCallout: "none",
    WebkitUserSelect: "none",
    WebkitUserDrag: "none",
    minWidth: 0,
    overflow: "visible",
    zIndex: dragging ? 100 : 20,
    opacity: isDone ? 0.65 : 1,
    boxShadow: [
      `inset 3px 0 0 0 ${colors.border}`,
      dragging
        ? "0 8px 24px rgba(0,0,0,0.35)"
        : selected
        ? "0 0 0 2px var(--accent), 0 4px 12px rgba(0,0,0,0.3)"
        : "",
    ]
      .filter(Boolean)
      .join(", "),
    pointerEvents: "auto",
    transition: "opacity var(--dur-base, 180ms) ease, box-shadow var(--dur-fast, 120ms) ease",
  } as React.CSSProperties;

  return (
    <div
      ref={ref}
      data-task-bar={true}
      data-task-id={task.id}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        lastPointerTypeRef.current = e.pointerType || "mouse";
        // The drag engine owns the whole gesture, including the touch hold that
        // opens the mobile action bar, and stops propagation so the canvas never
        // pans from a bar.
        onPointerDown(e);
      }}
      style={barStyle}
      onClick={(e) => {
        e.stopPropagation();
        if (selectMode) {
          e.preventDefault();
          const { toggleTaskSelected } = useAppStore.getState();
          toggleTaskSelected(task.id);
          return;
        }
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          const { toggleTaskSelected } = useAppStore.getState();
          toggleTaskSelected(task.id);
          return;
        }
        const { clearTaskSelection } = useAppStore.getState();
        clearTaskSelection();
        onClick?.();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // Touch: the bottom action bar is the menu, so do not also open the
        // floating one (it duplicates the actions and covers the task).
        if (lastPointerTypeRef.current === "touch") return;
        onContextMenu?.(e, task);
      }}
      title={`${task.title}${timeLabel ? ` (${timeLabel})` : ""}${task.description ? " - " + task.description : ""}`}
      className={`group/bar transition-[filter] hover:brightness-110 ${
        dragging ? "ring-2 ring-accent/40" : isInProgress ? "animate-pulse-subtle" : ""
      }`}
    >
      {/* Resize handles: drag the left edge to move the start date, the right
          edge to move the due date, extending/contracting the task. */}
      <ResizeHandle task={task} side="left" disabled={dragDisabled} armed={armed} />
      <ResizeHandle task={task} side="right" disabled={dragDisabled} armed={armed} />
      {/* Label is capped so a task spanning many weeks reads as a band with a
          title at its start instead of a wall of text running off-screen. It
          clips its own text since the bar no longer clips (the handles sit
          just outside the edges). */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden" style={{ maxWidth: 320 }}>
        {timeLabel && (
          <span className="shrink-0 rounded-full bg-surface/70 px-1.5 py-0.5 text-[9px] font-semibold text-primary">
            {timeLabel}
          </span>
        )}
        {tier === 1 && (
          <span className="shrink-0 text-[9px] font-semibold uppercase text-primary">
            {TIER_LABELS[tier]}
          </span>
        )}
        <span className="truncate text-sm text-scale-sm font-medium text-primary">
          {task.title}
        </span>
      </div>
      {task.tags && task.tags.length > 0 && (
        <span className="ml-auto flex shrink-0 gap-0.5 pl-2">
          {task.tags.slice(0, 3).map((tag) => (
            <span
              key={tag.id}
              className="h-1.5 w-1.5 rounded-full shrink-0"
              style={{ backgroundColor: tag.color || "var(--text-muted)" }}
              title={tag.name}
            />
          ))}
        </span>
      )}
    </div>
  );
});
