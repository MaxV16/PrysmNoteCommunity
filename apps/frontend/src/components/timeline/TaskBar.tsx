"use client";

import { useDraggable } from "@dnd-kit/core";
import type { Task } from "@/types/task";

interface TaskBarProps {
  task: Task;
  style: React.CSSProperties;
  onClick?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  backlog: "var(--text-muted)",
  todo: "var(--accent)",
  in_progress: "var(--warning)",
  done: "var(--success)",
  cancelled: "var(--danger)",
};

const PRIORITY_COLORS: Record<number, string> = {
  1: "#ef5350",
  2: "#ffa726",
  3: "#4fc3f7",
  4: "#66bb6a",
  5: "#9e9e9e",
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

  const barColor = PRIORITY_COLORS[task.priority] || STATUS_COLORS[task.status] || "var(--text-muted)";
  const isDone = task.status === "done";
  const isInProgress = task.status === "in_progress";

  const barStyle: React.CSSProperties = {
    ...style,
    backgroundColor: barColor + "25",
    borderLeftColor: barColor,
    transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
    zIndex: isDragging ? 100 : undefined,
    opacity: isDone ? 0.5 : 1,
    boxShadow: isDragging ? "var(--shadow-lg)" : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`task-bar group ${
        isDragging ? "ring-2 ring-accent/50 scale-[1.02]" : ""
      } ${
        isInProgress ? "animate-pulse-subtle" : ""
      }`}
      style={barStyle}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      title={`${task.title}${task.description ? " - " + task.description : ""}`}
    >
      <div className="flex items-center gap-1.5 truncate">
        {task.priority <= 2 && (
          <span className="shrink-0 text-[10px] opacity-70">{PRIORITY_LABELS[task.priority]}</span>
        )}
        <span className={`truncate ${isDone ? "line-through" : ""}`}>
          {task.title}
        </span>
      </div>
      {isInProgress && (
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/10">
          <div
            className="h-full rounded-full bg-accent/50 animate-pulse"
            style={{ width: "60%" }}
          />
        </div>
      )}
    </div>
  );
}