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
import { SUBTASK_TITLE_MAX } from "@/lib/char-limits";
import { CharLimitHint } from "@/components/ui/CharLimitHint";

interface TaskChecklistProps {
  subtasks: Task[];
  taskId: string;
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
}

function SortableRow({ sub, onToggle, onDelete, onRename }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sub.id,
  });
  const [editing, setEditing] = useState(false);
  const [withToolbar, setWithToolbar] = useState(false);
  const [draft, setDraft] = useState(sub.title);
  const [expanded, setExpanded] = useState(false);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
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
    // Save before closing so the row cannot flash the stale title while the
    // PATCH is in flight (same reason as the task description editor).
    const next = draft.trim();
    if (next.length > SUBTASK_TITLE_MAX) {
      // Keep the editor open so the over-limit counter stays visible.
      return;
    }
    if (next && next !== sub.title) await onRename(sub, next);
    setEditing(false);
    setWithToolbar(false);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group flex items-center gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-hover/60"
      onDoubleClick={() => startEditing(false)}
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
            <MarkdownToolbar textareaRef={draftRef} onChange={setDraft} />
            <textarea
              ref={draftRef}
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void commitEdit()}
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
            <CharLimitHint value={draft} max={SUBTASK_TITLE_MAX} className="mt-1" />
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void commitEdit()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  (e.target as HTMLInputElement).blur();
                }
                if (e.key === "Escape") setEditing(false);
              }}
              className="input-field bg-transparent text-sm px-1 py-0"
            />
            <CharLimitHint value={draft} max={SUBTASK_TITLE_MAX} className="mt-1" />
          </div>
        )
      ) : (
          <div className="flex min-w-0 flex-1 items-start gap-1">
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
              <Markdown>{sub.title}</Markdown>
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
  const [items, setItems] = useState<Task[]>(subtasks);
  const [newTitle, setNewTitle] = useState("");
  const { updateTask, fetchTasks } = useTasks();
  const subtasksSignature = subtasks.map((s) => `${s.id}:${s.status}:${s.title}`).join("|");
  const syncedSignatureRef = useRef(subtasksSignature);

  useEffect(() => {
    if (syncedSignatureRef.current === subtasksSignature) return;
    syncedSignatureRef.current = subtasksSignature;
    setItems(subtasks);
  }, [subtasks, subtasksSignature]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleToggle = async (sub: Task) => {
    const newStatus = sub.status === "done" ? "todo" : "done";
    await updateTask(sub.id, { status: newStatus });
    setItems((prev) => prev.map((s) => (s.id === sub.id ? { ...s, status: newStatus } : s)));
  };

  const handleAdd = async () => {
    if (!newTitle.trim()) return;
    if (newTitle.trim().length > SUBTASK_TITLE_MAX) return;
    const data = await api.post<{ id: string; title: string; status: string }>(`/tasks/${taskId}/subtasks`, {
      title: newTitle.trim(),
    });
    setItems((prev) => [
      ...prev,
      { ...data, status: data.status as Task["status"] } as Task,
    ]);
    setNewTitle("");
  };

  const handleDelete = async (sub: Task) => {
    await api.delete(`/tasks/${taskId}/subtasks/${sub.id}`);
    setItems((prev) => prev.filter((s) => s.id !== sub.id));
  };

  const handleRename = async (sub: Task, title: string) => {
    await updateTask(sub.id, { title });
    setItems((prev) => prev.map((s) => (s.id === sub.id ? { ...s, title } : s)));
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setItems((prev) => {
      const oldIndex = prev.findIndex((s) => s.id === active.id);
      const newIndex = prev.findIndex((s) => s.id === over.id);
      return arrayMove(prev, oldIndex, newIndex);
    });
    const orderedIds = items.map((s) => s.id);
    const oldIndex = items.findIndex((s) => s.id === active.id);
    const newIndex = items.findIndex((s) => s.id === over.id);
    const next = arrayMove(orderedIds, oldIndex, newIndex);
    await api.post(`/tasks/${taskId}/subtasks/reorder`, { ordered_ids: next });
    fetchTasks();
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="mb-1 flex items-center gap-2">
        <h4 className="text-xs font-semibold text-muted">Subtasks</h4>
        <span className="rounded-full bg-elevated px-2 py-0.5 text-[10px] font-medium text-secondary">
          {items.length}
        </span>
      </div>
      {items.length === 0 && <p className="mb-1 text-xs text-muted">No subtasks</p>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1 rounded-xl border border-border/60 bg-elevated/30 p-1.5">
            {items.map((sub) => (
              <SortableRow
                key={sub.id}
                sub={sub}
                onToggle={handleToggle}
                onDelete={handleDelete}
                onRename={handleRename}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <div className="mt-2">
        <div className="flex gap-2">
          <input
            type="text"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Add subtask..."
            className="input-field flex-1 text-xs"
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <button onClick={handleAdd} className="btn btn-gradient px-2.5 py-1 text-xs rounded-lg">+</button>
        </div>
        <CharLimitHint value={newTitle} max={SUBTASK_TITLE_MAX} className="mt-1" />
      </div>
    </div>
  );
}
