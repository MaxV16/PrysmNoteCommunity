"use client";

import { useState } from "react";
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
      className={`flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded-full border-2 transition-colors ${
        checked ? "border-accent bg-accent" : "border-[#5a5a72] hover:border-accent"
      }`}
    >
      {checked && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      {pending && <span className="h-1.5 w-1.5 rounded-full bg-white/70 animate-ping" />}
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
  const [draft, setDraft] = useState(sub.title);
  const done = sub.status === "done";

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-hover/60"
      onDoubleClick={() => {
        setEditing(true);
        setDraft(sub.title);
      }}
    >
      <button
        {...listeners}
        {...attributes}
        className="cursor-grab touch-none text-[#4a4a60] opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        title="Drag to reorder"
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
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft.trim() && draft.trim() !== sub.title) void onRename(sub, draft.trim());
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === "Escape") setEditing(false);
          }}
          className="input-field flex-1 bg-transparent text-sm px-1 py-0"
        />
      ) : (
        <span
          className={`flex-1 min-w-0 break-words text-sm ${done ? "line-through text-muted" : "text-primary"}`}
        >
          {sub.title}
        </span>
      )}
      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={() => void onDelete(sub)}
          className="rounded p-1 text-[#4a4a60] transition-colors hover:text-danger"
          title="Delete subtask"
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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleToggle = async (sub: Task) => {
    const newStatus = sub.status === "done" ? "todo" : "done";
    await updateTask(sub.id, { status: newStatus });
    setItems((prev) => prev.map((s) => (s.id === sub.id ? { ...s, status: newStatus } : s)));
  };

  const handleAdd = async () => {
    if (!newTitle.trim()) return;
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
      <h4 className="mb-1 text-xs font-semibold text-muted">
        Subtasks ({items.length})
      </h4>
      {items.length === 0 && <p className="mb-1 text-xs text-muted">No subtasks</p>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-0.5 divide-y divide-border/40">
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
      <div className="mt-2 flex gap-2">
        <input
          type="text"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Add subtask..."
          className="input-field flex-1 text-xs"
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <button onClick={handleAdd} className="btn bg-accent px-2.5 py-1 text-xs text-base hover:bg-accent-hover">
          +
        </button>
      </div>
    </div>
  );
}
