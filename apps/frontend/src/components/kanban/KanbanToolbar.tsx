"use client";

import { useState } from "react";
import type { BoardSort } from "@/lib/board-dnd";
import { zoomPercent } from "@/lib/view-zoom";

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
  /** When provided with the handlers, renders the per-view zoom control. */
  zoom?: number;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
}

export function KanbanToolbar({
  onAddSection,
  onAddTask,
  filter,
  onFilterChange,
  sort,
  onSortChange,
  zoom = 1,
  onZoomIn,
  onZoomOut,
  onZoomReset,
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
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2 sm:gap-3 sm:px-4">
      {onFilterChange && (
        <div className="flex items-center gap-0.5 rounded-full bg-elevated p-0.5">
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              onClick={() => onFilterChange(value)}
              data-testid={`board-filter-${value}`}
              className={`pointer-coarse:min-h-8 rounded-full px-2.5 py-1 text-[11px] transition-colors sm:py-0.5 ${
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
          className="input-field h-9 w-28 text-xs sm:h-8"
        >
          {SORTS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      )}

      {onZoomIn && onZoomOut && onZoomReset && (
        <div
          className="flex shrink-0 items-center gap-0.5 rounded-full bg-elevated p-0.5"
          data-testid="board-zoom"
        >
          <button
            onClick={onZoomOut}
            aria-label="Zoom out board"
            className="pointer-coarse:min-h-9 relative flex h-6 w-6 items-center justify-center rounded-full text-secondary hover:bg-hover hover:text-primary"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            onClick={onZoomReset}
            aria-label={`Reset board zoom (${zoomPercent(zoom)})`}
            title="Reset zoom"
            className="pointer-coarse:min-h-9 min-w-[3.25rem] rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-secondary transition-colors hover:bg-hover hover:text-primary"
          >
            {zoomPercent(zoom)}
          </button>
          <button
            onClick={onZoomIn}
            aria-label="Zoom in board"
            className="pointer-coarse:min-h-9 relative flex h-6 w-6 items-center justify-center rounded-full text-secondary hover:bg-hover hover:text-primary"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
              <line x1="5" y1="12" x2="19" y2="12" />
              <line x1="12" y1="5" x2="12" y2="19" />
            </svg>
          </button>
        </div>
      )}

      <div className="hidden flex-1 sm:block" />

      <div className="ml-auto flex flex-1 items-center justify-end gap-2 sm:flex-none">
        {onAddTask && (
          <button
            onClick={onAddTask}
            className="btn btn-primary pointer-coarse:min-h-9 px-3 py-1.5 text-xs"
          >
            + New
          </button>
        )}

        {adding ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:flex-none">
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") setAdding(false);
              }}
              placeholder="Section name"
              className="input-field h-9 min-w-0 flex-1 text-xs sm:h-8 sm:w-40 sm:flex-none"
            />
            <button onClick={submit} className="btn btn-primary pointer-coarse:min-h-9 px-3 py-1.5 text-xs">Add</button>
            <button
              onClick={() => setAdding(false)}
              aria-label="Cancel adding section"
              className="btn pointer-coarse:min-h-9 bg-elevated border border-border px-3 py-1.5 text-xs text-secondary"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setAdding(true)}
            className="btn pointer-coarse:min-h-9 bg-elevated border border-border px-3 py-1.5 text-xs text-secondary transition-colors hover:text-primary"
          >
            + Add section
          </button>
        )}
      </div>
    </div>
  );
}
