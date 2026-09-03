"use client";

import { useState } from "react";
import type { CardLayout, ScrollDirection } from "@/lib/preferences";

interface KanbanToolbarProps {
  scrollDirection: ScrollDirection;
  cardLayout: CardLayout;
  onScrollDirectionChange: (d: ScrollDirection) => void;
  onCardLayoutChange: (l: CardLayout) => void;
  onAddSection: (title: string) => void;
}

export function KanbanToolbar({
  scrollDirection,
  cardLayout,
  onScrollDirectionChange,
  onCardLayoutChange,
  onAddSection,
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
    <div className="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-1.5">
      <div className="flex items-center gap-0.5 rounded-full bg-elevated p-0.5">
        <button
          onClick={() => onScrollDirectionChange("horizontal")}
          data-testid="scroll-horizontal"
          title="Columns: sections side-by-side"
          className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
            scrollDirection === "horizontal" ? "bg-accent text-[var(--on-gradient)] font-semibold" : "text-secondary hover:text-primary"
          }`}
        >
          Horizontal
        </button>
        <button
          onClick={() => onScrollDirectionChange("vertical")}
          data-testid="scroll-vertical"
          title="Rows: sections stacked full-width"
          className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
            scrollDirection === "vertical" ? "bg-accent text-[var(--on-gradient)] font-semibold" : "text-secondary hover:text-primary"
          }`}
        >
          Vertical
        </button>
      </div>

      <div className="flex items-center gap-0.5 rounded-full bg-elevated p-0.5">
        <button
          onClick={() => onCardLayoutChange("stacked")}
          data-testid="layout-stacked"
          className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
            cardLayout === "stacked" ? "bg-accent text-[var(--on-gradient)] font-semibold" : "text-secondary hover:text-primary"
          }`}
        >
          Stacked
        </button>
        <button
          onClick={() => onCardLayoutChange("side_by_side")}
          data-testid="layout-side-by-side"
          className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
            cardLayout === "side_by_side" ? "bg-accent text-[var(--on-gradient)] font-semibold" : "text-secondary hover:text-primary"
          }`}
        >
          Side-by-side
        </button>
      </div>

      <div className="flex-1" />

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
