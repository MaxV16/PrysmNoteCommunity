"use client";

import { useDraggable } from "@dnd-kit/core";
import type { Task } from "@/types/task";
import { TIER_COLORS, TIER_LABELS, normalizePriority, type PriorityTier } from "@/lib/priority";
import { BAR_HEIGHT } from "./constants";

interface TaskBarProps {
  task: Task;
  style: React.CSSProperties;
  onClick?: () => void;
}

// A drag resize handle on the left or right edge of a task bar. Uses dnd-kit so
// the shared onDragEnd/onDragMove handlers can compute the day delta and edge
// auto-expand, with the same pointer sensor as the move-drag.
function ResizeHandle({ taskId, side }: { taskId: string; side: "left" | "right" }) {
  const { attributes, listeners, setNodeRef } = useDraggable({
    id: `${taskId}:${side}`,
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
      className="absolute inset-y-0 z-10"
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

export function TaskBar({ task, style, onClick }: TaskBarProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
  });

  const tier: PriorityTier = normalizePriority(task.priority);
  const colors = { bg: TIER_COLORS[tier], border: TIER_COLORS[tier], text: "#ffffff" };
  const isDone = task.status === "done";
  const isInProgress = task.status === "in_progress";

  const barStyle: React.CSSProperties = {
    ...style,
    position: "absolute",
    height: BAR_HEIGHT,
    backgroundColor: colors.bg + "20",
    border: `1px solid ${colors.border}33`,
    borderLeft: `3px solid ${colors.border}`,
    borderRadius: 8,
    padding: "6px 12px",
    marginLeft: 4,
    marginRight: 4,
    display: "flex",
    alignItems: "center",
    cursor: "grab",
    transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
    zIndex: isDragging ? 100 : 20,
    opacity: isDone ? 0.5 : 1,
    boxShadow: isDragging ? "0 4px 12px rgba(0,0,0,0.3)" : undefined,
    pointerEvents: "auto",
  };

  return (
    <div
      ref={setNodeRef}
      data-task-bar={true}
      {...listeners}
      {...attributes}
      style={barStyle}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      title={`${task.title}${task.description ? " - " + task.description : ""}`}
      className={isDragging ? "ring-2 ring-white/30 scale-[1.02]" : isInProgress ? "animate-pulse-subtle" : ""}
    >
      {/* Resize handles: drag the left edge to move the start date, the right edge
          to move the due date, extending/contracting the task over multiple days. */}
      <ResizeHandle taskId={task.id} side="left" />
      <ResizeHandle taskId={task.id} side="right" />
      <div className="flex items-center gap-1.5 truncate w-full">
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
