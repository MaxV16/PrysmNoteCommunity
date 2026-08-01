"use client";

import { useCallback } from "react";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import type { Task } from "@/types/task";
import { getLocalTasks, updateLocalTask, deleteLocalTask } from "@/lib/local-storage";

export function useTasks() {
  const { tasks, setTasks } = useAppStore();

  const fetchTasks = useCallback(async () => {
    try {
      const data = await api.get<Task[]>("/tasks/");
      setTasks(data);
    } catch {
      const local = getLocalTasks<Task[]>();
      setTasks(local);
    }
  }, [setTasks]);

  const createTask = useCallback(
    async (task: Record<string, unknown>) => {
      const data = await api.post<Task>("/tasks/", task);
      await fetchTasks();
      return data;
    },
    [fetchTasks]
  );

  const updateTask = useCallback(
    async (id: string, fields: Record<string, unknown>) => {
      try {
        const data = await api.patch<Task>(`/tasks/${id}`, fields);
        await fetchTasks();
        return data;
      } catch {
        const updated = updateLocalTask(id, fields);
        await fetchTasks();
        return updated;
      }
    },
    [fetchTasks]
  );

  const deleteTask = useCallback(
    async (id: string) => {
      try {
        await api.delete(`/tasks/${id}`);
      } catch {
        deleteLocalTask(id);
      }
      await fetchTasks();
    },
    [fetchTasks]
  );

  return { tasks, fetchTasks, createTask, updateTask, deleteTask };
}
