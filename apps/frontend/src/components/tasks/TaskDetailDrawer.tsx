"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { PopoverMenu } from "@/components/ui/PopoverMenu";
import type { Task } from "@/types/task";
import { useTasks } from "@/hooks/useTasks";
import { useAppStore } from "@/stores/app-store";
import { useStickyBoard } from "@/components/sticky/StickyNoteBoard";
import { TaskForm } from "./TaskForm";
import { TaskChecklist } from "./TaskChecklist";
import { TaskLinks } from "./TaskLinks";
import { Markdown } from "@/components/ai/Markdown";
import { api } from "@/lib/api";
import {
  TIER_COLORS,
  TIER_LABELS,
  TIER_VALUES,
  normalizePriority,
  type PriorityTier,
} from "@/lib/priority";

function isBroadTask(title: string): boolean {
  const broadKeywords = [
    "start", "build", "create", "launch", "plan", "business", "project",
    "company", "website", "app", "trip", "travel", "vacation", "event",
    "campaign", "research", "study", "course", "move", "renovate",
  ];
  const lower = title.toLowerCase();
  return broadKeywords.some((kw) => lower.includes(kw));
}

const STATUS_COLORS: Record<string, string> = {
  backlog: "var(--text-muted)",
  todo: "var(--accent)",
  in_progress: "var(--warning)",
  done: "var(--success)",
  cancelled: "var(--danger)",
};

const STATUS_OPTIONS = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

function formatDateRange(task: Task): string | null {
  if (!task.start_date && !task.due_date) return null;
  const fmt = (d: string) =>
    new Date(d + "T00:00:00").toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  if (task.start_date && task.due_date && task.start_date !== task.due_date) {
    return `${fmt(task.start_date)} – ${fmt(task.due_date)}`;
  }
  const d = task.start_date || task.due_date!;
  return fmt(d);
}

interface TaskDetailDrawerProps {
  task: Task;
  onClose: () => void;
}

export function TaskDetailDrawer({ task, onClose }: TaskDetailDrawerProps) {
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descDraft, setDescDraft] = useState(task.description || "");
  const [busy, setBusy] = useState(false);
  const [subtasks, setSubtasks] = useState<Task[]>(task.subtasks || []);
  const [loadedSubtasks, setLoadedSubtasks] = useState(false);
  const titleOptionsRef = useRef<HTMLButtonElement | null>(null);
  const footerMoreRef = useRef<HTMLButtonElement | null>(null);
  const priorityRef = useRef<HTMLButtonElement | null>(null);
  const statusRef = useRef<HTMLButtonElement | null>(null);
  const [optionsTrigger, setOptionsTrigger] = useState<HTMLButtonElement | null>(null);
  const { updateTask, deleteTask, fetchTasks } = useTasks();
  const { addNoteWithContent } = useStickyBoard();

  const projects = useAppStore.getState().projects;
  const project = task.project_id
    ? projects.find((p) => p.id === task.project_id) || null
    : null;
  const isNote = !task.start_date && !task.due_date;
  const tier: PriorityTier = normalizePriority(task.priority);
  const dateRange = formatDateRange(task);

  const hasSubtasks = subtasks.length > 0;
  const [mode, setMode] = useState<"description" | "subtasks">(
    hasSubtasks ? "subtasks" : "description"
  );

  // The timeline task list does not embed nested subtasks; fetch them so the
  // drawer can show the checklist and auto-select the subtask mode accurately.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await api.get<Task[]>(`/tasks/${task.id}/subtasks`);
        if (alive) {
          setSubtasks(data);
          setLoadedSubtasks(true);
        }
      } catch {
        if (alive) {
          setSubtasks(task.subtasks || []);
          setLoadedSubtasks(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  // If the fetched subtasks reveal the task has children, switch to the
  // checklist view so they are immediately visible.
  useEffect(() => {
    if (loadedSubtasks && subtasks.length > 0 && mode === "description") {
      setMode("subtasks");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedSubtasks, subtasks.length]);

  const closeMenus = () => {
    setOptionsOpen(false);
    setStatusOpen(false);
  };


  const handleRename = async () => {
    setRenaming(false);
    if (draftTitle.trim() && draftTitle.trim() !== task.title) {
      await updateTask(task.id, { title: draftTitle.trim() });
    }
  };

  const handleDelete = async () => {
    await deleteTask(task.id);
    onClose();
  };

  const handleStatusChange = async (status: string) => {
    setStatusOpen(false);
    await updateTask(task.id, { status });
  };

  const toggleStatus = async () => {
    const newStatus = task.status === "done" ? "todo" : "done";
    await updateTask(task.id, { status: newStatus });
  };

  const handlePriorityChange = async (value: PriorityTier) => {
    setPriorityOpen(false);
    if (value !== tier) {
      await updateTask(task.id, { priority: value });
    }
  };

  const handleDescriptionSave = async () => {
    setEditingDescription(false);
    await updateTask(task.id, { description: descDraft || null });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleConvertToSubtasks = async () => {
    setBusy(true);
    try {
      await api.post(`/tasks/${task.id}/description-to-subtasks`);
      const data = await api.get<Task[]>(`/tasks/${task.id}/subtasks`);
      setSubtasks(data);
      setLoadedSubtasks(true);
      await fetchTasks();
      setMode("subtasks");
    } finally {
      setBusy(false);
      setOptionsOpen(false);
    }
  };

  const handleConvertToDescription = async () => {
    setBusy(true);
    try {
      await api.post(`/tasks/${task.id}/subtasks-to-description`);
      setSubtasks([]);
      await fetchTasks();
      setMode("description");
    } finally {
      setBusy(false);
      setOptionsOpen(false);
    }
  };

  const handleBreakDown = () => {
    setOptionsOpen(false);
    const event = new CustomEvent("prysm-ai-suggest", {
      detail: { taskId: task.id, title: task.title },
    });
    window.dispatchEvent(event);
  };

  const handleUpdate = async (data: {
    title: string;
    description?: string;
    start_date?: string;
    due_date?: string;
    status?: string;
    priority?: number;
    project_id?: string | null;
  }) => {
    const fields: Record<string, unknown> = {};
    if (data.title !== task.title) fields.title = data.title;
    if (data.description !== (task.description || "")) fields.description = data.description;
    if (data.status && data.status !== task.status) fields.status = data.status;
    if (data.priority && data.priority !== normalizePriority(task.priority))
      fields.priority = data.priority;
    if (data.start_date !== (task.start_date || "")) fields.start_date = data.start_date;
    if (data.due_date !== (task.due_date || "")) fields.due_date = data.due_date;
    if (data.project_id !== (task.project_id || "")) fields.project_id = data.project_id;
    if (Object.keys(fields).length > 0) {
      await updateTask(task.id, fields);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <DrawerShell onClose={onClose} title="Edit Task">
        <TaskForm
          onSubmit={handleUpdate}
          onCancel={() => setEditing(false)}
          initial={task}
        />
      </DrawerShell>
    );
  }

  return (
    <DrawerShell onClose={onClose}>
      {/* Header: project icon + date range pill, priority flag */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-secondary">
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded"
            style={{ backgroundColor: (project?.color || "#555") + "33" }}
          >
            {project ? (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <line x1="9" y1="3" x2="9" y2="21" />
                <line x1="15" y1="3" x2="15" y2="21" />
              </svg>
            ) : (
              <span className="text-muted">📥</span>
            )}
          </span>
          <span className="truncate font-medium text-secondary">
            {isNote ? "Note" : (project?.name || "No Project")}
          </span>
          {dateRange && (
            <span className="shrink-0 rounded-full bg-elevated px-2 py-0.5 text-[10px] text-muted">
              {dateRange}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {isNote && <span className="badge bg-elevated text-muted">Note</span>}
          <div className="relative">
            <button
              ref={priorityRef}
              onClick={() => {
                setOptionsOpen(false);
                setPriorityOpen((v) => !v);
              }}
              className="flex h-5 w-5 items-center justify-center rounded-full border border-border/40 p-1 transition-transform hover:scale-110"
              title={`Priority: ${TIER_LABELS[tier]} (click to change)`}
              aria-label="Change priority"
            >
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: TIER_COLORS[tier] }} />
            </button>
            <PopoverMenu
              open={priorityOpen}
              triggerRef={priorityRef}
              align="right"
              onClose={() => setPriorityOpen(false)}
              className="w-40"
            >
              {TIER_VALUES.map((p) => (
                <MenuItem key={p} onClick={() => handlePriorityChange(p)}>
                  <span className="inline-flex items-center gap-2 whitespace-nowrap">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: TIER_COLORS[p] }} />
                    {TIER_LABELS[p]}
                  </span>
                </MenuItem>
              ))}
            </PopoverMenu>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-hover hover:text-primary"
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>

      {/* Title */}
      <div className="mt-3 flex items-start gap-2">
        <button
          onClick={toggleStatus}
          className="mt-1.5 flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded-full border-2 transition-colors"
          style={{
            borderColor: task.status === "done" ? "var(--accent)" : "#5a5a72",
            backgroundColor: task.status === "done" ? "var(--accent)" : "transparent",
          }}
          aria-label="Complete task"
        >
          {task.status === "done" && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </button>
        {renaming ? (
          <input
            autoFocus
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={handleRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
            }}
            className="input-field w-full bg-transparent text-lg font-semibold text-primary"
          />
        ) : (
          <h2
            onDoubleClick={() => {
              setDraftTitle(task.title);
              setRenaming(true);
            }}
            title="Double-click to rename"
            className={task.status === "done" ? "text-lg font-semibold leading-snug text-muted line-through" : "text-lg font-semibold leading-snug text-primary"}
          >
            {task.title}
          </h2>
        )}
        <div className="relative shrink-0">
          <button
            ref={titleOptionsRef}
            onClick={() => {
              setOptionsTrigger(titleOptionsRef.current);
              setOptionsOpen((v) => !v);
            }}
            className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-hover hover:text-primary"
            aria-label="Options"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="5" cy="12" r="1" />
              <circle cx="12" cy="12" r="1" />
              <circle cx="19" cy="12" r="1" />
            </svg>
          </button>
          <PopoverMenu
            open={optionsOpen && optionsTrigger === titleOptionsRef.current}
            triggerRef={titleOptionsRef}
            align="right"
            onClose={() => setOptionsOpen(false)}
            className="w-64"
          >
            <OptionsMenuContent
              busy={busy}
              hasSubtasks={hasSubtasks}
              onConvertToSubtasks={handleConvertToSubtasks}
              onConvertToDescription={handleConvertToDescription}
              onBreakDown={handleBreakDown}
              onSticky={() => addNoteWithContent(task.title, task.description || "")}
              onEdit={() => {
                setOptionsOpen(false);
                setEditing(true);
              }}
              onDelete={handleDelete}
            />
          </PopoverMenu>
        </div>
      </div>

      {/* Content: description or subtasks */}
      <div className="mt-4 flex-1 overflow-y-auto">
        {mode === "description" ? (
          <div>
            <Label>Description</Label>
            {editingDescription ? (
              <textarea
                autoFocus
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                onBlur={handleDescriptionSave}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleDescriptionSave();
                  if (e.key === "Escape") {
                    setEditingDescription(false);
                  }
                }}
                placeholder="Write a description (markdown supported)…"
                rows={6}
                className="input-field w-full bg-transparent text-sm"
              />
            ) : task.description ? (
              <div
                onDoubleClick={() => {
                  setDescDraft(task.description || "");
                  setEditingDescription(true);
                }}
                title="Double-click to edit"
              >
                <Markdown>{task.description}</Markdown>
              </div>
            ) : (
              <button
                onClick={() => {
                  setDescDraft(task.description || "");
                  setEditingDescription(true);
                }}
                className="w-full rounded-lg border border-dashed border-border/60 px-3 py-4 text-left text-sm text-muted transition-colors hover:border-accent/40 hover:text-secondary"
              >
                No description — click to add one
              </button>
            )}
          </div>
        ) : (
          <div>
            <Label>Subtasks</Label>
            <TaskChecklist subtasks={subtasks} taskId={task.id} />
          </div>
        )}
      </div>

      {/* Meta: tags, links, break-down */}
      {task.tags && task.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {task.tags.map((tag) => (
            <span
              key={tag.id}
              className="badge"
              style={{
                backgroundColor: (tag.color || "#333") + "30",
                color: tag.color || "var(--text-secondary)",
              }}
            >
              {tag.name}
            </span>
          ))}
        </div>
      )}

      {(task.links?.length ?? 0) > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <TaskLinks links={task.links || []} taskId={task.id} />
        </div>
      )}

      {isBroadTask(task.title) && (
        <button
          onClick={handleBreakDown}
          className="btn mt-4 w-full gap-2 border border-accent/20 bg-accent/10 px-3 py-2 text-xs text-accent transition-all hover:border-accent/40 hover:bg-accent/20"
        >
          <span>🧠</span>
          <span>Break this down into subtasks</span>
        </button>
      )}

      {/* Footer */}
      <div className="mt-4 border-t border-border/60 pt-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <button
              ref={statusRef}
              onClick={() => setStatusOpen((v) => !v)}
              className="badge"
              style={{
                backgroundColor: (STATUS_COLORS[task.status] || "var(--text-muted)") + "20",
                color: STATUS_COLORS[task.status] || "var(--text-secondary)",
              }}
            >
              {task.status.replace("_", " ")}
              <svg className="ml-1" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            <PopoverMenu
              open={statusOpen}
              triggerRef={statusRef}
              align="left"
              preferred="above"
              onClose={() => setStatusOpen(false)}
              className="w-40"
            >
              {STATUS_OPTIONS.map((opt) => (
                <MenuItem key={opt.value} onClick={() => handleStatusChange(opt.value)}>
                  {opt.label}
                </MenuItem>
              ))}
            </PopoverMenu>
          </div>
          <div className="flex items-center gap-1">
            <span
              className="rounded-lg p-1.5 text-muted"
              title="Markdown formatting supported in description / AI chat"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7V4h16v3" />
                <path d="M9 20h6" />
                <path d="M12 4v16" />
              </svg>
            </span>
            <button
              onClick={onClose}
              title="Comments (coming soon)"
              className="rounded-lg p-1.5 text-muted"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            <button
              ref={footerMoreRef}
              onClick={() => {
                setOptionsTrigger(footerMoreRef.current);
                setOptionsOpen((v) => !v);
              }}
              className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-hover hover:text-primary"
              aria-label="More options"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="5" cy="12" r="1" />
                <circle cx="12" cy="12" r="1" />
                <circle cx="19" cy="12" r="1" />
              </svg>
            </button>
            <PopoverMenu
              open={optionsOpen && optionsTrigger === footerMoreRef.current}
              triggerRef={footerMoreRef}
              align="right"
              preferred="above"
              onClose={() => setOptionsOpen(false)}
              className="w-64"
            >
              <OptionsMenuContent
                busy={busy}
                hasSubtasks={hasSubtasks}
                onConvertToSubtasks={handleConvertToSubtasks}
                onConvertToDescription={handleConvertToDescription}
                onBreakDown={handleBreakDown}
                onSticky={() => addNoteWithContent(task.title, task.description || "")}
                onEdit={() => {
                  setOptionsOpen(false);
                  setEditing(true);
                }}
                onDelete={handleDelete}
              />
            </PopoverMenu>
          </div>
        </div>
      </div>
    </DrawerShell>
  );
}

interface DrawerShellProps {
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}

function DrawerShell({ onClose, title, children }: DrawerShellProps) {
  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="h-full flex-1 bg-black/40 backdrop-blur-[2px]"
        aria-hidden
        onClick={onClose}
      />
      <div className="slide-in-right flex h-full w-[400px] max-w-[92vw] flex-col border-l border-border bg-[#14141c] shadow-2xl">
        {title ? (
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h3 className="text-sm font-semibold text-primary">{title}</h3>
            <button onClick={onClose} className="rounded-lg p-1.5 text-secondary hover:bg-hover hover:text-primary">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        ) : null}
        <div className="flex flex-1 flex-col overflow-y-auto px-4 py-3">{children}</div>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
      {children}
    </h4>
  );
}

interface OptionsMenuContentProps {
  busy: boolean;
  hasSubtasks: boolean;
  onConvertToSubtasks: () => void;
  onConvertToDescription: () => void;
  onBreakDown: () => void;
  onSticky: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function OptionsMenuContent({
  busy,
  hasSubtasks,
  onConvertToSubtasks,
  onConvertToDescription,
  onBreakDown,
  onSticky,
  onEdit,
  onDelete,
}: OptionsMenuContentProps) {
  return (
    <>
      <MenuItem onClick={onConvertToSubtasks} disabled={busy}>
        Convert description to subtasks
      </MenuItem>
      <MenuItem onClick={onConvertToDescription} disabled={busy || !hasSubtasks}>
        Convert subtasks to text
      </MenuItem>
      <MenuItem onClick={onBreakDown}>Break down into subtasks (AI)</MenuItem>
      <MenuItem onClick={onSticky}>Add as sticky note</MenuItem>
      <div className="my-1 h-px bg-border/60" />
      <MenuItem onClick={onEdit}>Edit task</MenuItem>
      <MenuItem onClick={onDelete} danger>
        Delete task
      </MenuItem>
    </>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={() => !disabled && onClick()}
      disabled={disabled}
      className={`block w-full px-4 py-2 text-left text-xs transition-colors ${
        danger ? "text-danger hover:bg-hover" : "text-secondary hover:bg-hover hover:text-primary"
      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
    >
      <span className="block min-w-0 truncate whitespace-nowrap">{children}</span>
    </button>
  );
}
