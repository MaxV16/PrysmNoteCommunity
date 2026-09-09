"use client";

import type { ReactNode } from "react";

interface SelectionActionBarProps {
  count: number;
  busy?: boolean;
  onDelete: () => void;
  onClear: () => void;
  /** Extra batch actions (Move to..., Set date) rendered before Delete. */
  extra?: ReactNode;
  actionError?: string | null;
  /** Floating centered pill (desktop timeline/kanban/board/calendar) vs inline row (list). */
  floating?: boolean;
}

/**
 * Shared multi-selection action bar. The inline variant lives inside ListView's
 * flow (Move/Set date extras); the floating variant overlays the other views
 * whenever tasks are selected so a visible Delete is always one click away.
 */
export function SelectionActionBar({
  count,
  busy,
  onDelete,
  onClear,
  extra,
  actionError,
  floating,
}: SelectionActionBarProps) {
  if (floating) {
    return (
      <div
        data-testid="selection-action-bar"
        className="pointer-events-none fixed inset-x-0 bottom-6 z-40 hidden justify-center px-4 md:flex"
      >
        <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-surface px-4 py-2 shadow-lg">
          <span className="text-xs font-semibold text-primary">{count} selected</span>
          {extra}
          <button
            onClick={onDelete}
            disabled={busy}
            className="btn bg-elevated border border-danger/30 px-3 py-1 text-xs text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
          >
            {busy ? "Deleting…" : "Delete"}
          </button>
          <button
            onClick={onClear}
            className="btn bg-elevated border border-border px-3 py-1 text-xs text-secondary hover:text-primary"
          >
            Clear
          </button>
        </div>
        {actionError && <span className="mt-1 text-[11px] text-danger">{actionError}</span>}
      </div>
    );
  }

  return (
    <div
      data-testid="selection-action-bar"
      className="flex flex-wrap items-center gap-2 border-b border-border bg-elevated/60 px-4 py-2 shrink-0"
    >
      <span className="text-[11px] font-semibold text-primary">{count} selected</span>
      {extra}
      <button
        onClick={onDelete}
        disabled={busy}
        className="btn bg-elevated border border-border px-3 py-1 text-[11px] text-danger hover:brightness-125 rounded-full disabled:opacity-50"
      >
        {busy ? "Deleting…" : "Delete"}
      </button>
      <button
        onClick={onClear}
        className="btn bg-elevated border border-border px-3 py-1 text-[11px] text-secondary hover:text-primary rounded-full"
      >
        Clear
      </button>
      {actionError && <span className="text-[11px] text-danger">{actionError}</span>}
    </div>
  );
}