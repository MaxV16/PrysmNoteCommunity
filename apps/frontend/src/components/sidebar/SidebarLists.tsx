"use client";

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/stores/app-store";
import { useLists } from "@/hooks/useLists";
import { useToast } from "@/lib/toast-context";
import { TrashView } from "@/components/trash/TrashView";
import type { WorkspaceView } from "@/components/layout/AppShell";

interface SidebarListsProps {
  view: WorkspaceView;
  onSelectView: (v: WorkspaceView) => void;
}

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
    <div className="group flex items-center">
      <button
        onClick={onSelect}
        className={`sidebar-item flex-1 text-[13px] ${isActive ? "active" : ""}`}
        aria-current={isActive ? "page" : undefined}
        title={name}
      >
        <span className="text-secondary group-hover:text-primary">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
        </span>
        <span className="min-w-0 flex-1 truncate text-left">{name}</span>
        {count > 0 && (
          <span className={`badge ml-auto ${isActive ? "bg-accent/20 text-accent" : "bg-elevated text-muted"}`}>
            {count}
          </span>
        )}
      </button>
      <button
        onClick={() => setEditing(true)}
        className="pointer-coarse:opacity-100 mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-opacity hover:bg-hover hover:text-primary group-hover:opacity-100"
        title="Rename list"
        aria-label={`Rename ${name}`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
      </button>
      <button
        onClick={() => void onDelete()}
        className="pointer-coarse:opacity-100 mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-opacity hover:bg-danger/20 hover:text-danger group-hover:opacity-100"
        title="Delete list"
        aria-label={`Delete ${name}`}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
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
  const [trashOpen, setTrashOpen] = useState(false);
  const newInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (adding) newInputRef.current?.focus();
  }, [adding]);

  const counts = new Map<string, number>();
  for (const t of tasks) {
    if (t.status === "done" || t.status === "cancelled") continue;
    if (t.list_id) counts.set(t.list_id, (counts.get(t.list_id) || 0) + 1);
  }

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

  const handleDelete = async (id: string) => {
    const list = lists.find((l) => l.id === id);
    if (list && !window.confirm(`Delete "${list.name}"? Its tasks move to My Tasks.`)) return;
    try {
      await deleteList(id);
      showToast("List deleted", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to delete list", "error");
    }
  };

  return (
    <>
      <div className="mt-5">
        <div className="flex items-center justify-between px-2 pb-1.5">
          <p className="nav-label">Lists</p>
          <button
            onClick={() => setAdding(true)}
            className="flex h-5 w-5 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-primary"
            title="New list"
            aria-label="New list"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>

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

        {lists.length === 0 && !adding ? (
          <p className="px-2 py-1 text-[11px] text-muted">No lists yet</p>
        ) : (
          <div className="space-y-0.5">
            {lists.map((list) => (
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
            ))}
          </div>
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