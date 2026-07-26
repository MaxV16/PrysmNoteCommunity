"use client";

import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Task } from "@/types/task";
import { KanbanCard } from "./KanbanCard";
import { KanbanAddCard } from "./KanbanAddCard";

interface KanbanColumnProps {
  status: string;
  title: string;
  tasks: Task[];
  color: string;
  onAdd: () => void;
}

export function KanbanColumn({ status, title, tasks, color, onAdd }: KanbanColumnProps) {
  return (
    <div className="flex h-full flex-shrink-0 w-[280px] flex-col rounded-2xl bg-surface border border-border">
      <div className="mb-1 flex items-center gap-2 px-4 pt-3 pb-2">
        <span
          className="block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
        <h3 className="text-sm font-semibold text-primary truncate">{title}</h3>
        <span className="ml-auto rounded-full bg-elevated px-1.5 py-0.5 text-xs text-muted">
          {tasks.length}
        </span>
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
        <KanbanAddCard status={status} onAdd={onAdd} />
      </div>
    </div>
  );
}
