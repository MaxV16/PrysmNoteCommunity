"use client";

import { useState } from "react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import type { Task } from "@/types/task";
import { KanbanCard } from "./KanbanCard";
import { KanbanAddCard } from "./KanbanAddCard";

interface ColumnConfig {
  id: string;
  title: string;
  color: string;
  status: string;
}

interface KanbanColumnProps {
  column: ColumnConfig;
  tasks: Task[];
  onRename: (title: string) => void;
  onRemove: () => void;
}

export function KanbanColumn({ column, tasks, onRename, onRemove }: KanbanColumnProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(column.title);

  const { setNodeRef } = useDroppable({ id: column.id });

  const commitRename = () => {
    const trimmed = draft.trim();
    if (trimmed) onRename(trimmed);
    setEditing(false);
  };

  return (
    <div
      ref={setNodeRef}
      className="flex h-full flex-shrink-0 w-[280px] flex-col rounded-2xl bg-surface border border-border"
    >
      <div className="mb-1 flex items-center gap-2 px-4 pt-3 pb-2">
        <span
          className="block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: column.color }}
        />
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") {
                setDraft(column.title);
                setEditing(false);
              }
            }}
            className="input-field flex-1 min-w-0 px-1 py-0.5 text-sm font-semibold text-primary"
          />
        ) : (
          <h3
            onClick={() => {
              setDraft(column.title);
              setEditing(true);
            }}
            title="Click to rename column"
            className="flex-1 min-w-0 cursor-text truncate text-sm font-semibold text-primary"
          >
            {column.title}
          </h3>
        )}
        <span className="ml-auto rounded-full bg-elevated px-1.5 py-0.5 text-xs text-muted">
          {tasks.length}
        </span>
        <button
          onClick={onRemove}
          className="text-xs text-muted transition-colors hover:text-red-400"
          title="Remove column"
        >
          ✕
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3 space-y-2">
        <SortableContext
          items={tasks.map((t) => t.id)}
          strategy={verticalListSortingStrategy}
        >
          {tasks.map((task) => (
            <KanbanCard key={task.id} task={task} />
          ))}
        </SortableContext>
      </div>

      <div className="px-3 pb-3">
        <KanbanAddCard status={column.status} onAdd={() => {}} />
      </div>
    </div>
  );
}
