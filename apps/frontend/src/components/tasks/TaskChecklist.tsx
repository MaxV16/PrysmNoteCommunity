"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { Task } from "@/types/task";
import { useTasks } from "@/hooks/useTasks";

interface TaskChecklistProps {
  subtasks: Task[];
  taskId: string;
}

export function TaskChecklist({ subtasks, taskId }: TaskChecklistProps) {
  const [items, setItems] = useState<Task[]>(subtasks);
  const [newTitle, setNewTitle] = useState("");
  const { updateTask } = useTasks();

  const handleToggle = async (sub: Task) => {
    const newStatus = sub.status === "done" ? "todo" : "done";
    await updateTask(sub.id, { status: newStatus });
    setItems((prev) => prev.map((s) => (s.id === sub.id ? { ...s, status: newStatus } : s)));
  };

  const handleAdd = async () => {
    if (!newTitle.trim()) return;
    const data = await api.post<{ id: string; title: string; status: string }>(`/tasks/${taskId}/subtasks`, {
      title: newTitle.trim(),
    });
    setItems((prev) => [...prev, { ...data, status: data.status as Task["status"] } as Task]);
    setNewTitle("");
  };

  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-xs font-semibold text-muted mb-1">Subtasks ({items.length})</h4>
      {items.length === 0 && (
        <p className="text-xs text-muted mb-1">No subtasks</p>
      )}
      {items.map((sub) => (
        <label
          key={sub.id}
          className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-secondary hover:bg-hover cursor-pointer transition-colors"
        >
          <input
            type="checkbox"
            checked={sub.status === "done"}
            onChange={() => handleToggle(sub)}
            className="accent-accent h-3.5 w-3.5"
          />
          <span className={sub.status === "done" ? "line-through text-muted" : ""}>{sub.title}</span>
        </label>
      ))}
      <div className="flex gap-2 mt-1">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Add subtask..."
          className="input-field flex-1 text-xs"
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <button onClick={handleAdd} className="btn bg-accent px-2.5 py-1 text-xs text-base hover:bg-accent-hover">
          +
        </button>
      </div>
    </div>
  );
}