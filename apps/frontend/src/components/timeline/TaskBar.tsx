"use client";

import { useDraggable } from "@dnd-kit/core";
import type { Task } from "@/types/task";
import { useAppStore } from "@/stores/app-store";
import { useLongPress } from "@/lib/use-long-press";
import { TIER_COLORS, TIER_LABELS, normalizePriority, type PriorityTier } from "@/lib/priority";
import { taskTimeLabel } from "@/lib/task-time";
import { BAR_HEIGHT } from "./constants";

interface TaskBarProps {
  task: Task;
  style: React.CSSProperties;
  onClick?: () => void;
  onContextMenu?: (e: React.MouseEvent, task: Task) => void;
  dragDisabled?: boolean;
  selected?: boolean;
  selectMode?: boolean;
}

// A drag resize handle on the left or right edge of a task bar. Uses dnd-kit so
// the shared onDragEnd/onDragMove handlers can compute the day delta and edge
// auto-expand, with the same pointer sensor as the move-drag.
function ResizeHandle({ taskId, side, disabled }: { taskId: string; side: "left" | "right"; disabled?: boolean }) {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: `${taskId}:${side}`,
    disabled: !!disabled,
  });
  return (
    <div
      ref={setNodeRef}
      data-resize-handle={side}
      {...listeners}
      {...attributes}
      role="separator"
      aria-orientation="vertical"
      aria-label={`${side === "left" ? "Resize start" : "Resize end"}`}
      className="pointer-coarse:hidden absolute inset-y-0 z-10"
      style={{
        [side]: side === "left" ? "-3px" : undefined,
        right: side === "right" ? "-3px" : undefined,
        width: 8,
        cursor: side === "left" ? "w-resize" : "e-resize",
        touchAction: "none",
        pointerEvents: "auto",
      }}
    />
  );
}

export function TaskBar({ task, style, onClick, onContextMenu, dragDisabled, selected, selectMode }: TaskBarProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    disabled: !!dragDisabled,
  });

  // Long-press (touch) opens the same context menu as right-click. On mobile
  // drag is disabled, so a held finger never races a drag gesture; on desktop
  // the press handler is inert (touch pointers only).
  const longPress = useLongPress(
    (p) => {
      const ev = {
        clientX: p.clientX,
        clientY: p.clientY,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.MouseEvent;
      onContextMenu?.(ev, task);
    },
    { disabled: !dragDisabled }
  );

  const tier: PriorityTier = normalizePriority(task.priority);
  const colors = { bg: TIER_COLORS[tier], border: TIER_COLORS[tier], text: "#ffffff" };
  const isDone = task.status === "done";
  const isInProgress = task.status === "in_progress";
  const timeLabel = taskTimeLabel(task);

  const barStyle: React.CSSProperties = {
    ...style,
    position: "absolute",
    height: BAR_HEIGHT,
    backgroundColor: colors.bg + "3D",
    border: `1px solid ${colors.border}33`,
    borderLeft: `3px solid ${colors.border}`,
    borderRadius: 8,
    padding: "6px 12px",
    marginLeft: 4,
    marginRight: 4,
    display: "flex",
    alignItems: "center",
    cursor: "grab",
    minWidth: 0,
    overflow: "hidden",
    transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
    zIndex: isDragging ? 100 : 20,
    opacity: isDone ? 0.5 : 1,
    boxShadow: isDragging ? "0 4px 12px rgba(0,0,0,0.3)" : selected ? "0 0 0 2px var(--accent), 0 4px 12px rgba(0,0,0,0.3)" : undefined,
    pointerEvents: "auto",
  };

  return (
    <div
      ref={setNodeRef}
      data-task-bar={true}
      {...listeners}
      onPointerDown={(e) => {
        // Keep dnd-kit's drag listener (merge, don't override via spread order).
        listeners?.onPointerDown?.(e);
        longPress.onPointerDown(e);
      }}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
      {...attributes}
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
        onContextMenu?.(e, task);
      }}
      title={`${task.title}${timeLabel ? ` (${timeLabel})` : ""}${task.description ? " - " + task.description : ""}`}
      className={isDragging ? "ring-2 ring-white/30 scale-[1.02]" : isInProgress ? "animate-pulse-subtle" : ""}
    >
      {/* Resize handles: drag the left edge to move the start date, the right edge
          to move the due date, extending/contracting the task over multiple days. */}
      <ResizeHandle taskId={task.id} side="left" disabled={dragDisabled} />
      <ResizeHandle taskId={task.id} side="right" disabled={dragDisabled} />
      <div className="flex items-center gap-1.5 truncate w-full" style={{ minWidth: 0 }}>
        {timeLabel && (
          <span className="shrink-0 rounded-full bg-accent/20 px-1.5 py-0.5 text-[9px] font-semibold text-[var(--accent)]">
            {timeLabel}
          </span>
        )}
        {tier === 1 && (
          <span className="shrink-0 text-[9px] font-semibold uppercase" style={{ color: colors.text }}>
            {TIER_LABELS[tier]}
          </span>
        )}
        <span className="truncate text-sm font-medium" style={{ color: colors.border }}>
          {task.title}
        </span>
        {task.tags && task.tags.length > 0 && (
          <span className="flex shrink-0 gap-0.5 ml-auto">
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
    </div>
  );
}
