"use client";

import { useState, useRef, useEffect } from "react";

interface KanbanAddCardProps {
  status: string;
  boardSectionId?: string | null;
  listId?: string | null;
  onAdd: () => void;
  autoExpand?: boolean;
}

export function KanbanAddCard({ status, boardSectionId, listId, onAdd, autoExpand = false }: KanbanAddCardProps) {
  const [expanded, setExpanded] = useState(autoExpand);
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (expanded && inputRef.current) {
      inputRef.current.focus();
    }
  }, [expanded]);

  const handleSubmit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;

    const { api } = await import("@/lib/api");
    await api.post("/tasks/", {
      title: trimmed,
      status,
      board_section_id: boardSectionId ?? undefined,
      list_id: listId ?? undefined,
    });
    onAdd();
    setTitle("");
    setExpanded(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSubmit();
    } else if (e.key === "Escape") {
      setTitle("");
      setExpanded(false);
    }
  };

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="w-full rounded-xl border border-dashed border-border px-3 py-2.5 text-center text-xs text-muted hover:bg-hover transition-colors"
      >
        + Add task
      </button>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-elevated p-2.5">
      <input
        ref={inputRef}
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Task title"
        className="input-field mb-2 w-full rounded-lg px-2.5 py-1.5 text-sm"
      />
      <div className="flex gap-2">
        <button
          onClick={handleSubmit}
          disabled={!title.trim()}
          className="btn btn-primary flex-1 rounded-lg px-2.5 py-1.5 text-xs"
        >
          Add
        </button>
        <button
          onClick={() => {
            setTitle("");
            setExpanded(false);
          }}
          className="btn bg-elevated rounded-lg px-2.5 py-1.5 text-xs text-secondary hover:text-primary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
