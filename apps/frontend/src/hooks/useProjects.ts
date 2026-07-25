"use client";

import { useCallback } from "react";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import type { Project } from "@/types/project";

export function useProjects() {
  const { projects, setProjects } = useAppStore();

  const fetchProjects = useCallback(async () => {
    const data = await api.get<Project[]>("/projects/");
    setProjects(data);
  }, [setProjects]);

  const createProject = useCallback(
    async (project: Partial<Project>) => {
      const data = await api.post<Project>("/projects/", project);
      await fetchProjects();
      return data;
    },
    [fetchProjects]
  );

  const deleteProject = useCallback(
    async (id: string) => {
      useAppStore.getState().removeProject(id);
      try {
        await api.delete(`/projects/${id}`);
      } catch {
        // project delete failed silently — already removed from local state
      }
    },
    []
  );

  return { projects, fetchProjects, createProject, deleteProject };
}
