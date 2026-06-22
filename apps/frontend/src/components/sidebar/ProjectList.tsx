"use client";

import { useState } from "react";
import { useAppStore } from "@/stores/app-store";
import { useProjects } from "@/hooks/useProjects";
import { ProjectItem } from "@/components/sidebar/ProjectItem";

export function ProjectList() {
  const projects = useAppStore((s) => s.projects);
  const tasks = useAppStore((s) => s.tasks);
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);
  const setSelectedProjectId = useAppStore((s) => s.setSelectedProjectId);
  const { createProject } = useProjects();
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState("");

  const projectCounts = (projectId: string) =>
    tasks.filter((t) => t.project_id === projectId && !t.is_archived).length;

  const handleCreate = async () => {
    if (!newName.trim()) return;
    await createProject({ name: newName.trim() });
    setNewName("");
    setIsAdding(false);
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between px-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Lists</h3>
        <button
          onClick={() => setIsAdding(!isAdding)}
          className="text-xs text-accent hover:text-accent-hover font-medium"
        >
          + New
        </button>
      </div>
      {isAdding && (
        <div className="mb-2 px-1">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
              if (e.key === "Escape") {
                setIsAdding(false);
                setNewName("");
              }
            }}
            placeholder="List name"
            className="input-field text-xs"
            autoFocus
          />
        </div>
      )}
      <div className="flex flex-col gap-0.5">
        {projects.filter((p) => !p.is_archived).map((project) => (
          <ProjectItem
            key={project.id}
            project={project}
            count={projectCounts(project.id)}
            isSelected={selectedProjectId === project.id}
            onClick={(id) => setSelectedProjectId(selectedProjectId === id ? null : id)}
          />
        ))}
        {projects.length === 0 && !isAdding && (
          <p className="px-1 text-xs text-muted">No lists yet</p>
        )}
      </div>
    </div>
  );
}