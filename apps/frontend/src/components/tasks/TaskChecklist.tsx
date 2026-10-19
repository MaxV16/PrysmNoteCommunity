"use client";

import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { api } from "@/lib/api";
import type { Task } from "@/types/task";
import { useTasks } from "@/hooks/useTasks";
import { Markdown } from "@/components/ai/Markdown";
import { MarkdownToolbar } from "@/components/ui/MarkdownToolbar";
import { MarkdownImagePreview } from "@/components/ui/MarkdownImagePreview";
import { SUBTASK_TITLE_MAX, SUBTASK_DESCRIPTION_MAX } from "@/lib/char-limits";
import { CharLimitHint } from "@/components/ui/CharLimitHint";
import {
  imageSourceFrom,
  insertImageAtCursor,
  type ImageInsertSource,
} from "@/lib/upload";

interface TaskChecklistProps {
  subtasks: Task[];
  taskId: string;
}

// Open subtasks first, completed ones sink to the bottom. The sort is stable,
// so the persisted order (sort_order) is kept inside each group and every
// device renders the same list.
export function sortSubtasks(list: Task[]): Task[] {
  const open = list.filter((s) => s.status !== "done");
  const done = list.filter((s) => s.status === "done");
  return [...open, ...done];
}

interface CheckboxButtonProps {
  checked: boolean;
  onChange: () => Promise<void>;
  id: string;
}

function CheckboxButton({ checked, onChange, id }: CheckboxButtonProps) {
  const [pending, setPending] = useState(false);
  return (
    <button
      id={id}
      data-checked={checked}
      aria-checked={checked}
      role="checkbox"
      onClick={(e) => {
        e.stopPropagation();
        setPending(true);
        void onChange().finally(() => setPending(false));
      }}
      className={`flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded-full border-2 transition-all ${
        checked
          ? "check-gradient border-transparent"
          : "border-border hover:border-accent"
      }`}
    >
      {checked && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--on-gradient)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      {pending && <span className="h-1.5 w-1.5 rounded-full bg-[var(--on-gradient)]/70 animate-ping" />}
    </button>
  );
}

interface SortableRowProps {
  sub: Task;
  onToggle: (sub: Task) => Promise<void>;
  onDelete: (sub: Task) => Promise<void>;
  onRename: (sub: Task, title: string) => Promise<void>;
  onUpdateDescription: (sub: Task, description: string) => Promise<void>;
}

function SortableRow({ sub, onToggle, onDelete, onRename, onUpdateDescription }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sub.id,
  });
  const [editing, setEditing] = useState(false);
  const [withToolbar, setWithToolbar] = useState(false);
  const [draft, setDraft] = useState(sub.title);
  const [expanded, setExpanded] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descDraft, setDescDraft] = useState(sub.description || "");
  const [descError, setDescError] = useState<string | null>(null);
  const [descUploading, setDescUploading] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [titleUploading, setTitleUploading] = useState(false);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);
  const descRef = useRef<HTMLTextAreaElement | null>(null);
  const done = sub.status === "done";
  const isLong = sub.title.length > 140 || sub.title.includes("\n");

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const startEditing = (toolbar: boolean) => {
    setDraft(sub.title);
    setWithToolbar(toolbar);
    setEditing(true);
  };

  const commitEdit = async () => {
    // Keep the editor open while a pasted image is still uploading, otherwise
    // the markdown would be saved without the image.
    if (titleUploading) return;
    // Save before closing so the row cannot flash the stale title while the
    // PATCH is in flight (same reason as the task description editor). Read the
    // live input value so an image inserted a moment ago is never dropped by a
    // state update that has not rendered yet.
    const next = (renameRef.current?.value ?? draftRef.current?.value ?? draft).trim();
    if (next.length > SUBTASK_TITLE_MAX) {
      // Keep the editor open so the over-limit counter stays visible.
      return;
    }
    if (next && next !== sub.title) await onRename(sub, next);
    setEditing(false);
    setWithToolbar(false);
  };

  const startDescriptionEdit = () => {
    setDescDraft(sub.description || "");
    setDescError(null);
    setEditingDescription(true);
  };

  const saveDescription = async () => {
    // Keep the editor open while the pasted image is still uploading.
    if (descUploading) return;
    if (descDraft.length > SUBTASK_DESCRIPTION_MAX) {
      setDescError(`Description is ${(descDraft.length - SUBTASK_DESCRIPTION_MAX).toLocaleString()} characters over the limit.`);
      return;
    }
    setDescError(null);
    try {
      await onUpdateDescription(sub, descDraft.trim());
      setEditingDescription(false);
    } catch (err) {
      setDescError(err instanceof Error ? err.message : "Could not save that description.");
    }
  };

  const handleTitleImage = async (
    target: HTMLTextAreaElement | HTMLInputElement | null,
    source: ImageInsertSource | null
  ) => {
    if (!target || !source) return;
    setTitleError(null);
    setTitleUploading(true);
    try {
      await insertImageAtCursor(target, source, setDraft);
    } catch (err) {
      setTitleError(err instanceof Error ? err.message : "Could not upload that image.");
    } finally {
      setTitleUploading(false);
    }
  };

  const handleDescriptionImage = async (source: ImageInsertSource | null) => {
    const ta = descRef.current;
    if (!ta || !source) return;
    setDescError(null);
    setDescUploading(true);
    try {
      await insertImageAtCursor(ta, source, setDescDraft);
    } catch (err) {
      setDescError(err instanceof Error ? err.message : "Could not upload that image.");
    } finally {
      setDescUploading(false);
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group flex items-center gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-hover/60"
      onDoubleClick={() => {
        // Double-clicking inside an editor is how users select a word or a
        // paragraph. Starting a rename here used to reset the draft and close
        // the formatter, so the toolbar vanished mid-selection.
        if (editing || editingDescription) return;
        startEditing(false);
      }}
    >
      <button
        {...listeners}
        {...attributes}
        className="pointer-coarse:opacity-100 cursor-grab touch-none text-muted opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        aria-label="Drag to reorder"
        onClick={(e) => e.stopPropagation()}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="6" r="1.5" />
          <circle cx="15" cy="6" r="1.5" />
          <circle cx="9" cy="12" r="1.5" />
          <circle cx="15" cy="12" r="1.5" />
          <circle cx="9" cy="18" r="1.5" />
          <circle cx="15" cy="18" r="1.5" />
        </svg>
      </button>
      <CheckboxButton
        id={`subtask-check-${sub.id}`}
        checked={done}
        onChange={() => onToggle(sub)}
      />
      {editing ? (
        withToolbar ? (
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <MarkdownToolbar textareaRef={draftRef} onChange={setDraft} variant="inline" />
            <textarea
              ref={draftRef}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={(e) => {
                const source = imageSourceFrom(e.clipboardData);
                if (!source) return;
                e.preventDefault();
                void handleTitleImage(draftRef.current, source);
              }}
              onDragOver={(e) => {
                if (imageSourceFrom(e.dataTransfer)) e.preventDefault();
              }}
              onDrop={(e) => {
                const source = imageSourceFrom(e.dataTransfer);
                if (!source) return;
                e.preventDefault();
                void handleTitleImage(draftRef.current, source);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                // The toolbar's image picker moves focus to a hidden file
                // input; do not commit and close before the upload lands.
                if (e.relatedTarget instanceof HTMLInputElement && e.relatedTarget.type === "file") return;
                void commitEdit();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  (e.target as HTMLTextAreaElement).blur();
                }
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setEditing(false);
                  setWithToolbar(false);
                }
              }}
              rows={2}
              className="input-field w-full bg-transparent px-1 py-0 text-sm"
            />
            {titleUploading && (
              <span role="status" className="text-[10px] text-secondary">
                Uploading image...
              </span>
            )}
            {titleError && (
              <p role="alert" className="text-[10px] text-danger">
                {titleError}
              </p>
            )}
            <MarkdownImagePreview text={draft} />
            <CharLimitHint value={draft} max={SUBTASK_TITLE_MAX} className="mt-1" />
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <input
              ref={renameRef}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={(e) => {
                const source = imageSourceFrom(e.clipboardData);
                if (!source) return;
                e.preventDefault();
                void handleTitleImage(renameRef.current, source);
              }}
              onDragOver={(e) => {
                if (imageSourceFrom(e.dataTransfer)) e.preventDefault();
              }}
              onDrop={(e) => {
                const source = imageSourceFrom(e.dataTransfer);
                if (!source) return;
                e.preventDefault();
                void handleTitleImage(renameRef.current, source);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              onBlur={() => void commitEdit()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  (e.target as HTMLInputElement).blur();
                }
                if (e.key === "Escape") setEditing(false);
              }}
              className="input-field bg-transparent text-sm px-1 py-0"
            />
            {titleUploading && (
              <span role="status" className="text-[10px] text-secondary">
                Uploading image...
              </span>
            )}
            {titleError && (
              <p role="alert" className="text-[10px] text-danger">
                {titleError}
              </p>
            )}
            <MarkdownImagePreview text={draft} />
            <CharLimitHint value={draft} max={SUBTASK_TITLE_MAX} className="mt-1" />
          </div>
        )
      ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex min-w-0 items-start gap-1">
            <div
              className={`min-w-0 flex-1 break-words text-sm ${
                done
                  ? "[&_.markdown-body]:text-muted [&_.markdown-body]:line-through"
                  : "text-primary"
              } ${
                isLong && !expanded
                  ? "[&_.markdown-body]:line-clamp-3 sm:[&_.markdown-body]:line-clamp-5"
                  : ""
              }`}
            >
              <Markdown compact>{sub.title}</Markdown>
            </div>
            {isLong && (
              <button
                onClick={() => setExpanded((v) => !v)}
                aria-label={expanded ? "Collapse subtask" : "Expand subtask"}
                aria-expanded={expanded}
                className="pointer-coarse:opacity-100 flex shrink-0 items-center justify-center rounded p-1 text-muted transition-opacity hover:text-primary group-hover:opacity-100"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={expanded ? "rotate-180 transition-transform" : "transition-transform"}><polyline points="6 9 12 15 18 9" /></svg>
              </button>
            )}
            <button
              onClick={startDescriptionEdit}
              aria-label={`Edit description for ${sub.title}`}
              className="pointer-coarse:opacity-100 flex shrink-0 items-center justify-center rounded p-1 text-muted opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h10"/></svg>
            </button>
            <button
              onClick={() => startEditing(true)}
              aria-label={`Format ${sub.title}`}
              className="pointer-coarse:opacity-100 flex shrink-0 items-center justify-center rounded p-1 text-muted opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>
            </button>
            <button
              onClick={() => startEditing(false)}
              aria-label={`Rename ${sub.title}`}
              className="pointer-coarse:opacity-100 flex shrink-0 items-center justify-center rounded p-1 text-muted opacity-0 transition-opacity hover:text-primary group-hover:opacity-100"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
            </button>
            </div>
            {editingDescription ? (
              <div className="ml-1 rounded-lg border border-border/60 bg-elevated/40 p-1.5">
                <MarkdownToolbar
                  textareaRef={descRef}
                  onChange={setDescDraft}
                  className="mb-1 border-b border-border/60 pb-1"
                />
                <textarea
                  ref={descRef}
                  autoFocus
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  onPaste={(e) => {
                    const source = imageSourceFrom(e.clipboardData);
                    if (!source) return;
                    e.preventDefault();
                    void handleDescriptionImage(source);
                  }}
                  onDragOver={(e) => {
                    if (imageSourceFrom(e.dataTransfer)) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    const source = imageSourceFrom(e.dataTransfer);
                    if (!source) return;
                    e.preventDefault();
                    void handleDescriptionImage(source);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void saveDescription();
                    }
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setEditingDescription(false);
                    }
                  }}
                  placeholder="Add notes, links, or images..."
                  rows={3}
                  className="input-field w-full bg-transparent text-xs"
                />
                <MarkdownImagePreview text={descDraft} className="mt-1" />
                {descError && (
                  <p role="alert" className="mt-1 text-[10px] text-danger">
                    {descError}
                  </p>
                )}
                <div className="mt-1 flex items-center justify-end gap-2">
                  {descUploading && (
                    <span role="status" className="text-[10px] text-secondary">
                      Uploading image...
                    </span>
                  )}
                  <CharLimitHint value={descDraft} max={SUBTASK_DESCRIPTION_MAX} className="mr-auto" />
                  <button
                    onClick={() => void saveDescription()}
                    onMouseDown={(e) => e.preventDefault()}
                    onPointerDown={(e) => e.preventDefault()}
                    disabled={descUploading}
                    className="btn btn-primary px-3 py-1 text-xs disabled:opacity-60"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : sub.description ? (
              <div className="ml-1 border-l-2 border-border/60 pl-2 text-xs text-secondary">
                <Markdown compact>{sub.description}</Markdown>
              </div>
            ) : null}
          </div>
        )}
      <div className="pointer-coarse:opacity-100 flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={() => void onDelete(sub)}
          className="rounded p-1 text-muted transition-colors hover:text-danger"
          aria-label={`Delete ${sub.title}`}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export function TaskChecklist({ subtasks, taskId }: TaskChecklistProps) {
  const [items, setItems] = useState<Task[]>(() => sortSubtasks(subtasks));
  const [newTitle, setNewTitle] = useState("");
  const [newError, setNewError] = useState<string | null>(null);
  const [newUploading, setNewUploading] = useState(false);
  const newTitleRef = useRef<HTMLInputElement | null>(null);
  // Completed subtasks are hidden by default so the list stays focused on what
  // is left; the header toggle reveals them again.
  const [showCompleted, setShowCompleted] = useState(false);
  const { updateTask, fetchTasks } = useTasks();
  const subtasksSignature = subtasks.map((s) => `${s.id}:${s.status}:${s.title}:${s.description ?? ""}`).join("|");
  const syncedSignatureRef = useRef(subtasksSignature);

  useEffect(() => {
    if (syncedSignatureRef.current === subtasksSignature) return;
    syncedSignatureRef.current = subtasksSignature;
    setItems(sortSubtasks(subtasks));
  }, [subtasks, subtasksSignature]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleToggle = async (sub: Task) => {
    const newStatus = sub.status === "done" ? "todo" : "done";
    await updateTask(sub.id, { status: newStatus });
    setItems((prev) =>
      sortSubtasks(prev.map((s) => (s.id === sub.id ? { ...s, status: newStatus } : s)))
    );
  };

  const handleNewImage = async (source: ImageInsertSource | null) => {
    const input = newTitleRef.current;
    if (!input || !source) return;
    setNewError(null);
    setNewUploading(true);
    try {
      await insertImageAtCursor(input, source, setNewTitle);
    } catch (err) {
      setNewError(err instanceof Error ? err.message : "Could not upload that image.");
    } finally {
      setNewUploading(false);
    }
  };

  const handleAdd = async () => {
    if (newUploading) return;
    if (!newTitle.trim()) return;
    if (newTitle.trim().length > SUBTASK_TITLE_MAX) return;
    setNewError(null);
    try {
      const data = await api.post<{ id: string; title: string; status: string }>(`/tasks/${taskId}/subtasks`, {
        title: newTitle.trim(),
      });
      setItems((prev) =>
        sortSubtasks([
          ...prev,
          { ...data, status: data.status as Task["status"] } as Task,
        ])
      );
      setNewTitle("");
    } catch (err) {
      setNewError(err instanceof Error ? err.message : "Could not add that subtask.");
    }
  };

  const handleDelete = async (sub: Task) => {
    await api.delete(`/tasks/${taskId}/subtasks/${sub.id}`);
    setItems((prev) => prev.filter((s) => s.id !== sub.id));
  };

  const handleRename = async (sub: Task, title: string) => {
    await updateTask(sub.id, { title });
    setItems((prev) => prev.map((s) => (s.id === sub.id ? { ...s, title } : s)));
  };

  const handleUpdateDescription = async (sub: Task, description: string) => {
    const next = description || null;
    await updateTask(sub.id, { description: next });
    setItems((prev) => prev.map((s) => (s.id === sub.id ? { ...s, description: next } : s)));
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((s) => s.id === active.id);
    const newIndex = items.findIndex((s) => s.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const next = sortSubtasks(arrayMove(items, oldIndex, newIndex));
    setItems(next);
    await api.post(`/tasks/${taskId}/subtasks/reorder`, { ordered_ids: next.map((s) => s.id) });
    fetchTasks();
  };

  const completedCount = items.filter((s) => s.status === "done").length;
  const visibleItems = showCompleted ? items : items.filter((s) => s.status !== "done");

  return (
    <div className="flex flex-col gap-1">
      <div className="mb-1 flex items-center gap-2">
        <h4 className="text-xs font-semibold text-muted">Subtasks</h4>
        <span className="rounded-full bg-elevated px-2 py-0.5 text-[10px] font-medium text-secondary">
          {items.length}
        </span>
        {completedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowCompleted((v) => !v)}
            aria-expanded={showCompleted}
            className="ml-auto flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium text-muted transition-colors hover:bg-hover hover:text-primary"
          >
            {showCompleted ? "Hide completed" : `Show completed (${completedCount})`}
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={showCompleted ? "rotate-180 transition-transform" : "transition-transform"}
              aria-hidden="true"
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
        )}
      </div>
      {items.length === 0 && <p className="mb-1 text-xs text-muted">No subtasks</p>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={visibleItems.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          {visibleItems.length > 0 && (
            <div className="flex flex-col gap-1 rounded-xl border border-border/60 bg-elevated/30 p-1.5">
              {visibleItems.map((sub) => (
                <SortableRow
                  key={sub.id}
                  sub={sub}
                  onToggle={handleToggle}
                  onDelete={handleDelete}
                  onRename={handleRename}
                  onUpdateDescription={handleUpdateDescription}
                />
              ))}
            </div>
          )}
        </SortableContext>
      </DndContext>
      <div className="mt-2">
        <div className="flex gap-2">
          <input
            ref={newTitleRef}
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onPaste={(e) => {
              const source = imageSourceFrom(e.clipboardData);
              if (!source) return;
              e.preventDefault();
              void handleNewImage(source);
            }}
            onDragOver={(e) => {
              if (imageSourceFrom(e.dataTransfer)) e.preventDefault();
            }}
            onDrop={(e) => {
              const source = imageSourceFrom(e.dataTransfer);
              if (!source) return;
              e.preventDefault();
              void handleNewImage(source);
            }}
            placeholder="Add subtask..."
            className="input-field flex-1 text-xs"
            onKeyDown={(e) => e.key === "Enter" && void handleAdd()}
          />
          <button
            onClick={() => void handleAdd()}
            disabled={newUploading}
            className="btn btn-gradient px-2.5 py-1 text-xs rounded-lg disabled:opacity-60"
          >
            +
          </button>
        </div>
        {newUploading && (
          <span role="status" className="mt-1 block text-[10px] text-secondary">
            Uploading image...
          </span>
        )}
        {newError && (
          <p role="alert" className="mt-1 text-[10px] text-danger">
            {newError}
          </p>
        )}
        <MarkdownImagePreview text={newTitle} className="mt-1" />
        <CharLimitHint value={newTitle} max={SUBTASK_TITLE_MAX} className="mt-1" />
      </div>
    </div>
  );
}
