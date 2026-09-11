"use client";

import { useMemo, useState } from "react";
import { useAppStore } from "@/stores/app-store";
import { useSections } from "@/hooks/useSections";
import { ContextMenu, ContextMenuItem, ContextMenuDivider } from "@/components/ui/ContextMenu";
import { matchesRule, sectionColor } from "@/lib/timeline-section-utils";

/** Sidebar "Sections" group: collapsible section headers (chevron + context
 * menu) whose expanded state shows the section's matching tasks as compact
 * pills. The horizontal pill rows on the timeline itself live in
 * `SectionsPanel`. */
export function SectionsSection() {
  const tasks = useAppStore((s) => s.tasks);
  const lists = useAppStore((s) => s.lists);
  const tags = useAppStore((s) => s.tags);
  const setSelectedTaskId = useAppStore((s) => s.setSelectedTaskId);
  const { sections, loading, addSection, renameSection, removeSection } = useSections();

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ sectionId: string; x: number; y: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const rows = useMemo(() => {
    return sections.map((section, idx) => {
      const matching = tasks.filter((t) => matchesRule(t, section, lists, tags));
      return { section, idx, matching };
    });
  }, [sections, tasks, lists, tags]);

  const addEmpty = async () => {
    await addSection({ name: `Section ${sections.length + 1}`, rule_kind: "all" });
  };

  const addAt = async (sectionId: string, where: "above" | "below") => {
    const target = sections.find((s) => s.id === sectionId);
    const position = target ? (where === "above" ? target.position - 1 : target.position + 1) : undefined;
    await addSection({ name: `Section ${sections.length + 1}`, rule_kind: "all", position });
  };

  const startRename = (sectionId: string, current: string) => {
    setEditingId(sectionId);
    setDraft(current);
    setMenu(null);
  };

  const commitRename = (sectionId: string) => {
    const name = draft.trim();
    if (name) renameSection(sectionId, { name });
    setEditingId(null);
  };

  return (
    <div>
      <div className="flex items-center px-2 pb-1.5">
        <p className="nav-label flex-1">Sections</p>
        <button
          onClick={() => void addEmpty()}
          className="flex h-5 w-5 items-center justify-center rounded-full text-xs text-secondary transition-colors hover:bg-hover hover:text-primary"
          title="Add a section"
          aria-label="Add a section"
        >
          +
        </button>
      </div>
      {loading && sections.length === 0 ? (
        <div className="px-2 text-[11px] text-muted">Loading sections...</div>
      ) : sections.length === 0 ? (
        <p className="px-2 pb-1 text-[11px] text-muted">
          No sections yet. Add one to organize tasks into pill rows.
        </p>
      ) : (
        <div className="space-y-0.5">
          {rows.map(({ section, idx, matching }) => {
            const color = sectionColor(section, idx);
            const isCollapsed = collapsed[section.id];
            const isEditing = editingId === section.id;
            return (
              <div key={section.id}>
                <div
                  className="sidebar-item text-[13px]"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setMenu({ sectionId: section.id, x: e.clientX, y: e.clientY });
                  }}
                >
                  <button
                    onClick={() => setCollapsed((prev) => ({ ...prev, [section.id]: !prev[section.id] }))}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                    aria-expanded={!isCollapsed}
                  >
                    <svg
                      width="8"
                      height="8"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      className={`shrink-0 text-secondary transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                    {isEditing ? (
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commitRename(section.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(section.id);
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        className="input-field min-w-0 flex-1 px-1.5 py-0 text-xs"
                        aria-label={`Rename section ${section.name}`}
                      />
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-primary">{section.name}</span>
                    )}
                  </button>
                  {!isEditing && (
                    <span className={`badge ${matching.length > 0 ? "bg-elevated text-muted" : ""}`}>
                      {matching.length}
                    </span>
                  )}
                </div>
                {!isCollapsed && matching.length > 0 && (
                  <div className="ml-8 flex flex-wrap gap-1 pb-1.5 pt-0.5">
                    {matching.slice(0, 6).map((t) => (
                      <button
                        key={t.id}
                        onClick={() => setSelectedTaskId(t.id)}
                        className="max-w-[150px] truncate rounded-full border border-border/60 bg-elevated px-2 py-0.5 text-[10px] text-secondary transition-colors hover:border-accent/40 hover:text-primary"
                        title={t.title}
                      >
                        {t.title}
                      </button>
                    ))}
                    {matching.length > 6 && (
                      <span className="rounded-full px-1.5 py-0.5 text-[10px] text-muted">+{matching.length - 6}</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ContextMenu
        open={!!menu}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
      >
        <ContextMenuItem
          onClick={() => {
            const section = sections.find((s) => s.id === menu?.sectionId);
            if (section) startRename(section.id, section.name);
          }}
        >
          Rename
        </ContextMenuItem>
        <ContextMenuItem onClick={() => menu && void addAt(menu.sectionId, "above")}>
          Add Section Above
        </ContextMenuItem>
        <ContextMenuItem onClick={() => menu && void addAt(menu.sectionId, "below")}>
          Add Section Below
        </ContextMenuItem>
        <ContextMenuDivider />
        <ContextMenuItem
          danger
          onClick={() => menu && void removeSection(menu.sectionId)}
        >
          Delete
        </ContextMenuItem>
      </ContextMenu>
    </div>
  );
}