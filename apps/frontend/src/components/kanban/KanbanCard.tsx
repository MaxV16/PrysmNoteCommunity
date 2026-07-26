"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "@/types/task";
import { useAppStore } from "@/stores/app-store";

const PRIORITY_COLORS: Record<number, string> = {
  1: "#EF5350",
  2: "#FFA726",
  3: "#4FC3F7",
  4: "#66BB6A",
  5: "#9E9E9E",
};

function formatDueDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = date.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Tomorrow";
  if (diffDays === -1) return "Yesterday";
  if (diffDays < -1 && diffDays > -7) return `${Math.abs(diffDays)}d ago`;
  if (diffDays > 1 && diffDays < 7) return `in ${diffDays}d`;

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

interface KanbanCardProps {
  task: Task;
}

export function KanbanCard({ task }: KanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: { task },
  });

  const setSelectedTaskId = useAppStore((s) => s.setSelectedTaskId);
  const projects = useAppStore((s) => s.projects);
  const project = task.project_id
    ? projects.find((p) => p.id === task.project_id)
    : null;

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="bg-elevated border border-border rounded-xl p-3 cursor-grab hover:bg-hover transition-colors"
      onClick={() => setSelectedTaskId(task.id)}
    >
      <div className="flex items-start gap-2" {...attributes} {...listeners}>
        <span
          className="mt-0.5 block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: PRIORITY_COLORS[task.priority] || "#9E9E9E" }}
        />
        <span className="text-sm text-primary leading-snug">{task.title}</span>
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs">
        {task.due_date && (
          <span className="text-muted">
            {formatDueDate(task.due_date)}
          </span>
        )}
        {project && (
          <span className="flex items-center gap-1 text-secondary">
            <span
              className="block h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: project.color || "#888" }}
            />
            {project.name}
          </span>
        )}
      </div>
    </div>
  );
}
