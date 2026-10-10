"use client";

import { useState } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "@/types/task";
import { useAppStore } from "@/stores/app-store";
import { useTasks } from "@/hooks/useTasks";
import { useLongPress } from "@/lib/use-long-press";
import { TIER_COLORS, normalizePriority } from "@/lib/priority";
import { formatDate } from "@/lib/dates";

const PRIORITY_COLORS = TIER_COLORS;
const VISIBLE_SUBTASKS = 2;

function formatDueDate(dateStr: string): string {
  const date = new Date(dateStr.length === 10 ? `${dateStr}T00:00:00` : dateStr);
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
  subtasks?: Task[];
  sectionId?: string | null;
  onContextMenu?: (e: React.MouseEvent, task: Task) => void;
  selected?: boolean;
}

export function KanbanCard({ task, subtasks = [], sectionId, onContextMenu, selected }: KanbanCardProps) {
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

  const { updateTask } = useTasks();
  const [subtasksExpanded, setSubtasksExpanded] = useState(false);
  const shownSubtasks = subtasksExpanded ? subtasks : subtasks.slice(0, VISIBLE_SUBTASKS);

  const setSelectedTaskId = useAppStore((s) => s.setSelectedTaskId);
  const toggleTaskSelected = useAppStore((s) => s.toggleTaskSelected);
  const clearTaskSelection = useAppStore((s) => s.clearTaskSelection);

  // Touch long-press picks the card up for drag AND opens the mobile action bar
  // (desktop right-click still opens the context menu).
  const longPress = useLongPress(() => {
    useAppStore.getState().setMobileActionTaskId(task.id);
  }, {});

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      data-kanban-card={true}
      role="button"
      tabIndex={0}
      aria-label={task.title}
      style={style}
      className={`bg-elevated border rounded-xl p-3 cursor-grab hover:bg-hover transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
        selected ? "border-accent bg-accent/5 ring-2 ring-accent/40" : "border-border"
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
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          clearTaskSelection();
          setSelectedTaskId(task.id);
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu?.(e, task);
      }}
    >
      <div
        className="flex items-start gap-2"
        {...attributes}
        {...listeners}
        onPointerDown={(e) => {
          listeners?.onPointerDown?.(e);
          longPress.onPointerDown(e);
        }}
        onPointerMove={longPress.onPointerMove}
        onPointerUp={longPress.onPointerUp}
        onPointerCancel={longPress.onPointerCancel}
      >
        <span
          className="mt-0.5 block h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: PRIORITY_COLORS[normalizePriority(task.priority)] || "var(--text-muted)" }}
        />
        <span className="text-sm text-scale-sm text-primary leading-snug">{task.title}</span>
      </div>

      {subtasks.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {shownSubtasks.map((sub) => {
            const subDone = sub.status === "done";
            return (
              <div key={sub.id} className="flex items-center gap-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void updateTask(sub.id, { status: subDone ? "todo" : "done" });
                  }}
                  role="checkbox"
                  aria-checked={subDone}
                  aria-label={subDone ? `Mark ${sub.title} not done` : `Mark ${sub.title} done`}
                  className={`flex h-[14px] w-[14px] shrink-0 cursor-pointer items-center justify-center rounded-full border-2 transition-colors ${
                    subDone ? "bg-accent border-accent" : "border-border hover:border-accent/50"
                  }`}
                >
                  {subDone && (
                    <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--on-gradient)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </button>
                <span className={`min-w-0 flex-1 truncate text-xs ${subDone ? "line-through text-muted" : "text-secondary"}`}>
                  {sub.title}
                </span>
              </div>
            );
          })}
          {subtasks.length > VISIBLE_SUBTASKS && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setSubtasksExpanded((v) => !v);
              }}
              className="text-left text-[10px] text-secondary transition-colors hover:text-primary"
            >
              {subtasksExpanded ? "Show less" : `... ${subtasks.length - VISIBLE_SUBTASKS} more`}
            </button>
          )}
        </div>
      )}

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
