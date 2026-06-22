"use client";

import type { Project } from "@/types/project";

interface ProjectItemProps {
  project: Project;
  count?: number;
  isSelected?: boolean;
  onClick?: (id: string) => void;
}

export function ProjectItem({ project, count, isSelected, onClick }: ProjectItemProps) {
  return (
    <button
      onClick={() => onClick?.(project.id)}
      className={`sidebar-item group ${isSelected ? "active" : ""}`}
    >
      {project.icon && <span className="text-sm">{project.icon}</span>}
      <span
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: project.color || "var(--text-muted)" }}
      />
      <span className="flex-1 min-w-0 truncate text-left">{project.name}</span>
      {count !== undefined && count > 0 && (
        <span className="badge bg-elevated text-muted opacity-0 group-hover:opacity-100 transition-opacity">{count}</span>
      )}
    </button>
  );
}