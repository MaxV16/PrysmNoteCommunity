"use client";

import { useState, useCallback } from "react";
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

const COLUMNS = [
  { status: "backlog", title: "Backlog", color: "#9E9E9E" },
  { status: "todo", title: "To Do", color: "#4FC3F7" },
  { status: "in_progress", title: "In Progress", color: "#FFA726" },
  { status: "done", title: "Done", color: "#66BB6A" },
] as const;

export function KanbanBoard() {
  const tasks = useAppStore((s) => s.tasks);
  const setTasks = useAppStore((s) => s.setTasks);
  const [activeTask, setActiveTask] = useState<Task | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
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
      const overColumn = COLUMNS.find((c) => c.status === over.id);
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
    [tasks, setTasks]
  );

  const getColumnTasks = useCallback(
    (status: string) =>
      tasks.filter((t) => t.status === status && !t.is_archived),
    [tasks]
  );

  const handleAdd = useCallback(() => {
    // Re-fetch triggered externally via useTasks or the caller
  }, []);

  return (
    <div className="flex h-full gap-4 overflow-x-auto px-4 py-4">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        {COLUMNS.map((col) => (
          <KanbanColumn
            key={col.status}
            status={col.status}
            title={col.title}
            color={col.color}
            tasks={getColumnTasks(col.status)}
            onAdd={handleAdd}
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
    </div>
  );
}
