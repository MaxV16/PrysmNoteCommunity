"use client";

import type { Project } from "@/types/project";

interface ProjectItemProps {
  project: Project;
  count?: number;
  isSelected?: boolean;
  onClick?: (id: string) => void;
  onDelete?: (id: string) => void;
}

export function ProjectItem({ project, count, isSelected, onClick, onDelete }: ProjectItemProps) {
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
      {onDelete && (
        <span
          onClick={(e) => { e.stopPropagation(); onDelete(project.id); }}
          className="opacity-0 group-hover:opacity-100 text-muted hover:text-danger transition-all p-0.5 flex-shrink-0"
          title="Delete list"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </span>
      )}
    </button>
  );
}