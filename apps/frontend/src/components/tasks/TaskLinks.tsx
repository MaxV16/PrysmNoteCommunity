"use client";

import { useAppStore } from "@/stores/app-store";
import type { TaskLink } from "@/types/task";

interface TaskLinksProps {
  links: TaskLink[];
  taskId: string;
}

export function TaskLinks({ links, taskId }: TaskLinksProps) {
  const { tasks } = useAppStore();

  const getTaskTitle = (id: string) => {
    if (id === taskId) return "(this task)";
    return tasks.find((t) => t.id === id)?.title || id.slice(0, 8);
  };

  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-xs font-semibold text-muted mb-1">Linked Tasks ({links.length})</h4>
      {links.length === 0 && (
        <p className="text-xs text-muted">No linked tasks</p>
      )}
      {links.map((link) => {
        const isSource = link.source_task_id === taskId;
        const otherId = isSource ? link.target_task_id : link.source_task_id;
        return (
          <div key={link.id} className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-secondary hover:bg-hover transition-colors">
            <span className="badge bg-elevated text-muted text-[10px]">{link.link_type}</span>
            <span>{isSource ? "←" : "→"} {getTaskTitle(otherId)}</span>
          </div>
        );
      })}
    </div>
  );
}