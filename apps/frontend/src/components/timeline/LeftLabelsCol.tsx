"use client";

import { useCallback, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import type { BoardSection } from "@/lib/board-sections";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { Modal } from "@/components/ui/Modal";
import { DAY_HEADER_HEIGHT, SECTION_HEADER_HEIGHT } from "./constants";
interface LeftLabelsColProps {
  sections: BoardSection[];
  counts?: Record<string, number>;
  collapsedMap: Record<string, boolean>;
  /** Lane height per section id, so labels line up with the canvas exactly. */
  rowHeights?: Record<string, number>;
  /** Unsorted-task lane count/height; 0 hides the matching row entirely. */
  unsortedCount?: number;
  unsortedHeight?: number;
  onToggleCollapse: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onMove: (id: string, dir: "up" | "down") => void;
  onDelete: (id: string) => void;
  onAddSection: () => void;
  /** Slim rail mode: only a chevron, color dot and count, no titles. */
  rail?: boolean;
  /** Toggle between the full label column and the slim rail. */
  onToggleRail?: () => void;
  scrollRef?: React.Ref<HTMLDivElement>;
}

function SectionHeader({
  section,
  count,
  collapsed,
  height,
  rail,
  onToggleCollapse,
  onContextMenu,
}: {
  section: BoardSection;
  count: number;
  collapsed: boolean;
  height: number;
  rail: boolean;
  onToggleCollapse: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, section: BoardSection) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `section-drop-${section.id}`,
    data: { sectionId: section.id },
  });

  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={() => onToggleCollapse(section.id)}
      onContextMenu={(e) => onContextMenu(e, section)}
      title={section.title}
      aria-label={rail ? `${section.title} (${count})` : undefined}
      aria-expanded={!collapsed}
      style={{ height }}
      className={
        rail
          ? `flex w-full flex-col items-center justify-start gap-1 border-b border-border/20 px-1 py-2 text-left text-xs font-semibold transition-colors ${
              isOver ? "bg-accent/15 text-accent ring-1 ring-inset ring-accent/50" : "text-secondary hover:bg-hover"
            }`
          : `flex w-full items-start gap-1.5 border-b border-border/20 px-2.5 py-2 text-left text-xs font-semibold transition-colors ${
              isOver ? "bg-accent/15 text-accent ring-1 ring-inset ring-accent/50" : "text-secondary hover:bg-hover"
            }`
      }
      data-section-drop-target={section.id}
    >
      <svg
        width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        className={`transition-transform shrink-0 ${rail ? "" : "mt-0.5"} ${collapsed ? "" : "rotate-90"}`}
      >
        <polyline points="9 18 15 12 9 6"/>
      </svg>
      {section.color && (
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${rail ? "" : "mt-1"}`}
          style={{ backgroundColor: section.color }}
        />
      )}
      {!rail && (
        <span className="min-w-0 flex-1 truncate leading-tight text-primary">{section.title}</span>
      )}
      <span className={`shrink-0 rounded-full bg-elevated px-1.5 py-0.5 text-[10px] tabular-nums text-muted ${rail ? "leading-none" : ""}`}>
        {count}
      </span>
    </button>
  );
}

export function LeftLabelsCol({
  sections,
  counts,
  collapsedMap,
  rowHeights,
  unsortedCount,
  unsortedHeight,
  onToggleCollapse,
  onRename,
  onMove,
  onDelete,
  onAddSection,
  rail = false,
  onToggleRail,
  scrollRef,
}: LeftLabelsColProps) {
  const [menu, setMenu] = useState<{
    section: BoardSection;
    x: number;
    y: number;
  } | null>(null);
  const [renameDialog, setRenameDialog] = useState<{
    section: BoardSection;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, section: BoardSection) => {
      e.preventDefault();
      e.stopPropagation();
      setMenu({ section, x: e.clientX, y: e.clientY });
    },
    [],
  );

  return (
    <div
      ref={scrollRef as React.LegacyRef<HTMLDivElement>}
      className={
        rail
          ? "w-10 shrink-0 overflow-y-auto border-r border-border bg-surface"
          : "w-[38vw] max-w-[150px] shrink-0 overflow-y-auto border-r border-border bg-surface sm:w-[140px]"
      }
      style={{ overscrollBehavior: "contain" }}
      data-section-rail={rail ? "true" : "false"}
    >
      {/* Spacer that lines the first lane up with the day header on the canvas.
          It also carries the single collapse/expand control: `>` in rail mode
          (grow the labels back) and `<` when expanded (shrink to the rail). */}
      <div
        className="sticky top-0 z-10 flex items-center justify-center border-b border-border bg-surface"
        style={{ height: DAY_HEADER_HEIGHT }}
      >
        <button
          type="button"
          onClick={onToggleRail}
          aria-label={rail ? "Expand sections" : "Collapse sections"}
          title={rail ? "Expand sections" : "Collapse sections"}
          data-testid={rail ? "expand-sections-rail" : "collapse-sections-rail"}
          className="flex h-7 w-7 items-center justify-center rounded-full text-secondary transition-colors hover:bg-hover hover:text-primary"
        >
          {rail ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          )}
        </button>
      </div>
      <div className="flex flex-col">
        {sections.map((section) => {
          const collapsed = collapsedMap[section.id] ?? false;
          const height = collapsed
            ? SECTION_HEADER_HEIGHT
            : (rowHeights?.[section.id] ?? SECTION_HEADER_HEIGHT);
          return (
            <div key={section.id}>
              <SectionHeader
                section={section}
                count={counts?.[section.id] ?? 0}
                collapsed={collapsed}
                height={height}
                rail={rail}
                onToggleCollapse={onToggleCollapse}
                onContextMenu={handleContextMenu}
              />
            </div>
          );
        })}
        {/* Matches the "Unsorted" lane on the canvas, which renders only when
            it has tasks. Keeps the two columns row-for-row aligned. */}
        {Boolean(unsortedCount) && (
          <div
            style={{ height: unsortedHeight ?? SECTION_HEADER_HEIGHT }}
            title="Unsorted"
            className={
              rail
                ? "flex w-full flex-col items-center justify-start gap-1 border-b border-border/20 px-1 py-2 text-left text-xs font-semibold text-secondary"
                : "flex w-full items-start gap-1.5 border-b border-border/20 px-2.5 py-2 text-left text-xs font-semibold text-secondary"
            }
          >
            {!rail && (
              <>
                <span className="mt-0.5 w-[10px] shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 truncate leading-tight text-primary">Unsorted</span>
              </>
            )}
            <span className="shrink-0 rounded-full bg-elevated px-1.5 py-0.5 text-[10px] tabular-nums text-muted">
              {unsortedCount}
            </span>
          </div>
        )}
        <button
          onClick={onAddSection}
          title="Add section"
          aria-label="Add section"
          className={
            rail
              ? "flex w-full items-center justify-center px-1 py-2 text-xs text-muted transition-colors hover:bg-hover hover:text-primary"
              : "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted transition-colors hover:bg-hover hover:text-primary"
          }
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          {!rail && "Add Section"}
        </button>
      </div>

      <ContextMenu open={!!menu} x={menu?.x ?? 0} y={menu?.y ?? 0} onClose={() => setMenu(null)}>
        {menu && (
          <div className="flex flex-col py-1">
            <button
              onClick={() => {
                setRenameValue(menu.section.title);
                setRenameDialog({ section: menu.section });
                setMenu(null);
              }}
              className="block w-full px-4 py-2 text-left text-xs text-secondary hover:bg-hover hover:text-primary"
            >
              Rename
            </button>
            <button
              onClick={() => { onMove(menu.section.id, "up"); setMenu(null); }}
              className="block w-full px-4 py-2 text-left text-xs text-secondary hover:bg-hover hover:text-primary"
            >
              Move Up
            </button>
            <button
              onClick={() => { onMove(menu.section.id, "down"); setMenu(null); }}
              className="block w-full px-4 py-2 text-left text-xs text-secondary hover:bg-hover hover:text-primary"
            >
              Move Down
            </button>
            <div className="my-1 border-t border-border" />
            <button
              onClick={() => { onDelete(menu.section.id); setMenu(null); }}
              className="block w-full px-4 py-2 text-left text-xs text-danger hover:bg-danger/10"
            >
              Delete
            </button>
          </div>
        )}
      </ContextMenu>

      <Modal
        isOpen={!!renameDialog}
        onClose={() => setRenameDialog(null)}
        title="Rename section"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const title = renameValue.trim();
            if (title && renameDialog) onRename(renameDialog.section.id, title);
            setRenameDialog(null);
          }}
        >
          <input
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            placeholder="Section name"
            aria-label="Section name"
            className="input-field w-full"
          />
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setRenameDialog(null)}
              className="btn bg-elevated border border-border text-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!renameValue.trim()}
              className="btn btn-primary disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
