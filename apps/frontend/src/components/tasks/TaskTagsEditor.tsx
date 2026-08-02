"use client";

import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import { useTags } from "@/hooks/useTags";
import { useTasks } from "@/hooks/useTasks";
import type { TaskTag } from "@/types/task";

interface TaskTagsEditorProps {
  taskId: string;
  tags: TaskTag[];
  onChange: (tags: TaskTag[]) => void;
}

export function TaskTagsEditor({ taskId, tags, onChange }: TaskTagsEditorProps) {
  const available = useAppStore((s) => s.tags);
  const { createTag } = useTags();
  const { fetchTasks } = useTasks();
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);

  const assignedIds = new Set(tags.map((t) => t.id));
  const matching = available.filter(
    (t) => !assignedIds.has(t.id) && t.name.toLowerCase().includes(query.trim().toLowerCase())
  );

  const refreshTask = async () => {
    await fetchTasks();
    const data = await api.get<TaskTag[]>(`/tags/tasks/${taskId}`);
    onChange(data);
  };

  const assign = async (tagId: string) => {
    setBusyId(tagId);
    try {
      await api.post(`/tags/tasks/${taskId}?tag_id=${tagId}`, {});
      await refreshTask();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (tagId: string) => {
    setBusyId(tagId);
    try {
      await api.delete(`/tags/tasks/${taskId}?tag_id=${tagId}`);
      await refreshTask();
    } finally {
      setBusyId(null);
    }
  };

  const handleCreateNew = async () => {
    const name = query.trim();
    if (!name) return;
    const colors = ["#4fc3f7", "#66bb6a", "#ffa726", "#ef5350", "#ab47bc", "#42a5f5", "#78909c"];
    const color = colors[available.length % colors.length];
    const created = await createTag({ name, color });
    await assign(created.id);
    setQuery("");
    setAdding(false);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <span
            key={tag.id}
            className="badge group gap-1.5"
            style={{
              backgroundColor: (tag.color || "#333") + "30",
              color: tag.color || "var(--text-secondary)",
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full shrink-0"
              style={{ backgroundColor: tag.color || "var(--text-muted)" }}
            />
            {tag.name}
            <button
              onClick={() => remove(tag.id)}
              disabled={busyId === tag.id}
              className="opacity-60 hover:text-danger disabled:opacity-30 font-bold"
              title="Remove tag"
            >
              ✕
            </button>
          </span>
        ))}
        {adding ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-accent/30 bg-elevated px-1">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateNew();
                if (e.key === "Escape") {
                  setAdding(false);
                  setQuery("");
                }
              }}
              placeholder="Search or create…"
              className="bg-transparent text-xs text-primary outline-none w-28 py-1"
            />
          </span>
        ) : (
          <button
            onClick={() => {
              setQuery("");
              setAdding(true);
            }}
            className="badge border border-dashed border-border text-muted hover:border-accent/50 hover:text-accent transition-colors"
            title="Add tag"
          >
            + Add tag
          </button>
        )}
      </div>
      {adding && matching.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {matching.map((tag) => (
            <button
              key={tag.id}
              onClick={() => assign(tag.id)}
              disabled={busyId === tag.id}
              className="badge text-[10px] bg-elevated text-secondary hover:bg-accent/20 hover:text-primary transition-colors disabled:opacity-40"
            >
              {tag.name}
            </button>
          ))}
        </div>
      )}
      {adding && matching.length === 0 && query.trim() && (
        <div className="mt-1.5">
          <button
            onClick={handleCreateNew}
            className="text-[11px] text-accent hover:text-accent-hover"
          >
            Create “{query.trim()}”
          </button>
        </div>
      )}
    </div>
  );
}
