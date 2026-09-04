"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "@/types/task";
import { useAppStore } from "@/stores/app-store";
import { TIER_COLORS, normalizePriority } from "@/lib/priority";
import { formatDate } from "@/lib/dates";

const PRIORITY_COLORS = TIER_COLORS;

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

  return formatDate(date, { includeYear: false });
}

interface KanbanCardProps {
  task: Task;
  sectionId?: string | null;
  onContextMenu?: (e: React.MouseEvent, task: Task) => void;
  selected?: boolean;
}

export function KanbanCard({ task, sectionId, onContextMenu, selected }: KanbanCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: { task, sectionId },
  });

  const setSelectedTaskId = useAppStore((s) => s.setSelectedTaskId);
  const toggleTaskSelected = useAppStore((s) => s.toggleTaskSelected);
  const clearTaskSelection = useAppStore((s) => s.clearTaskSelection);

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      data-kanban-card={true}
      style={style}
      className={`bg-elevated border rounded-xl p-3 cursor-grab hover:bg-hover transition-colors ${
        selected ? "border-accent bg-accent/5 ring-2 ring-accent/70" : "border-border"
      }`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) {
          e.preventDefault();
          e.stopPropagation();
          toggleTaskSelected(task.id);
          return;
        }
        clearTaskSelection();
        setSelectedTaskId(task.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu?.(e, task);
      }}
    >
      <div className="flex items-start gap-2" {...attributes} {...listeners}>
        <span
          className="mt-0.5 block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: PRIORITY_COLORS[normalizePriority(task.priority)] || "#9E9E9E" }}
        />
        <span className="text-sm text-primary leading-snug">{task.title}</span>
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs">
        {task.due_date && (
          <span className="text-muted">
            {formatDueDate(task.due_date)}
          </span>
        )}
      </div>
    </div>
  );
}
