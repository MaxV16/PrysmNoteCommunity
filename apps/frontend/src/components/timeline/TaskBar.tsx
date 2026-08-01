"use client";

import { useDraggable } from "@dnd-kit/core";
import type { Task } from "@/types/task";

interface TaskBarProps {
  task: Task;
  style: React.CSSProperties;
  onClick?: () => void;
}

const BAR_COLORS: Record<number, { bg: string; border: string; text: string }> = {
  1: { bg: "#ef5350", border: "#ef5350", text: "#ffffff" },
  2: { bg: "#ffa726", border: "#ffa726", text: "#1a1a2e" },
  3: { bg: "#4fc3f7", border: "#4fc3f7", text: "#1a1a2e" },
  4: { bg: "#66bb6a", border: "#66bb6a", text: "#1a1a2e" },
  5: { bg: "#9e9e9e", border: "#9e9e9e", text: "#ffffff" },
};

const PRIORITY_LABELS: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
  5: "None",
};

export function TaskBar({ task, style, onClick }: TaskBarProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
  });

  const colors = BAR_COLORS[task.priority] || BAR_COLORS[5];
  const isDone = task.status === "done";
  const isInProgress = task.status === "in_progress";

  const barStyle: React.CSSProperties = {
    ...style,
    position: "absolute",
    height: 38,
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
    overflow: "hidden",
    pointerEvents: "auto",
  };

  return (
    <div
      ref={setNodeRef}
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
      <div className="flex items-center gap-1.5 truncate w-full">
        {task.priority <= 2 && (
          <span className="shrink-0 text-[9px] font-semibold uppercase" style={{ color: colors.text }}>
            {PRIORITY_LABELS[task.priority]}
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
