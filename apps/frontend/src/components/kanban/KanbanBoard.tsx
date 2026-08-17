"use client";

import { useState, useCallback, useEffect } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
} from "@dnd-kit/core";
import { useAppStore } from "@/stores/app-store";
import { api } from "@/lib/api";
import type { Task } from "@/types/task";
import { KanbanColumn } from "./KanbanColumn";
import { KanbanCard } from "./KanbanCard";

interface ColumnConfig {
  id: string;
  title: string;
  color: string;
  status: string;
}

const STORAGE_KEY = "prysm_kanban_columns";

const DEFAULT_COLUMNS: ColumnConfig[] = [
  { id: "backlog", title: "Backlog", color: "#9E9E9E", status: "backlog" },
  { id: "todo", title: "To Do", color: "#4FC3F7", status: "todo" },
  { id: "in_progress", title: "In Progress", color: "#FFA726", status: "in_progress" },
  { id: "done", title: "Done", color: "#66BB6A", status: "done" },
];

const STATUS_COLORS: Record<string, string> = {
  backlog: "#9E9E9E",
  todo: "#4FC3F7",
  in_progress: "#FFA726",
  done: "#66BB6A",
  cancelled: "#EF5350",
};

function loadColumns(): ColumnConfig[] {
  if (typeof window === "undefined") return DEFAULT_COLUMNS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_COLUMNS;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    return DEFAULT_COLUMNS;
  } catch {
    return DEFAULT_COLUMNS;
  }
}

function saveColumns(cols: ColumnConfig[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cols));
  } catch {
    /* storage unavailable */
  }
}

function makeId(): string {
  return `col_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function KanbanBoard() {
  const tasks = useAppStore((s) => s.tasks);
  const setTasks = useAppStore((s) => s.setTasks);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [columns, setColumns] = useState<ColumnConfig[]>(DEFAULT_COLUMNS);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newStatus, setNewStatus] = useState("todo");

  useEffect(() => {
    setColumns(loadColumns());
  }, []);

  const updateColumns = useCallback((cols: ColumnConfig[]) => {
    setColumns(cols);
    saveColumns(cols);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const task = tasks.find((t) => t.id === event.active.id);
      if (task) setActiveTask(task);
    },
    [tasks]
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveTask(null);

      const { active, over } = event;
      if (!over) return;

      const taskId = active.id as string;
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;

      const overTaskId = over.id as string;
      const overTask = tasks.find((t) => t.id === overTaskId);
      const overColumn = columns.find((c) => c.id === over.id);
      const newStatus = overTask?.status || overColumn?.status;
      if (!newStatus || newStatus === task.status) return;

      const updatedTasks = tasks.map((t) =>
        t.id === taskId ? { ...t, status: newStatus } : t
      );
      setTasks(updatedTasks);

      try {
        await api.patch(`/tasks/${taskId}`, { status: newStatus });
      } catch {
        const revertedTasks = tasks.map((t) =>
          t.id === taskId ? { ...t, status: task.status } : t
        );
        setTasks(revertedTasks);
      }
    },
    [tasks, setTasks, columns]
  );

  const getColumnTasks = useCallback(
    (status: string) =>
      tasks.filter((t) => t.status === status && !t.is_archived),
    [tasks]
  );

  const renameColumn = useCallback(
    (id: string, title: string) => {
      updateColumns(columns.map((c) => (c.id === id ? { ...c, title } : c)));
    },
    [columns, updateColumns]
  );

  const removeColumn = useCallback(
    (id: string) => {
      if (columns.length <= 1) return; // keep at least one column
      updateColumns(columns.filter((c) => c.id !== id));
    },
    [columns, updateColumns]
  );

  const addColumn = useCallback(() => {
    const title = newTitle.trim();
    if (!title) return;
    updateColumns([
      ...columns,
      {
        id: makeId(),
        title,
        color: STATUS_COLORS[newStatus] || "#9E9E9E",
        status: newStatus,
      },
    ]);
    setNewTitle("");
    setNewStatus("todo");
    setAdding(false);
  }, [columns, newTitle, newStatus, updateColumns]);

  return (
    <div className="flex h-full gap-4 overflow-x-auto px-4 py-4">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        {columns.map((col) => (
          <KanbanColumn
            key={col.id}
            column={col}
            tasks={getColumnTasks(col.status)}
            onRename={(title) => renameColumn(col.id, title)}
            onRemove={() => removeColumn(col.id)}
          />
        ))}

        <DragOverlay>
          {activeTask ? (
            <div className="opacity-90">
              <KanbanCard task={activeTask} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {adding ? (
        <div className="flex h-fit w-[280px] flex-shrink-0 flex-col gap-2 rounded-2xl bg-surface border border-border p-3">
          <input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addColumn();
              if (e.key === "Escape") setAdding(false);
            }}
            placeholder="Column name"
            className="input-field text-xs"
          />
          <select
            value={newStatus}
            onChange={(e) => setNewStatus(e.target.value)}
            className="input-field text-xs"
          >
            <option value="backlog">Backlog</option>
            <option value="todo">To Do</option>
            <option value="in_progress">In Progress</option>
            <option value="done">Done</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <div className="flex gap-2">
            <button onClick={addColumn} className="btn btn-primary flex-1 text-xs">Add</button>
            <button onClick={() => setAdding(false)} className="btn bg-elevated border border-border flex-1 text-xs text-secondary">Cancel</button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex h-fit w-[160px] flex-shrink-0 items-center justify-center rounded-2xl border border-dashed border-border/60 px-3 py-3 text-xs text-muted hover:border-accent/40 hover:text-secondary"
        >
          + Add column
        </button>
      )}
    </div>
  );
}
