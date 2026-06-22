"use client";

import { useState } from "react";
import type { Task } from "@/types/task";
import { TaskForm } from "./TaskForm";
import { TaskChecklist } from "./TaskChecklist";
import { TaskLinks } from "./TaskLinks";
import { useTasks } from "@/hooks/useTasks";
import { useAppStore } from "@/stores/app-store";

function isBroadTask(title: string): boolean {
  const broadKeywords = [
    "start", "build", "create", "launch", "plan", "business", "project",
    "company", "website", "app", "trip", "travel", "vacation", "event",
    "campaign", "research", "study", "course", "move", "renovate",
  ];
  const lower = title.toLowerCase();
  return broadKeywords.some((kw) => lower.includes(kw));
}

interface TaskDetailProps {
  task: Task;
  onClose: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  backlog: "var(--text-muted)",
  todo: "var(--accent)",
  in_progress: "var(--warning)",
  done: "var(--success)",
  cancelled: "var(--danger)",
};

export function TaskDetail({ task, onClose }: TaskDetailProps) {
  const [editing, setEditing] = useState(false);
  const { updateTask, deleteTask } = useTasks();

  const handleUpdate = async (data: {
    title: string;
    description?: string;
    start_date?: string;
    due_date?: string;
    status?: string;
    priority?: number;
    project_id?: string | null;
  }) => {
    const fields: Record<string, unknown> = {};
    if (data.title !== task.title) fields.title = data.title;
    if (data.description !== (task.description || "")) fields.description = data.description;
    if (data.status && data.status !== task.status) fields.status = data.status;
    if (data.priority && data.priority !== task.priority) fields.priority = data.priority;
    if (data.start_date !== (task.start_date || "")) fields.start_date = data.start_date;
    if (data.due_date !== (task.due_date || "")) fields.due_date = data.due_date;
    if (data.project_id !== (task.project_id || "")) fields.project_id = data.project_id;
    if (Object.keys(fields).length > 0) {
      await updateTask(task.id, fields);
    }
    setEditing(false);
  };

  const handleDelete = async () => {
    await deleteTask(task.id);
    onClose();
  };

  const handleStatusToggle = async () => {
    const newStatus = task.status === "done" ? "todo" : "done";
    await updateTask(task.id, { status: newStatus });
  };

  if (editing) {
    return (
      <div className="fade-in">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-primary">Edit Task</h3>
          <button onClick={() => setEditing(false)} className="text-sm text-secondary hover:text-primary">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <TaskForm onSubmit={handleUpdate} onCancel={() => setEditing(false)} initial={task} />
      </div>
    );
  }

  const projects = useAppStore.getState().projects;
  const projectName = task.project_id ? projects.find((p) => p.id === task.project_id)?.name || "Unknown" : null;

  return (
    <div className="fade-in">
      {/* Header */}
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 flex-1 min-w-0">
          <input
            type="checkbox"
            checked={task.status === "done"}
            onChange={handleStatusToggle}
            className="mt-1 h-4 w-4 shrink-0 rounded border-border accent-accent"
          />
          <div>
            <h3 className={`text-sm font-semibold leading-snug ${task.status === "done" ? "line-through text-muted" : "text-primary"}`}>
              {task.title}
            </h3>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={() => setEditing(true)} className="btn bg-elevated px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary">Edit</button>
          <button onClick={handleDelete} className="btn bg-elevated px-2 py-1 text-xs text-danger hover:bg-hover">Del</button>
          <button onClick={onClose} className="btn bg-elevated px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      </div>

      {/* Description */}
      {task.description && (
        <p className="mb-3 text-sm text-secondary leading-relaxed">{task.description}</p>
      )}

      {/* Status badges row */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        <span
          className="badge"
          style={{
            backgroundColor: (STATUS_COLORS[task.status] || "var(--text-muted)") + "20",
            color: STATUS_COLORS[task.status] || "var(--text-secondary)",
          }}
        >
          {task.status.replace("_", " ")}
        </span>
        <span className="badge bg-elevated text-muted">P{task.priority}</span>
        {task.start_date && (
          <span className="badge bg-elevated text-muted">📅 {task.start_date}</span>
        )}
        {task.due_date && (
          <span className="badge bg-elevated text-muted">📅 {task.due_date}</span>
        )}
        {projectName && (
          <span className="badge bg-elevated text-secondary">{projectName}</span>
        )}
      </div>

      {/* Tags */}
      {task.tags && task.tags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {task.tags.map((tag: { id: string; name: string; color: string | null }) => (
            <span
              key={tag.id}
              className="badge"
              style={{
                backgroundColor: (tag.color || "#333") + "30",
                color: tag.color || "var(--text-secondary)",
              }}
            >
              {tag.name}
            </span>
          ))}
        </div>
      )}

      {/* Break down button for broad tasks */}
      {isBroadTask(task.title) && (
        <div className="mb-3">
          <button
            onClick={() => {
              const event = new CustomEvent("prysm-ai-suggest", {
                detail: { taskId: task.id, title: task.title },
              });
              window.dispatchEvent(event);
            }}
            className="btn w-full bg-accent/10 border border-accent/20 px-3 py-2 text-xs text-accent hover:bg-accent/20 hover:border-accent/40 transition-all gap-2"
          >
            <span>🧠</span>
            <span>Break this down into subtasks</span>
          </button>
        </div>
      )}

      {/* Subtasks */}
      <div className="border-t border-border pt-3 mt-3">
        <TaskChecklist subtasks={task.subtasks || []} taskId={task.id} />
      </div>

      {/* Links */}
      <div className="border-t border-border pt-3 mt-3">
        <TaskLinks links={task.links || []} taskId={task.id} />
      </div>
    </div>
  );
}
