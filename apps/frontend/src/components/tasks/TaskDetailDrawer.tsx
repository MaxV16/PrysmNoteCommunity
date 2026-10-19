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
import {
  TaskReminderFields,
  defaultReminderAt,
  describeReminder,
  taskReminderDraft,
  type ReminderChannel,
  type TaskReminderDraft,
} from "./TaskReminderFields";
import {
  requestNotificationPermission,
  useNotificationPrefs,
} from "@/lib/notifications";
import {
  nativeNotificationsSupported,
  requestNativeNotificationPermission,
} from "@/lib/capbridge";
import { TaskChecklist } from "./TaskChecklist";
import { TaskLinks } from "./TaskLinks";
import { TaskTagsEditor } from "./TaskTagsEditor";
import { DateRecurrencePopover } from "./DateRecurrencePopover";
import { describeRule } from "@/lib/recurrence";
import { MarkdownToolbar } from "@/components/ui/MarkdownToolbar";
import { MarkdownImagePreview } from "@/components/ui/MarkdownImagePreview";
import { Markdown } from "@/components/ai/Markdown";
import dynamic from "next/dynamic";
import { api } from "@/lib/api";
import { useLocalBool } from "@/lib/use-local-bool";
import { useResizablePanel } from "@/hooks/use-resizable-panel";
import { formatDate } from "@/lib/dates";
import { taskTimeLabel } from "@/lib/task-time";
import { TASK_TITLE_MAX, TASK_DESCRIPTION_MAX } from "@/lib/char-limits";
import { CharLimitHint } from "@/components/ui/CharLimitHint";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import {
  imageSourceFrom,
  insertImageAtCursor,
  type ImageInsertSource,
} from "@/lib/upload";

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

interface ShareTeam {
  id: string;
  name: string;
  members?: { user_id: string; email?: string | null; role: string }[];
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
  const [teamList, setTeamList] = useState<ShareTeam[]>([]);
  const [sharedTeamIds, setSharedTeamIds] = useState<Set<string>>(new Set());
  const [sharedUserIds, setSharedUserIds] = useState<Set<string>>(new Set());

  const loadShareData = async () => {
    try {
      const [teamsRes, sharesRes] = await Promise.all([
        api.get<{ teams: ShareTeam[] }>("/teams/"),
        api.get<{ team_ids?: string[]; user_ids?: string[] }>(`/tasks/${task.id}/shares`),
      ]);
      setTeamList(teamsRes.teams ?? []);
      setSharedTeamIds(new Set(sharesRes.team_ids ?? []));
      setSharedUserIds(new Set(sharesRes.user_ids ?? []));
    } catch {
      showToast("Could not load sharing details", "error");
    }
  };

  const toggleShareTeam = async (teamId: string) => {
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
    } catch {
      showToast("Could not update team sharing", "error");
    }
  };

  const toggleShareUser = async (teamId: string, userId: string) => {
    const isShared = sharedUserIds.has(userId);
    try {
      if (isShared) {
        await api.delete(`/teams/${teamId}/share-task/${task.id}?user_id=${userId}`);
        setSharedUserIds((prev) => {
          const next = new Set(prev);
          next.delete(userId);
          return next;
        });
      } else {
        await api.post(`/teams/${teamId}/share-task`, { task_id: task.id, user_id: userId });
        setSharedUserIds((prev) => new Set(prev).add(userId));
      }
    } catch {
      showToast("Could not update sharing", "error");
    }
  };
  const [editingDescription, setEditingDescription] = useState(false);
  const [descDraft, setDescDraft] = useState(task.description || "");
  const [descUploading, setDescUploading] = useState(false);
  const pendingPasteRef = useRef<ImageInsertSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [subtasks, setSubtasks] = useState<Task[]>(task.subtasks || []);
  const [tags, setTags] = useState<TaskTag[]>(task.tags || []);
  const [dateOpen, setDateOpen] = useState(false);
  const [reminderDraft, setReminderDraft] = useState<TaskReminderDraft>(() =>
    taskReminderDraft(task)
  );
  const [reminderOpen, setReminderOpen] = useState(() =>
    Boolean(task.reminder_at || task.reminder_enabled)
  );
  const { prefs: notifPrefs, update: updateNotifPrefs } = useNotificationPrefs();
  const datePillRef = useRef<HTMLButtonElement | null>(null);
  const titleOptionsRef = useRef<HTMLButtonElement | null>(null);
  const priorityRef = useRef<HTMLButtonElement | null>(null);
  const statusRef = useRef<HTMLButtonElement | null>(null);
  const shareRef = useRef<HTMLButtonElement | null>(null);
  const descSectionRef = useRef<HTMLDivElement | null>(null);
  const descTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [optionsTrigger, setOptionsTrigger] = useState<HTMLButtonElement | null>(null);
  const { updateTask, deleteTask, restoreTask, fetchTasks, stopTaskRecurrence } = useTasks();
  const { showToast } = useToast();
  const { addNoteWithContent } = useStickyBoard();

  const isNote = !task.start_date && !task.due_date;
  const tier: PriorityTier = normalizePriority(task.priority);
  const dateRange = formatDateRange(task);
  const isShared = sharedTeamIds.size > 0 || sharedUserIds.size > 0;

  const hasSubtasks = subtasks.length > 0;

  // Keep the reminder draft in step with server saves (including a completion
  // clearing reminder_at), while leaving an in-progress edit untouched.
  useEffect(() => {
    setReminderDraft(taskReminderDraft(task));
    if (task.reminder_at || task.reminder_enabled) setReminderOpen(true);
  }, [task]);

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

  // Load the shared state as soon as the drawer opens so the share button can
  // show a small indicator even before the menu is opened.
  useEffect(() => {
    void loadShareData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

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
    // An image upload is still resolving; keep the editor open so it lands.
    if (descUploading) return;
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

  const handleDescriptionImage = async (source: ImageInsertSource | null) => {
    if (!source) return;
    const textarea = descTextareaRef.current;
    if (!textarea) return;
    setDescUploading(true);
    try {
      await insertImageAtCursor(textarea, source, setDescDraft);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Could not upload that image.", "error");
    } finally {
      setDescUploading(false);
    }
  };

  // Paste an image anywhere in the open drawer (not just the focused editor):
  // copying an image and pressing Cmd/Ctrl+V should attach it to the
  // description instead of silently doing nothing. The editor's own onPaste
  // handles the case where the textarea already has focus.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (editingDescription) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      const source = imageSourceFrom(e.clipboardData);
      if (!source) return;
      e.preventDefault();
      pendingPasteRef.current = source;
      setDescDraft(task.description || "");
      setEditingDescription(true);
      requestAnimationFrame(() => {
        descSectionRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      });
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [editingDescription, task.description]);

  // The editor mounts in the same render as the paste, so insert once its
  // textarea ref exists (and keep the image if it is not ready yet).
  useEffect(() => {
    if (!editingDescription || !pendingPasteRef.current || !descTextareaRef.current) return;
    const source = pendingPasteRef.current;
    pendingPasteRef.current = null;
    void handleDescriptionImage(source);
  });

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
    reminder_at?: string | null;
    reminder_inapp?: boolean;
    reminder_push?: boolean;
    reminder_email?: boolean;
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
    if (data.reminder_at !== undefined && data.reminder_at !== (task.reminder_at ?? null))
      fields.reminder_at = data.reminder_at;
    if (
      data.reminder_inapp !== undefined &&
      data.reminder_inapp !== (task.reminder_inapp ?? true)
    )
      fields.reminder_inapp = data.reminder_inapp;
    if (data.reminder_push !== undefined && data.reminder_push !== !!task.reminder_push)
      fields.reminder_push = data.reminder_push;
    if (data.reminder_email !== undefined && data.reminder_email !== !!task.reminder_email)
      fields.reminder_email = data.reminder_email;
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

  const handleStopRecurrence = async () => {
    await stopTaskRecurrence(task.id);
    showToast("Recurrence stopped", "info");
  };

  const handleDateChange = async (
    newStartDate: string | null,
    newDueDate: string | null,
    newRule: string | null,
    newEndDate: string | null
  ) => {
    setDateOpen(false);
    const hadRecurrence = !!task.recurrence_rule || !!task.recurrence_parent_id;
    const fields: Record<string, unknown> = {};
    if (newStartDate) fields.start_date = newStartDate;
    if (newDueDate) fields.due_date = newDueDate;
    else {
      fields.start_date = null;
      fields.due_date = null;
    }
    fields.recurrence_rule = newRule;
    fields.recurrence_end_date = newEndDate;
    // Clearing the repeat must also clear the upcoming occurrences; the endpoint
    // keeps the ones already created and soft-deletes the future ones.
    if (!newRule && hadRecurrence) {
      await stopTaskRecurrence(task.id);
    }
    await updateTask(task.id, fields);
  };

  const handleChannelChange = (channel: ReminderChannel, enabled: boolean) => {
    if (!enabled) return;
    if (channel === "push") {
      // The native shell asks the OS directly: Web Notification permission is
      // unavailable inside WKWebView and the reminder is scheduled natively.
      const native = nativeNotificationsSupported();
      const request = native
        ? requestNativeNotificationPermission()
        : requestNotificationPermission();
      void request.then((granted) => {
        if (granted) {
          if (!notifPrefs.push_enabled) {
            void updateNotifPrefs({ push_enabled: true });
          }
        } else {
          showToast(
            native
              ? "Notifications are blocked for this device"
              : "Notifications are blocked for this browser",
            "error"
          );
        }
      });
    }
    if (channel === "email" && !notifPrefs.email_reminders) {
      void updateNotifPrefs({ email_reminders: true });
    }
  };

  const handleSaveReminder = async () => {
    try {
      await updateTask(task.id, {
        reminder_enabled: reminderDraft.enabled,
        reminder_at: reminderDraft.enabled
          ? reminderDraft.at || defaultReminderAt(task.due_date || task.start_date)
          : null,
        reminder_inapp: reminderDraft.inapp,
        reminder_push: reminderDraft.push,
        reminder_email: reminderDraft.email,
      });
      showToast(
        reminderDraft.enabled ? "Reminder saved" : "Reminder turned off",
        "info"
      );
    } catch {
      showToast("Could not save the reminder", "error");
    }
  };

  if (editing) {
    return (
      <DrawerShell onClose={onClose} title="Edit Task" resizeKey={task.id}>
        <TaskForm
          onSubmit={handleUpdate}
          onCancel={() => setEditing(false)}
          initial={task}
        />
      </DrawerShell>
    );
  }

  return (
    <DrawerShell onClose={onClose} dimmed={task.status === "done"} resizeKey={task.id}>
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

      {(task.recurrence_rule || task.recurrence_parent_id) && (
        <div className="mt-2 flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-full bg-elevated px-2 py-0.5 text-[11px] text-secondary">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8" />
              <path d="M20 4v4h-4" />
              <path d="M20 12a8 8 0 0 1-13.7 5.6L4 16" />
              <path d="M4 20v-4h4" />
            </svg>
            {task.recurrence_rule ? describeRule(task.recurrence_rule) || "Repeats" : "Repeats"}
          </span>
          <button
            onClick={handleStopRecurrence}
            className="text-[11px] text-secondary transition-colors hover:text-primary"
          >
            Stop repeating
          </button>
        </div>
      )}

      {/* Per-task reminder: exact time plus the channels the user picked. */}
      <div className="mt-3">
        {reminderOpen ? (
          <div className="space-y-2">
            <TaskReminderFields
              value={reminderDraft}
              onChange={setReminderDraft}
              suggestedDate={task.due_date || task.start_date}
              onChannelChange={handleChannelChange}
              idPrefix="drawer"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setReminderDraft(taskReminderDraft(task));
                  setReminderOpen(false);
                }}
                className="btn bg-elevated border border-border px-3 py-1 text-xs text-secondary hover:bg-hover hover:text-primary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSaveReminder()}
                className="btn btn-primary px-3 py-1 text-xs"
              >
                Save reminder
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setReminderDraft((prev) =>
                prev.enabled
                  ? prev
                  : {
                      ...prev,
                      enabled: true,
                      at:
                        prev.at ||
                        defaultReminderAt(task.due_date || task.start_date),
                    }
              );
              setReminderOpen(true);
            }}
            className="flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-elevated px-3 py-2 text-left transition-colors hover:bg-hover"
            aria-label="Set task reminder"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.7 21a2 2 0 0 1-3.4 0" />
                </svg>
              </span>
              <span className="min-w-0">
                <span className="block text-sm text-secondary">Remind me</span>
                <span className="block text-[11px] text-muted">
                  {task.reminder_at
                    ? describeReminder(task.reminder_at)
                    : task.reminder_enabled
                    ? "On"
                    : "Off"}
                </span>
              </span>
            </span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted" aria-hidden>
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        )}
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

      {/* Content: description then subtasks, all on one page. No flex-1 so the
          sections flow directly into Tags, GitHub and the footer instead of
          leaving a large empty gap on short tasks (mostly visible on phones). */}
      <div ref={descSectionRef} className="mt-4">
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
                  onPaste={(e) => {
                    const source = imageSourceFrom(e.clipboardData);
                    if (source) {
                      e.preventDefault();
                      void handleDescriptionImage(source);
                    }
                  }}
                  onDragOver={(e) => {
                    if (imageSourceFrom(e.dataTransfer)) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    const source = imageSourceFrom(e.dataTransfer);
                    if (source) {
                      e.preventDefault();
                      void handleDescriptionImage(source);
                    }
                  }}
                  onBlur={(e) => {
                    // Opening the image picker moves focus to its hidden file
                    // input; don't close the editor before the upload lands.
                    if (e.relatedTarget instanceof HTMLInputElement && e.relatedTarget.type === "file") return;
                    // Wait for an in-flight image upload; saving now would drop it.
                    if (descUploading) return;
                    void handleDescriptionSave();
                  }}
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
                <MarkdownImagePreview text={descDraft} className="mt-1" />
                <div className="mt-1 flex items-center justify-end gap-2">
                  {descUploading && (
                    <span role="status" className="text-[10px] text-secondary">
                      Uploading image...
                    </span>
                  )}
                  <CharLimitHint value={descDraft} max={TASK_DESCRIPTION_MAX} className="mr-auto" />
                  <button
                    onClick={() => void handleDescriptionSave()}
                    onMouseDown={(e) => e.preventDefault()}
                    onPointerDown={(e) => e.preventDefault()}
                    disabled={descUploading}
                    className="btn btn-primary px-3 py-1 text-xs disabled:opacity-60"
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

      <ErrorBoundary label="GitHub">
      </ErrorBoundary>

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
              ref={shareRef}
              onClick={() => {
                void loadShareData();
                setShareOpen((v) => !v);
              }}
              className="relative rounded-lg p-1.5 text-secondary transition-colors hover:bg-hover hover:text-primary"
              aria-label={isShared ? "Shared with a team" : "Share with a team"}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
              </svg>
              {isShared && (
                <span
                  className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent"
                  aria-hidden="true"
                />
              )}
            </button>
            <PopoverMenu
              open={shareOpen}
              triggerRef={shareRef}
              align="right"
              preferred="above"
              onClose={() => setShareOpen(false)}
              className="w-64"
            >
              <div className="max-h-80 overflow-y-auto p-2">
                <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                  Share with
                </p>
                {teamList.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-muted">
                    Create a team in Settings → Collaborate to share this task.
                  </p>
                ) : (
                  teamList.map((t) => {
                    const members = (t.members ?? []).filter((m) => m.user_id !== task.user_id);
                    return (
                      <div key={t.id} className="mb-1 last:mb-0">
                        <button
                          onClick={() => void toggleShareTeam(t.id)}
                          className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-secondary transition-colors hover:bg-hover hover:text-primary"
                        >
                          <span className="truncate font-medium">{t.name}</span>
                          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${sharedTeamIds.has(t.id) ? "gradient-bg text-[var(--on-gradient)]" : "bg-elevated text-muted"}`}>
                            {sharedTeamIds.has(t.id) ? "Whole team" : "Share team"}
                          </span>
                        </button>
                        {members.length > 0 && (
                          <div className="mt-0.5 space-y-0.5 pl-2">
                            {members.map((m) => {
                              const teamShared = sharedTeamIds.has(t.id);
                              const shared = teamShared || sharedUserIds.has(m.user_id);
                              return (
                                <button
                                  key={m.user_id}
                                  disabled={teamShared}
                                  onClick={() => void toggleShareUser(t.id, m.user_id)}
                                  className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1 text-left text-xs text-muted transition-colors hover:bg-hover hover:text-secondary disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
                                >
                                  <span className="truncate">{m.email || "Teammate"}</span>
                                  <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${shared ? "bg-accent/20 text-accent" : "bg-elevated text-muted"}`}>
                                    {shared ? "Shared" : "Share"}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
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
  resizeKey: string;
  children: React.ReactNode;
}

function DrawerShell({ onClose, title, dimmed, resizeKey, children }: DrawerShellProps) {
  const resize = useResizablePanel({
    panel: "task",
    suffix: resizeKey,
    defaultWidth: 400,
    minWidth: 320,
    maxWidth: 760,
    side: "right",
  });

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
        className="h-full flex-1 bg-black/40"
        aria-hidden
        onClick={onClose}
      />
      <div
        className={`slide-in-right relative flex h-full w-full flex-col border-l border-border bg-surface shadow-lg sm:max-w-[92vw] ${
          resize.isEnabled ? "" : "sm:w-[400px]"
        }`}
        style={resize.isEnabled ? { width: resize.width } : undefined}
      >
        {resize.isEnabled && (
          <div
            {...resize.handleProps}
            data-resize-handle="task"
            className="absolute inset-y-0 left-0 z-20 w-1.5 -translate-x-1/2 cursor-col-resize touch-none bg-transparent transition-colors hover:bg-accent/40"
          />
        )}
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
