"use client";

import { useState } from "react";
import type { BoardSort } from "@/lib/board-dnd";

export type BoardFilter = "all" | "active" | "completed";

const SORTS: ReadonlyArray<readonly [BoardSort, string]> = [
  ["manual", "Manual"],
  ["tag", "By tag"],
];

const FILTERS: ReadonlyArray<readonly [BoardFilter, string]> = [
  ["all", "All"],
  ["active", "Active"],
  ["completed", "Done"],
];

interface KanbanToolbarProps {
  onAddSection: (title: string) => void;
  /** When provided, renders a "+ New" button that opens the board creation modal. */
  onAddTask?: () => void;
  /** When provided, renders the completion filter. */
  filter?: BoardFilter;
  onFilterChange?: (f: BoardFilter) => void;
  /** When provided, renders the sort control. */
  sort?: BoardSort;
  onSortChange?: (s: BoardSort) => void;
}

export function KanbanToolbar({
  onAddSection,
  onAddTask,
  filter,
  onFilterChange,
  sort,
  onSortChange,
}: KanbanToolbarProps) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    onAddSection(trimmed);
    setTitle("");
    setAdding(false);
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-2">
      {onFilterChange && (
        <div className="flex items-center gap-0.5 rounded-full bg-elevated p-0.5">
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              onClick={() => onFilterChange(value)}
              data-testid={`board-filter-${value}`}
              className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
                filter === value
                  ? "bg-accent text-[var(--on-gradient)] font-semibold"
                  : "text-secondary hover:text-primary"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {onSortChange && (
        <select
          value={sort ?? "manual"}
          onChange={(e) => onSortChange(e.target.value as BoardSort)}
          aria-label="Sort board"
          className="input-field h-8 w-28 text-xs"
        >
          {SORTS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      )}

      <div className="flex-1" />

      {onAddTask && (
        <button
          onClick={onAddTask}
          className="btn btn-primary px-3 py-1.5 text-xs"
        >
          + New
        </button>
      )}

      {adding ? (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") setAdding(false);
            }}
            placeholder="Section name"
            className="input-field h-8 w-40 text-xs"
          />
          <button onClick={submit} className="btn btn-primary px-3 py-1.5 text-xs">Add</button>
          <button
            onClick={() => setAdding(false)}
            className="btn bg-elevated border border-border px-3 py-1.5 text-xs text-secondary"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="btn bg-elevated border border-border px-3 py-1.5 text-xs text-secondary transition-colors hover:text-primary"
        >
          + Add section
        </button>
      )}
    </div>
  );
}
