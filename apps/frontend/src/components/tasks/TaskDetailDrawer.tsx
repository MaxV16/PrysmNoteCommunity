"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PopoverMenu } from "@/components/ui/PopoverMenu";
import type { Task, TaskTag } from "@/types/task";
import { useTasks } from "@/hooks/useTasks";
import { useAppStore } from "@/stores/app-store";
import { useToast } from "@/lib/toast-context";
import { registerBackHandler } from "@/lib/back-nav";
import { useStickyBoard } from "@/components/sticky/StickyNoteBoard";
import { TaskForm } from "./TaskForm";
import { TaskChecklist } from "./TaskChecklist";
import { TaskLinks } from "./TaskLinks";
import { TaskTagsEditor } from "./TaskTagsEditor";
import { DateRecurrencePopover } from "./DateRecurrencePopover";
import { MarkdownToolbar } from "@/components/ui/MarkdownToolbar";
import { Markdown } from "@/components/ai/Markdown";
import dynamic from "next/dynamic";
import { api } from "@/lib/api";
import { useLocalBool } from "@/lib/use-local-bool";
import { formatDate } from "@/lib/dates";
import { taskTimeLabel } from "@/lib/task-time";
import { TASK_TITLE_MAX, TASK_DESCRIPTION_MAX } from "@/lib/char-limits";
import { CharLimitHint } from "@/components/ui/CharLimitHint";

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
  const fmt = (d: string) => formatDate(new Date(d + "T00:00:00"), { includeYear: false });
  let range: string;
  if (task.start_date && task.due_date && task.start_date !== task.due_date) {
    range = `${fmt(task.start_date)} – ${fmt(task.due_date)}`;
  } else {
    const d = task.start_date || task.due_date!;
    range = fmt(d);
  }
  const time = taskTimeLabel(task);
  return time ? `${range} · ${time}` : range;
}

interface TaskDetailDrawerProps {
  task: Task;
  onClose: () => void;
}

export function TaskDetailDrawer({ task, onClose }: TaskDetailDrawerProps) {
  const soundOn = useLocalBool("prysm_notif_sound", true);
  const rewardsOn = useLocalBool("prysm_rewards", true);
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [teamList, setTeamList] = useState<{ id: string; name: string }[]>([]);
  const [sharedTeamIds, setSharedTeamIds] = useState<Set<string>>(new Set());

  const loadShareData = async () => {
    try {
      const [teamsRes, sharesRes] = await Promise.all([
        api.get<{ teams: { id: string; name: string }[] }>("/teams/"),
        api.get<{ team_ids: string[] }>(`/tasks/${task.id}/shares`),
      ]);
      setTeamList(teamsRes.teams);
      setSharedTeamIds(new Set(sharesRes.team_ids));
    } catch {}
  };

  const toggleShare = async (teamId: string) => {
    const isShared = sharedTeamIds.has(teamId);
    try {
      if (isShared) {
        await api.delete(`/teams/${teamId}/share-task/${task.id}`);
        setSharedTeamIds((prev) => {
          const next = new Set(prev);
          next.delete(teamId);
          return next;
        });
      } else {
        await api.post(`/teams/${teamId}/share-task`, { task_id: task.id });
        setSharedTeamIds((prev) => new Set(prev).add(teamId));
      }
    } catch {}
  };
  const [editingDescription, setEditingDescription] = useState(false);
  const [descDraft, setDescDraft] = useState(task.description || "");
  const [busy, setBusy] = useState(false);
  const [subtasks, setSubtasks] = useState<Task[]>(task.subtasks || []);
  const [tags, setTags] = useState<TaskTag[]>(task.tags || []);
  const [dateOpen, setDateOpen] = useState(false);
  const datePillRef = useRef<HTMLButtonElement | null>(null);
  const titleOptionsRef = useRef<HTMLButtonElement | null>(null);
  const footerMoreRef = useRef<HTMLButtonElement | null>(null);
  const priorityRef = useRef<HTMLButtonElement | null>(null);
  const statusRef = useRef<HTMLButtonElement | null>(null);
  const descSectionRef = useRef<HTMLDivElement | null>(null);
  const descTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [optionsTrigger, setOptionsTrigger] = useState<HTMLButtonElement | null>(null);
  const { updateTask, deleteTask, restoreTask, fetchTasks } = useTasks();
  const { showToast } = useToast();
  const { addNoteWithContent } = useStickyBoard();

  const isNote = !task.start_date && !task.due_date;
  const tier: PriorityTier = normalizePriority(task.priority);
  const dateRange = formatDateRange(task);

  const hasSubtasks = subtasks.length > 0;

  // Description and subtasks share ONE page now, so the checklist is fetched as
  // soon as the drawer opens. Re-fetching on `task.updated_at` (and the store
  // sync below) is what makes a remote change show up without a hard reload.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await api.get<Task[]>(`/tasks/${task.id}/subtasks`);
        if (alive) setSubtasks(data);
      } catch {
        if (alive) setSubtasks((prev) => (prev.length ? prev : task.subtasks || []));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.updated_at]);

  // Keep the checklist in step with the shared store: the list payload carries
  // every subtask row (flat, with parent_task_id), so a refresh that changes a
  // child lands here without reopening the drawer.
  const storeTasks = useAppStore((s) => s.tasks);
  useEffect(() => {
    const children = storeTasks
      .filter((t) => t.parent_task_id === task.id)
      .sort((a, b) => {
        const ad = a.status === "done" ? 1 : 0;
        const bd = b.status === "done" ? 1 : 0;
        if (ad !== bd) return ad - bd;
        return (a.sort_order ?? 0) - (b.sort_order ?? 0);
      });
    setSubtasks((prev) => {
      if (children.length === 0 && prev.length > 0) return prev;
      const same =
        children.length === prev.length &&
        children.every(
          (c, i) =>
            c.id === prev[i].id &&
            c.updated_at === prev[i].updated_at &&
            c.status === prev[i].status &&
            c.title === prev[i].title
        );
      return same ? prev : children;
    });
  }, [storeTasks, task.id]);

  const closeMenus = () => {
    setOptionsOpen(false);
    setStatusOpen(false);
  };


  const handleRename = async () => {
    setRenaming(false);
    const nextTitle = draftTitle.trim();
    if (!nextTitle || nextTitle === task.title) return;
    if (nextTitle.length > TASK_TITLE_MAX) {
      showToast(`Title is ${(nextTitle.length - TASK_TITLE_MAX).toLocaleString()} characters over the limit`, "error");
      return;
    }
    await updateTask(task.id, { title: nextTitle });
  };

  const handleDelete = async () => {
    await deleteTask(task.id);
    onClose();
    // Soft delete + Undo, same as the context menu: the task sits in the Trash
    // and can be brought back without leaving the drawer.
    showToast("Task moved to Trash", "info", {
      label: "Undo",
      onClick: () => {
        void restoreTask(task.id).catch(() => {
          showToast("Could not restore task", "error");
        });
      },
    });
  };

  const handleStatusChange = async (status: string) => {
    setStatusOpen(false);
    await updateTask(task.id, { status });
  };

  const toggleStatus = async () => {
    const newStatus = task.status === "done" ? "todo" : "done";
    if (newStatus === "done") {
      if (soundOn) {
        const { playCompletionSound } = await import("@/lib/sounds");
        playCompletionSound();
      }
      if (rewardsOn) {
        const { celebrate } = await import("@/lib/celebrate");
        celebrate();
      }
    }
    await updateTask(task.id, { status: newStatus });
  };

  const handlePriorityChange = async (value: PriorityTier) => {
    setPriorityOpen(false);
    if (value !== tier) {
      await updateTask(task.id, { priority: value });
    }
  };

  const handleDescriptionSave = async () => {
    // Save FIRST, then close the editor. Closing first re-rendered the stale
    // `task.description` while the PATCH was in flight, so the new (formatted)
    // text only appeared after leaving and reopening the drawer.
    if (descDraft.length > TASK_DESCRIPTION_MAX) {
      showToast(`Description is ${(descDraft.length - TASK_DESCRIPTION_MAX).toLocaleString()} characters over the limit`, "error");
      return;
    }
    try {
      await updateTask(task.id, { description: descDraft || null });
      setEditingDescription(false);
    } catch {
      // Keep the editor open so a failed save never loses the draft.
    }
  };

  const startDescriptionEdit = () => {
    setDescDraft(task.description || "");
    setEditingDescription(true);
  };

  // Escape / blur-cancel restores the saved text so a stray key cannot wipe it.
  const cancelDescriptionEdit = () => {
    setDescDraft(task.description || "");
    setEditingDescription(false);
  };

  // Footer "T": jump straight into the description editor with the toolbar.
  const openDescriptionEditor = () => {
    startDescriptionEdit();
    requestAnimationFrame(() => {
      descSectionRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Android/hardware back closes the task drawer instead of leaving the app.
  useEffect(() => {
    return registerBackHandler(onClose, 100);
  }, [onClose]);

  const handleConvertToSubtasks = async () => {
    setBusy(true);
    try {
      await api.post(`/tasks/${task.id}/description-to-subtasks`);
      const data = await api.get<Task[]>(`/tasks/${task.id}/subtasks`);
      setSubtasks(data);
      await fetchTasks();
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

  const handleBreakDownNow = async () => {
    setBusy(true);
    setOptionsOpen(false);
    try {
      // Create the subtasks deterministically via the backend breakdown endpoint
      // regardless of whether an AI key is configured.
      await api.post(`/tasks/${task.id}/breakdown`, {});
      await fetchTasks();
      const data = await api.get<Task[]>(`/tasks/${task.id}/subtasks`);
      setSubtasks(data);
      // Auto-open the AI panel for follow-up guidance.
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("prysm-open-ai"));
        window.dispatchEvent(
          new CustomEvent("prysm-ai-suggest", {
            detail: { taskId: task.id, title: task.title },
          })
        );
      }
    } finally {
      setBusy(false);
    }
  };

const handleUpdate = async (data: {
    title: string;
    description?: string;
    start_date?: string;
    due_date?: string;
    start_time?: string;
    end_time?: string;
    status?: string;
    priority?: number;
    tag_ids?: string[];
    recurrence_rule?: string;
    recurrence_end_date?: string;
    reminder_enabled?: boolean;
    list_id?: string | null;
    estimated_minutes?: number | null;
    board_section_id?: string | null;
  }) => {
    const fields: Record<string, unknown> = {};
    if (data.title !== task.title) fields.title = data.title;
    if (data.status && data.status !== task.status) fields.status = data.status;
    if (data.description !== undefined && data.description !== (task.description || "")) {
      fields.description = data.description || null;
    }
    if (data.priority && data.priority !== normalizePriority(task.priority))
      fields.priority = data.priority;
    if (data.start_date !== (task.start_date || "")) fields.start_date = data.start_date;
    if (data.due_date !== (task.due_date || "")) fields.due_date = data.due_date;
    if (data.start_time !== (task.start_time || "")) fields.start_time = data.start_time || null;
    if (data.end_time !== (task.end_time || "")) fields.end_time = data.end_time || null;
    if (data.tag_ids !== undefined) fields.tag_ids = data.tag_ids;
    if (data.recurrence_rule !== (task.recurrence_rule || ""))
      fields.recurrence_rule = data.recurrence_rule ?? null;
    if (data.recurrence_end_date !== (task.recurrence_end_date || ""))
      fields.recurrence_end_date = data.recurrence_end_date ?? null;
    if (data.reminder_enabled !== undefined && data.reminder_enabled !== !!task.reminder_enabled)
      fields.reminder_enabled = data.reminder_enabled;
    if (data.list_id !== undefined && (data.list_id || "") !== (task.list_id || ""))
      fields.list_id = data.list_id || null;
    if (data.estimated_minutes !== undefined && data.estimated_minutes !== (task.estimated_minutes ?? undefined))
      fields.estimated_minutes = data.estimated_minutes ?? null;
    if (data.board_section_id !== undefined && (data.board_section_id || "") !== (task.board_section_id || ""))
      fields.board_section_id = data.board_section_id || null;
    if (Object.keys(fields).length > 0) {
      await updateTask(task.id, fields);
    }
    setEditing(false);
  };

  const handleDateChange = async (
    newStartDate: string | null,
    newDueDate: string | null,
    newRule: string | null,
    newEndDate: string | null
  ) => {
    setDateOpen(false);
    const fields: Record<string, unknown> = {};
    if (newStartDate) fields.start_date = newStartDate;
    if (newDueDate) fields.due_date = newDueDate;
    else {
      fields.start_date = null;
      fields.due_date = null;
    }
    fields.recurrence_rule = newRule;
    fields.recurrence_end_date = newEndDate;
    await updateTask(task.id, fields);
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
    <DrawerShell onClose={onClose} dimmed={task.status === "done"}>
      {/* Header: type label + date range pill, priority flag */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-secondary">
          <span className="truncate font-medium text-secondary">
            {isNote ? "Note" : "Task"}
          </span>
          <button
            ref={datePillRef}
            onClick={() => setDateOpen((v) => !v)}
            className="shrink-0 rounded-full bg-elevated px-2 py-0.5 text-[10px] text-muted hover:bg-hover hover:text-primary transition-colors"
            aria-label="Set date and recurrence"
          >
            <span className="inline-flex items-center gap-1">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="4" width="18" height="18" rx="2" />
                <path d="M16 2v4M8 2v4M3 10h18" />
              </svg>
              {dateRange || "No date"}
              {task.recurrence_rule && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8" />
                  <path d="M20 4v4h-4" />
                  <path d="M20 12a8 8 0 0 1-13.7 5.6L4 16" />
                  <path d="M4 20v-4h4" />
                </svg>
              )}
            </span>
          </button>
          <DateRecurrencePopover
            open={dateOpen}
            triggerRef={datePillRef}
            onClose={() => setDateOpen(false)}
            startDate={task.start_date}
            dueDate={task.due_date}
            recurrenceRule={task.recurrence_rule}
            recurrenceEndDate={task.recurrence_end_date}
            onChange={handleDateChange}
          />
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
            borderColor: task.status === "done" ? "var(--accent)" : "var(--border)",
            backgroundColor: task.status === "done" ? "var(--accent)" : "transparent",
          }}
          aria-label="Complete task"
        >
          {task.status === "done" && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--on-gradient)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </button>
        {renaming ? (
          <div className="min-w-0 flex-1">
            <input
              autoFocus
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onBlur={handleRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(false);
              }}
              className="input-field w-full bg-transparent text-base text-scale-title font-semibold text-primary sm:text-lg"
            />
            <CharLimitHint value={draftTitle} max={TASK_TITLE_MAX} className="mt-1" />
          </div>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-1.5">
            <h2
              onDoubleClick={() => {
                setDraftTitle(task.title);
                setRenaming(true);
              }}
              className={task.status === "done" ? "min-w-0 flex-1 text-base text-scale-title font-semibold leading-snug text-muted line-through sm:text-lg" : "min-w-0 flex-1 text-base text-scale-title font-semibold leading-snug text-primary sm:text-lg"}
            >
              {task.title}
            </h2>
            <button
              onClick={() => {
                setDraftTitle(task.title);
                setRenaming(true);
              }}
              aria-label="Rename task"
              className="pointer-coarse:opacity-100 pointer-coarse:flex mt-0.5 hidden shrink-0 items-center justify-center rounded-lg p-1.5 text-muted transition-colors hover:bg-hover hover:text-primary"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
            </button>
          </div>
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

      {/* Content: description then subtasks, all on one page */}
      <div ref={descSectionRef} className="mt-4 flex-1 overflow-y-auto">
        <div className="mb-2 flex items-center justify-between gap-2">
          <Label>Description</Label>
          {!editingDescription && (
            <button
              onClick={startDescriptionEdit}
              aria-label="Edit description"
              className="pointer-coarse:h-9 pointer-coarse:w-9 flex h-7 w-7 items-center justify-center rounded-lg text-secondary transition-colors hover:bg-hover hover:text-primary"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
            </button>
          )}
        </div>
        <div>
            {editingDescription ? (
              <div className="rounded-lg border border-border/60 bg-elevated/40 p-1.5">
                <MarkdownToolbar
                  textareaRef={descTextareaRef}
                  onChange={setDescDraft}
                  className="mb-1 border-b border-border/60 pb-1"
                />
                <textarea
                  ref={descTextareaRef}
                  autoFocus
                  value={descDraft}
                  onChange={(e) => setDescDraft(e.target.value)}
                  onBlur={() => void handleDescriptionSave()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      void handleDescriptionSave();
                    }
                    if (e.key === "Escape") {
                      // Revert instead of closing the drawer.
                      e.stopPropagation();
                      cancelDescriptionEdit();
                    }
                  }}
                  placeholder="Write a description (markdown supported)…"
                  rows={6}
                  className="input-field w-full bg-transparent text-sm"
                />
                <div className="mt-1 flex items-center justify-end gap-2">
                  <CharLimitHint value={descDraft} max={TASK_DESCRIPTION_MAX} className="mr-auto" />
                  <button
                    onClick={() => void handleDescriptionSave()}
                    onMouseDown={(e) => e.preventDefault()}
                    onPointerDown={(e) => e.preventDefault()}
                    className="btn btn-primary px-3 py-1 text-xs"
                  >
                    Done
                  </button>
                </div>
              </div>
            ) : task.description ? (
              <div onClick={startDescriptionEdit} aria-label="Edit description" className="cursor-text">
                <Markdown>{task.description}</Markdown>
              </div>
            ) : (
              <button
                onClick={startDescriptionEdit}
                className="w-full rounded-lg border border-dashed border-border/60 px-3 py-4 text-left text-sm text-muted transition-colors hover:border-accent/40 hover:text-secondary"
              >
                No description - click to add one
              </button>
            )}
        </div>

        <div className="mt-5 border-t border-border pt-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <Label>Subtasks</Label>
            {hasSubtasks && (
              <span className="text-[11px] text-muted">
                {subtasks.filter((s) => s.status === "done").length}/{subtasks.length}
              </span>
            )}
          </div>
          <TaskChecklist subtasks={subtasks} taskId={task.id} />
        </div>
      </div>

      {/* Meta: tags, links, break-down */}
      <div className="mt-4">
        <Label>Tags</Label>
        <TaskTagsEditor taskId={task.id} tags={tags} onChange={setTags} />
      </div>

      {(task.links?.length ?? 0) > 0 && (
        <div className="mt-4 border-t border-border pt-3">
          <TaskLinks links={task.links || []} taskId={task.id} />
        </div>
      )}


      {isBroadTask(task.title) && (
        <button
          onClick={handleBreakDownNow}
          disabled={busy}
          className="btn mt-4 w-full gap-2 border border-accent/20 bg-accent/10 px-3 py-2 text-xs text-accent transition-all hover:border-accent/40 hover:bg-accent/20 disabled:opacity-50"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M12 2.5l1.7 4.8 4.8 1.7-4.8 1.7L12 15.5l-1.7-4.8L5.5 9l4.8-1.7L12 2.5z" />
            <path d="M18.6 14.4l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
          </svg>
          <span>{busy ? "Breaking down…" : "Break this down into subtasks"}</span>
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
            <button
              type="button"
              onClick={openDescriptionEditor}
              aria-label="Edit description formatting"
              className="pointer-coarse:h-10 pointer-coarse:w-10 rounded-lg p-1.5 text-secondary transition-colors hover:bg-hover hover:text-primary"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 7V4h16v3" />
                <path d="M9 20h6" />
                <path d="M12 4v16" />
              </svg>
            </button>
            {/* Comments are not built yet: a disabled control is clearer than a
                bubble that silently closed the drawer. */}
            <button
              type="button"
              disabled
              aria-label="Comments (coming soon)"
              title="Comments (coming soon)"
              className="cursor-not-allowed rounded-lg p-1.5 text-muted opacity-50"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </button>
            <button
              onClick={() => {
                void loadShareData();
                setShareOpen((v) => !v);
              }}
              className="rounded-lg p-1.5 text-secondary transition-colors hover:bg-hover hover:text-primary"
              aria-label="Share with a team"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
              </svg>
            </button>
            <PopoverMenu
              open={shareOpen}
              triggerRef={footerMoreRef}
              align="right"
              preferred="above"
              onClose={() => setShareOpen(false)}
              className="w-64"
            >
              <div className="p-2">
                <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Share with a team
                </p>
                {teamList.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-muted">
                    Create a team in Settings → Collaborate to share this task.
                  </p>
                ) : (
                  teamList.map((t) => {
                    const isShared = sharedTeamIds.has(t.id);
                    return (
                      <button
                        key={t.id}
                        onClick={() => void toggleShare(t.id)}
                        className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-secondary transition-colors hover:bg-hover hover:text-primary"
                      >
                        <span className="truncate">{t.name}</span>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${isShared ? "gradient-bg text-[var(--on-gradient)]" : "bg-elevated text-muted"}`}>
                          {isShared ? "Shared" : "Share"}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </PopoverMenu>
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
  dimmed?: boolean;
  children: React.ReactNode;
}

function DrawerShell({ onClose, title, dimmed, children }: DrawerShellProps) {
  return (
    <div
      className="fixed inset-0 z-40 flex justify-end"
      // In the Electron desktop shell the top strip holds the OS window
      // controls: start the overlay below it (so the strip stays draggable and
      // the buttons stay visible) and mark the overlay no-drag so the close
      // button is clickable on macOS instead of starting a window drag.
      style={{ top: "var(--desktop-titlebar, 0px)", WebkitAppRegion: "no-drag" } as CSSProperties}
    >
      <div
        className="h-full flex-1 bg-black/40 backdrop-blur-[2px]"
        aria-hidden
        onClick={onClose}
      />
      <div className="slide-in-right flex h-full w-full flex-col border-l border-border bg-surface shadow-2xl sm:w-[400px] sm:max-w-[92vw]">
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
        <div className={`flex flex-1 flex-col overflow-y-auto px-4 py-3 transition-opacity ${dimmed ? "opacity-50" : ""}`}>{children}</div>
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
