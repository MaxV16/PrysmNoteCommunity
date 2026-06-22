"use client";

import { useState } from "react";
import { useAppStore } from "@/stores/app-store";
import type { Task, TaskStatus } from "@/types/task";

interface TaskFormProps {
  onSubmit: (data: {
    title: string;
    description?: string;
    start_date?: string;
    due_date?: string;
    status?: string;
    priority?: number;
    project_id?: string | null;
    tag_ids?: string[];
  }) => void;
  onCancel: () => void;
  initial?: Task | null;
}

const STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "To Do" },
  { value: "in_progress", label: "In Progress" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

export function TaskForm({ onSubmit, onCancel, initial }: TaskFormProps) {
  const { projects, tags } = useAppStore();
  const [title, setTitle] = useState(initial?.title || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [startDate, setStartDate] = useState(initial?.start_date || "");
  const [dueDate, setDueDate] = useState(initial?.due_date || "");
  const [status, setStatus] = useState<TaskStatus>(initial?.status || "todo");
  const [priority, setPriority] = useState(initial?.priority || 3);
  const [projectId, setProjectId] = useState(initial?.project_id || "");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);

  const isEdit = !!initial;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,
      start_date: startDate || undefined,
      due_date: dueDate || undefined,
      status: isEdit ? status : undefined,
      priority: isEdit ? priority : undefined,
      project_id: projectId || null,
      tag_ids: selectedTags.length > 0 ? selectedTags : undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title"
        className="input-field"
        autoFocus
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={3}
        className="input-field resize-none"
      />
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="mb-1 block text-xs text-muted">Start Date</label>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="input-field"
          />
        </div>
        <div className="flex-1">
          <label className="mb-1 block text-xs text-muted">Due Date</label>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="input-field"
          />
        </div>
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="mb-1 block text-xs text-muted">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as TaskStatus)}
            className="input-field"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className="mb-1 block text-xs text-muted">Priority</label>
          <select
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
            className="input-field"
          >
            {[1, 2, 3, 4, 5].map((p) => (
              <option key={p} value={p}>P{p}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted">Project</label>
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="input-field"
        >
          <option value="">No Project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      {tags.length > 0 && (
        <div>
          <label className="mb-1 block text-xs text-muted">Tags</label>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => {
              const isSelected = selectedTags.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() =>
                    setSelectedTags((prev) =>
                      prev.includes(tag.id) ? prev.filter((id) => id !== tag.id) : [...prev, tag.id]
                    )
                  }
                  className={`badge transition-all ${
                    isSelected
                      ? "bg-accent text-base"
                      : "bg-elevated text-secondary hover:text-primary"
                  }`}
                >
                  {tag.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <button type="submit" className="btn flex-1 bg-accent py-2 text-sm font-semibold text-base hover:bg-accent-hover">
          {isEdit ? "Update Task" : "Create Task"}
        </button>
        <button type="button" onClick={onCancel} className="btn bg-elevated px-4 py-2 text-sm text-secondary hover:bg-hover hover:text-primary">
          Cancel
        </button>
      </div>
    </form>
  );
}