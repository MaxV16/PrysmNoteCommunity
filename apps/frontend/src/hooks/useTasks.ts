"use client";

import { useCallback } from "react";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import type { Task } from "@/types/task";

export function useTasks() {
  const { tasks, setTasks } = useAppStore();

  const fetchTasks = useCallback(async () => {
    const data = await api.get<Task[]>("/tasks/");
    setTasks(data);
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
      const data = await api.patch<Task>(`/tasks/${id}`, { fields });
      await fetchTasks();
      return data;
    },
    [fetchTasks]
  );

  const deleteTask = useCallback(
    async (id: string) => {
      await api.delete(`/tasks/${id}`);
      await fetchTasks();
    },
    [fetchTasks]
  );

  return { tasks, fetchTasks, createTask, updateTask, deleteTask };
}
