"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  MouseSensor,
  TouchSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { useAppStore } from "@/stores/app-store";
import { useLists } from "@/hooks/useLists";
import { usePreferencesStore } from "@/stores/preferences-store";
import {
  PREF_LIST_SECTIONS,
  readListSections,
  type ListSection,
  type ListSectionsConfig,
} from "@/lib/preferences";
import { useToast } from "@/lib/toast-context";
import { TrashView } from "@/components/trash/TrashView";
import type { WorkspaceView } from "@/components/layout/AppShell";
import type { TaskList } from "@/types/task";

const DEFAULT_LIST_NAME = "My Tasks";

interface SidebarListsProps {
  view: WorkspaceView;
  onSelectView: (v: WorkspaceView) => void;
}

const SECTION_PREFIX = "section:";
const SECTION_HEADER_PREFIX = "sectionheader:";
const LIST_PREFIX = "list:";
const UNGROUPED_ID = "ungrouped";

function newSectionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `sec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const GripIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="9" cy="6" r="1.6" />
    <circle cx="15" cy="6" r="1.6" />
    <circle cx="9" cy="12" r="1.6" />
    <circle cx="15" cy="12" r="1.6" />
    <circle cx="9" cy="18" r="1.6" />
    <circle cx="15" cy="18" r="1.6" />
  </svg>
);

const PencilIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </svg>
);

const CloseIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

const ListIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="8" y1="6" x2="21" y2="6" />
    <line x1="8" y1="12" x2="21" y2="12" />
    <line x1="8" y1="18" x2="21" y2="18" />
    <line x1="3" y1="6" x2="3.01" y2="6" />
    <line x1="3" y1="12" x2="3.01" y2="12" />
    <line x1="3" y1="18" x2="3.01" y2="18" />
  </svg>
);

function ListRow({
  id,
  name,
  count,
  isActive,
  onSelect,
  onRename,
  onDelete,
}: {
  id: string;
  name: string;
  count: number;
  isActive: boolean;
  onSelect: () => void;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The default list is the home for new tasks and the reassignment target when
  // another list is deleted, so it is permanent: no rename, no delete.
  const isDefault = name === DEFAULT_LIST_NAME;
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `${LIST_PREFIX}${id}`,
  });

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = async () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== name) {
      setBusy(true);
      try {
        await onRename(trimmed);
      } finally {
        setBusy(false);
      }
    }
    setEditing(false);
  };

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : 1,
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void save()}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") {
            setValue(name);
            setEditing(false);
          }
        }}
        disabled={busy}
        className="input-field mx-1 h-7 text-xs"
        aria-label="List name"
      />
    );
  }

  return (
    <div ref={setNodeRef} style={style} className="group flex items-center">
      <button
        {...attributes}
        {...listeners}
        className="pointer-coarse:opacity-100 flex h-5 w-4 shrink-0 cursor-grab items-center justify-center text-muted opacity-0 transition-opacity hover:text-primary group-hover:opacity-100 active:cursor-grabbing"
        title="Drag list"
        aria-label={`Reorder ${name}`}
      >
        <GripIcon />
      </button>
      <button
        onClick={onSelect}
        className={`sidebar-item flex-1 text-[13px] ${isActive ? "active" : ""}`}
        aria-current={isActive ? "page" : undefined}
        title={name}
      >
        <span className="text-secondary group-hover:text-primary">
          <ListIcon />
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{name}</span>
        {count > 0 && (
          <span className={`badge ml-auto ${isActive ? "bg-accent/20 text-accent" : "bg-elevated text-muted"}`}>
            {count}
          </span>
        )}
      </button>
      {!isDefault && (
        <>
          <button
            onClick={() => setEditing(true)}
            className="pointer-coarse:opacity-100 pointer-coarse:h-9 pointer-coarse:w-9 mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-opacity hover:bg-hover hover:text-primary group-hover:opacity-100"
            title="Rename list"
            aria-label={`Rename ${name}`}
          >
            <PencilIcon />
          </button>
          <button
            onClick={() => void onDelete()}
            className="pointer-coarse:opacity-100 pointer-coarse:h-9 pointer-coarse:w-9 mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-opacity hover:bg-danger/20 hover:text-danger group-hover:opacity-100"
            title="Delete list"
            aria-label={`Delete ${name}`}
          >
            <CloseIcon />
          </button>
        </>
      )}
    </div>
  );
}

function SectionBlock({
  section,
  lists,
  counts,
  view,
  activeListId,
  onSelectList,
  onRenameList,
  onDeleteList,
  onRename,
  onDelete,
  onToggleCollapsed,
}: {
  section: ListSection;
  lists: TaskList[];
  counts: Map<string, number>;
  view: WorkspaceView;
  activeListId: string | null;
  onSelectList: (id: string) => void;
  onRenameList: (id: string, name: string) => Promise<void>;
  onDeleteList: (id: string) => Promise<void>;
  onRename: (name: string) => void;
  onDelete: () => void;
  onToggleCollapsed: () => void;
}) {
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `${SECTION_PREFIX}${section.id}` });
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
    transform,
    isDragging,
  } = useDraggable({ id: `${SECTION_HEADER_PREFIX}${section.id}` });
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(section.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);
  useEffect(() => {
    setValue(section.name);
  }, [section.name]);

  const sectionLists = section.listIds
    .map((id) => lists.find((l) => l.id === id))
    .filter((l): l is TaskList => Boolean(l));

  const save = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== section.name) onRename(trimmed);
    else setValue(section.name);
    setEditing(false);
  };

  return (
    <div
      ref={setDropRef}
      style={{ transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.6 : 1 }}
      className={`rounded-md transition-colors ${isOver ? "bg-accent/10 ring-1 ring-accent/40" : ""}`}
    >
      <div className="group flex items-center">
        <button
          ref={setDragRef}
          {...attributes}
          {...listeners}
        className="pointer-coarse:opacity-100 pointer-coarse:h-9 pointer-coarse:w-7 flex h-5 w-4 shrink-0 cursor-grab items-center justify-center text-muted opacity-0 transition-opacity hover:text-primary group-hover:opacity-100 active:cursor-grabbing"
          title="Reorder section"
          aria-label={`Reorder ${section.name}`}
        >
          <GripIcon />
        </button>
        <button
          onClick={onToggleCollapsed}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted transition-transform hover:bg-hover hover:text-primary ${section.collapsed ? "" : "rotate-90"}`}
          aria-expanded={!section.collapsed}
          aria-label={section.collapsed ? `Expand ${section.name}` : `Collapse ${section.name}`}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        {editing ? (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") {
                setValue(section.name);
                setEditing(false);
              }
            }}
            className="input-field mx-1 h-6 flex-1 text-xs"
            aria-label="Section name"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate px-1 text-[11px] font-semibold uppercase tracking-wide text-secondary">
            {section.name}
          </span>
        )}
        {sectionLists.length > 0 && (
          <span className="badge ml-auto bg-elevated text-muted">{sectionLists.length}</span>
        )}
        <button
          onClick={() => {
            setValue(section.name);
            setEditing(true);
          }}
          className="pointer-coarse:opacity-100 mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-opacity hover:bg-hover hover:text-primary group-hover:opacity-100"
          title="Rename section"
          aria-label={`Rename ${section.name}`}
        >
          <PencilIcon />
        </button>
        <button
          onClick={onDelete}
          className="pointer-coarse:opacity-100 mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-opacity hover:bg-danger/20 hover:text-danger group-hover:opacity-100"
          title="Delete section"
          aria-label={`Delete ${section.name}`}
        >
          <CloseIcon />
        </button>
      </div>
      {!section.collapsed && (
        <div className="space-y-0.5 pl-3">
          {sectionLists.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-muted">Drag lists here</p>
          ) : (
            sectionLists.map((list) => (
              <ListRow
                key={list.id}
                id={list.id}
                name={list.name}
                count={counts.get(list.id) || 0}
                isActive={view === "timeline" && activeListId === list.id}
                onSelect={() => onSelectList(list.id)}
                onRename={(name) => onRenameList(list.id, name)}
                onDelete={() => onDeleteList(list.id)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function UngroupedArea({ children }: { children: React.ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: UNGROUPED_ID });
  return (
    <div
      ref={setNodeRef}
      className={`space-y-0.5 rounded-md transition-colors ${isOver ? "bg-accent/10 ring-1 ring-accent/40" : ""}`}
    >
      {children}
    </div>
  );
}

export function SidebarLists({ view, onSelectView }: SidebarListsProps) {
  const tasks = useAppStore((s) => s.tasks);
  const activeListId = useAppStore((s) => s.activeListId);
  const setActiveListId = useAppStore((s) => s.setActiveListId);
  const setNavFilter = useAppStore((s) => s.setNavFilter);
  const { lists, createList, renameList, deleteList } = useLists();
  const { showToast } = useToast();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [addingSection, setAddingSection] = useState(false);
  const [newSectionName, setNewSectionName] = useState("");
  const [trashOpen, setTrashOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const newInputRef = useRef<HTMLInputElement | null>(null);
  const newSectionInputRef = useRef<HTMLInputElement | null>(null);

  const rawSections = usePreferencesStore((s) => s.prefs[PREF_LIST_SECTIONS]);
  const sections = useMemo<ListSection[]>(() => {
    const cfg = rawSections as ListSectionsConfig | undefined;
    if (cfg && typeof cfg === "object" && Array.isArray(cfg.sections)) return cfg.sections;
    return readListSections();
  }, [rawSections]);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } })
  );

  useEffect(() => {
    if (adding) newInputRef.current?.focus();
  }, [adding]);
  useEffect(() => {
    if (addingSection) newSectionInputRef.current?.focus();
  }, [addingSection]);

  const counts = new Map<string, number>();
  for (const t of tasks) {
    if (t.status === "done" || t.status === "cancelled") continue;
    if (t.list_id) counts.set(t.list_id, (counts.get(t.list_id) || 0) + 1);
  }

  const grouped = new Set(sections.flatMap((s) => s.listIds));
  const ungrouped = lists.filter((l) => !grouped.has(l.id));

  const persistSections = (next: ListSection[]) => {
    usePreferencesStore.getState().setPreference(PREF_LIST_SECTIONS, { sections: next });
  };

  const selectList = (id: string | null) => {
    if (view !== "timeline") onSelectView("timeline");
    setNavFilter(null);
    setActiveListId(activeListId === id ? null : id);
  };

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) {
      setAdding(false);
      return;
    }
    try {
      const list = await createList(name);
      setNewName("");
      setAdding(false);
      if (list) selectList(list.id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to create list", "error");
    }
  };

  const handleCreateSection = () => {
    const name = newSectionName.trim();
    if (!name) {
      setAddingSection(false);
      return;
    }
    persistSections([...sections, { id: newSectionId(), name, listIds: [] }]);
    setNewSectionName("");
    setAddingSection(false);
  };

  const handleRenameSection = (id: string, name: string) => {
    persistSections(sections.map((s) => (s.id === id ? { ...s, name } : s)));
  };

  const handleDeleteSection = (id: string) => {
    const section = sections.find((s) => s.id === id);
    if (section && !window.confirm(`Delete section "${section.name}"? Its lists stay in your sidebar.`)) return;
    persistSections(sections.filter((s) => s.id !== id));
  };

  const handleToggleCollapsed = (id: string) => {
    persistSections(sections.map((s) => (s.id === id ? { ...s, collapsed: !s.collapsed } : s)));
  };

  const handleDelete = async (id: string) => {
    const list = lists.find((l) => l.id === id);
    if (list && list.name === DEFAULT_LIST_NAME) {
      showToast(`"${DEFAULT_LIST_NAME}" can't be deleted`, "error");
      return;
    }
    if (list && !window.confirm(`Delete "${list.name}"? Its tasks move to My Tasks.`)) return;
    try {
      await deleteList(id);
      const next = sections.map((s) =>
        s.listIds.includes(id) ? { ...s, listIds: s.listIds.filter((x) => x !== id) } : s
      );
      if (next.some((s, i) => s.listIds.length !== sections[i].listIds.length)) {
        persistSections(next);
      }
      showToast("List deleted", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to delete list", "error");
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const activeIdStr = String(active.id);
    const overIdStr = String(over.id);

    if (activeIdStr.startsWith(SECTION_HEADER_PREFIX)) {
      const fromId = activeIdStr.slice(SECTION_HEADER_PREFIX.length);
      let toId: string | null = null;
      if (overIdStr.startsWith(SECTION_HEADER_PREFIX)) {
        toId = overIdStr.slice(SECTION_HEADER_PREFIX.length);
      } else if (overIdStr.startsWith(SECTION_PREFIX)) {
        toId = overIdStr.slice(SECTION_PREFIX.length);
      }
      if (!toId || fromId === toId) return;
      const fromIdx = sections.findIndex((s) => s.id === fromId);
      const toIdx = sections.findIndex((s) => s.id === toId);
      if (fromIdx < 0 || toIdx < 0) return;
      const next = [...sections];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      persistSections(next);
      return;
    }

    if (!activeIdStr.startsWith(LIST_PREFIX)) return;
    const listId = activeIdStr.slice(LIST_PREFIX.length);
    let targetSectionId: string | null = null;
    let insertIndex: number | null = null;

    if (overIdStr === UNGROUPED_ID) {
      targetSectionId = null;
    } else if (overIdStr.startsWith(SECTION_PREFIX)) {
      targetSectionId = overIdStr.slice(SECTION_PREFIX.length);
    } else if (overIdStr.startsWith(LIST_PREFIX)) {
      const overListId = overIdStr.slice(LIST_PREFIX.length);
      const hostSection = sections.find((s) => s.listIds.includes(overListId));
      if (hostSection) {
        targetSectionId = hostSection.id;
        const filtered = hostSection.listIds.filter((x) => x !== listId);
        const idx = filtered.indexOf(overListId);
        insertIndex = idx >= 0 ? idx : filtered.length;
      } else {
        targetSectionId = null;
      }
    } else {
      return;
    }

    const next = sections.map((s) => ({ ...s, listIds: s.listIds.filter((x) => x !== listId) }));
    if (targetSectionId) {
      const target = next.find((s) => s.id === targetSectionId);
      if (!target) return;
      const at = insertIndex === null ? target.listIds.length : Math.min(insertIndex, target.listIds.length);
      target.listIds.splice(at, 0, listId);
    }
    persistSections(next);
  };

  const overlayLabel = activeId
    ? activeId.startsWith(LIST_PREFIX)
      ? lists.find((l) => l.id === activeId.slice(LIST_PREFIX.length))?.name
      : activeId.startsWith(SECTION_HEADER_PREFIX)
        ? sections.find((s) => s.id === activeId.slice(SECTION_HEADER_PREFIX.length))?.name
        : null
    : null;

  const hasSections = sections.length > 0;

  return (
    <>
      <div className="mt-5">
        <div className="flex items-center justify-between px-2 pb-1.5">
          <p className="nav-label">Lists</p>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => {
                setNewSectionName("");
                setAddingSection(true);
              }}
              className="pointer-coarse:h-9 pointer-coarse:w-9 flex h-5 w-5 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-primary"
              title="New section"
              aria-label="New section"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m12 2 9 5-9 5-9-5 9-5Z" />
                <path d="m3 12 9 5 9-5" />
                <path d="m3 17 9 5 9-5" />
              </svg>
            </button>
            <button
              onClick={() => setAdding(true)}
              className="pointer-coarse:h-9 pointer-coarse:w-9 flex h-5 w-5 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-primary"
              title="New list"
              aria-label="New list"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
        </div>

        {addingSection && (
          <input
            ref={newSectionInputRef}
            value={newSectionName}
            onChange={(e) => setNewSectionName(e.target.value)}
            onBlur={handleCreateSection}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateSection();
              if (e.key === "Escape") setAddingSection(false);
            }}
            placeholder="Section name"
            className="input-field mx-1 mb-0.5 h-7 text-xs"
            aria-label="New section name"
          />
        )}

        {adding && (
          <input
            ref={newInputRef}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onBlur={() => void handleCreate()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleCreate();
              if (e.key === "Escape") setAdding(false);
            }}
            placeholder="List name"
            className="input-field mx-1 mb-0.5 h-7 text-xs"
            aria-label="New list name"
          />
        )}

        {lists.length === 0 && sections.length === 0 && !adding ? (
          <p className="px-2 py-1 text-[11px] text-muted">No lists yet</p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCorners}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <div className="space-y-1">
              {sections.map((section) => (
                <SectionBlock
                  key={section.id}
                  section={section}
                  lists={lists}
                  counts={counts}
                  view={view}
                  activeListId={activeListId}
                  onSelectList={selectList}
                  onRenameList={renameList}
                  onDeleteList={handleDelete}
                  onRename={(name) => handleRenameSection(section.id, name)}
                  onDelete={() => handleDeleteSection(section.id)}
                  onToggleCollapsed={() => handleToggleCollapsed(section.id)}
                />
              ))}

              {hasSections ? (
                <UngroupedArea>
                  {ungrouped.length === 0 ? (
                    <p className="px-2 py-1 text-[11px] text-muted">Drop lists here to ungroup</p>
                  ) : (
                    ungrouped.map((list) => (
                      <ListRow
                        key={list.id}
                        id={list.id}
                        name={list.name}
                        count={counts.get(list.id) || 0}
                        isActive={view === "timeline" && activeListId === list.id}
                        onSelect={() => selectList(list.id)}
                        onRename={(name) => renameList(list.id, name)}
                        onDelete={() => handleDelete(list.id)}
                      />
                    ))
                  )}
                </UngroupedArea>
              ) : (
                ungrouped.map((list) => (
                  <ListRow
                    key={list.id}
                    id={list.id}
                    name={list.name}
                    count={counts.get(list.id) || 0}
                    isActive={view === "timeline" && activeListId === list.id}
                    onSelect={() => selectList(list.id)}
                    onRename={(name) => renameList(list.id, name)}
                    onDelete={() => handleDelete(list.id)}
                  />
                ))
              )}
            </div>
            <DragOverlay>
              {overlayLabel ? (
                <div className="flex items-center gap-2 rounded-md border border-border bg-elevated px-2 py-1 text-[13px] text-primary shadow-md">
                  <span className="truncate">{overlayLabel}</span>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}

        <button
          onClick={() => setTrashOpen(true)}
          className="sidebar-item mt-1 text-[13px] w-full"
        >
          <span className="text-secondary group-hover:text-primary">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
          </span>
          <span className="flex-1 text-left">Trash</span>
        </button>
      </div>

      <TrashView open={trashOpen} onClose={() => setTrashOpen(false)} />
    </>
  );
}
