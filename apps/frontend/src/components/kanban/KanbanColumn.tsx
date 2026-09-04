"use client";

import { useState } from "react";
import {
  SortableContext,
  rectSortingStrategy,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useDroppable } from "@dnd-kit/core";
import type { Task } from "@/types/task";
import { useAppStore } from "@/stores/app-store";
import type { BoardSection } from "@/lib/board-sections";
import type { CardLayout } from "@/lib/preferences";
import { KanbanCard } from "./KanbanCard";
import { KanbanAddCard } from "./KanbanAddCard";

interface KanbanColumnProps {
  section: BoardSection;
  tasks: Task[];
  cardLayout: CardLayout;
  onRefetch: () => void;
  onRename: (title: string) => void;
  onRemove: () => void;
  onEmptyContextMenu?: (e: React.MouseEvent, section: BoardSection) => void;
  onCardContextMenu?: (e: React.MouseEvent, task: Task) => void;
}

export function KanbanColumn({
  section,
  tasks,
  cardLayout,
  onRefetch,
  onRename,
  onRemove,
  onEmptyContextMenu,
  onCardContextMenu,
}: KanbanColumnProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.title);
  const selectedTaskIds = useAppStore((s) => s.selectedTaskIds);

  const { setNodeRef, isOver } = useDroppable({ id: section.id });

  const commitRename = () => {
    const trimmed = draft.trim();
    if (trimmed) onRename(trimmed);
    setEditing(false);
  };

  const strategy = cardLayout === "side_by_side" ? rectSortingStrategy : verticalListSortingStrategy;

  return (
    <div
      ref={setNodeRef}
      data-testid="kanban-column"
      className={`flex h-full flex-shrink-0 flex-col rounded-2xl bg-surface border transition-colors ${
        cardLayout === "side_by_side" ? "min-w-[640px]" : "w-[280px]"
      } ${isOver ? "border-accent ring-2 ring-accent/30" : "border-border"}`}
    >
      <div className="mb-1 flex items-center gap-2 px-4 pt-3 pb-2">
        <span
          className="block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: section.color || "#9E9E9E" }}
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
                setDraft(section.title);
                setEditing(false);
              }
            }}
            className="input-field flex-1 min-w-0 px-1 py-0.5 text-sm font-semibold text-primary"
          />
        ) : (
          <h3
            onClick={() => {
              setDraft(section.title);
              setEditing(true);
            }}
            title="Click to rename section"
            className="flex-1 min-w-0 cursor-text truncate text-sm font-semibold text-primary"
          >
            {section.title}
          </h3>
        )}
        <span className="ml-auto rounded-full bg-elevated px-1.5 py-0.5 text-xs text-muted">
          {tasks.length}
        </span>
        <button
          onClick={onRemove}
          className="text-xs text-muted transition-colors hover:text-red-400"
          title="Remove section"
        >
          ✕
        </button>
      </div>

      <div
        className={`flex-1 overflow-y-auto px-3 pb-3 ${
          cardLayout === "side_by_side" ? "" : "space-y-2"
        }`}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onEmptyContextMenu?.(e, section);
        }}
      >
        <SortableContext items={tasks.map((t) => t.id)} strategy={strategy}>
          {cardLayout === "side_by_side" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
              {tasks.map((task) => (
                <KanbanCard key={task.id} task={task} sectionId={section.id} onContextMenu={onCardContextMenu} selected={selectedTaskIds.includes(task.id)} />
              ))}
            </div>
          ) : (
            tasks.map((task) => (
              <KanbanCard key={task.id} task={task} sectionId={section.id} onContextMenu={onCardContextMenu} selected={selectedTaskIds.includes(task.id)} />
            ))
          )}
        </SortableContext>
      </div>

      <div className="px-3 pb-3">
        <KanbanAddCard
          status={section.status || "backlog"}
          boardSectionId={section.status ? null : section.id}
          onAdd={onRefetch}
        />
      </div>
    </div>
  );
}
