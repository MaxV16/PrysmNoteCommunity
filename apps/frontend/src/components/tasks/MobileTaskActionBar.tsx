"use client";

import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/stores/app-store";
import { useTasks } from "@/hooks/useTasks";
import { useBatchDelete } from "@/hooks/useBatchDelete";
import { useBoardSections } from "@/hooks/useBoardSections";
import { api } from "@/lib/api";
import { buildDuplicatePayload } from "@/components/tasks/task-duplicate";
import { useToast } from "@/lib/toast-context";
import { registerBackHandler } from "@/lib/back-nav";
import { parseLocalDate, toLocalDateString } from "@/lib/utils";
import { todayISO } from "@/lib/dates";

type SectionKind = "timeline" | "kanban" | "board";
type BarMode = "actions" | "move" | "stretch";

/** Shift an ISO date by whole days (local midnight, DST-safe). */
function addDays(iso: string, days: number): string {
  const d = parseLocalDate(iso);
  d.setDate(d.getDate() + days);
  return toLocalDateString(d);
}

/** Inclusive day count between two ISO dates (a single day reads as 1). */
function spanDays(startIso: string, dueIso: string): number {
  const start = parseLocalDate(startIso);
  const due = parseLocalDate(dueIso);
  return Math.round((due.getTime() - start.getTime()) / 86_400_000) + 1;
}

interface MobileTaskActionBarProps {
  /**
   * Board section kind for the active view. The action bar is global, so it
   * must be told which kind to list; null hides the section picker entirely
   * (calendar/list and the non-task workspaces have no board sections).
   */
  sectionKind?: SectionKind | null;
}

/**
 * Fixed bottom action bar shown while a task is long-pressed on a touch device
 * (the long-press also picks the task up for drag). Mirrors the desktop
 * right-click menu's core actions: Done / Duplicate / Delete / Move.
 */
export function MobileTaskActionBar({ sectionKind = "timeline" }: MobileTaskActionBarProps) {
  const taskId = useAppStore((s) => s.mobileActionTaskId);
  const tasks = useAppStore((s) => s.tasks);
  const setMobileActionTaskId = useAppStore((s) => s.setMobileActionTaskId);
  const { createTask, updateTask } = useTasks();
  const { softDeleteWithUndo } = useBatchDelete();
  const activeListId = useAppStore((s) => s.activeListId);
  const { sections } = useBoardSections(
    sectionKind ?? "timeline",
    sectionKind === "timeline" ? activeListId : null
  );
  const { showToast } = useToast();
  const [mode, setMode] = useState<BarMode>("actions");
  const [moveDate, setMoveDate] = useState("");
  const [moveSectionId, setMoveSectionId] = useState("");
  const [stretchStart, setStretchStart] = useState("");
  const [stretchDue, setStretchDue] = useState("");
  const [busy, setBusy] = useState(false);

  const task = tasks.find((t) => t.id === taskId) ?? null;
  // Read the latest task inside the reset effect without making the task object
  // a dependency. `mergeTasks` replaces task objects on every refresh, so a
  // `task` dependency reset mode/busy (and allowed double submits) mid-flow (F5).
  const taskRef = useRef(task);
  taskRef.current = task;
  const hasTask = Boolean(task);

  useEffect(() => {
    setMode("actions");
    setBusy(false);
    const current = taskRef.current;
    setMoveDate(current ? current.start_date || current.due_date || "" : "");
    setMoveSectionId(current ? current.board_section_id || "" : "");
    const baseStart = current?.start_date || current?.due_date || todayISO();
    const baseDue = current?.due_date || current?.start_date || todayISO();
    setStretchStart(baseStart);
    setStretchDue(baseDue);
    // Reset only when the target task changes (or first resolves); unrelated
    // store refreshes keep the same taskId and hasTask, so they do not reset.
  }, [taskId, hasTask]);

  // Android/hardware back dismisses the action bar (or the move step) first.
  useEffect(() => {
    if (!taskId) return;
    return registerBackHandler(() => {
      if (mode !== "actions") setMode("actions");
      else setMobileActionTaskId(null);
    }, 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, mode]);

  if (!task) return null;

  const close = () => setMobileActionTaskId(null);

  const handleDone = async () => {
    setBusy(true);
    try {
      await updateTask(task.id, { status: "done" });
      showToast("Task completed", "success");
    } finally {
      setBusy(false);
      close();
    }
  };

  const handleDuplicate = async () => {
    setBusy(true);
    try {
      await createTask(buildDuplicatePayload(task));
      showToast("Task duplicated", "success");
    } finally {
      setBusy(false);
      close();
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      await softDeleteWithUndo([task.id]);
    } finally {
      setBusy(false);
      close();
    }
  };

  const handleMove = async () => {
    const current = taskRef.current ?? task;
    const currentDate = current.start_date || current.due_date || "";
    const currentSection = current.board_section_id || "";
    const dateChanged = moveDate !== currentDate;
    const sectionChanged = moveSectionId !== currentSection;

    if (!dateChanged && !sectionChanged) {
      // Nothing actually changed: no success toast, just back to the actions.
      setMode("actions");
      return;
    }

    setBusy(true);
    try {
      const patch: Record<string, unknown> = {};
      if (dateChanged) {
        if (moveDate) {
          patch.start_date = moveDate;
        } else {
          // The picker was seeded from start_date OR due_date, so clearing must
          // null both or the task would still show a date.
          patch.start_date = null;
          patch.due_date = null;
        }
      }
      if (Object.keys(patch).length > 0) await updateTask(task.id, patch);
      if (sectionChanged) {
        await api.post("/tasks/board-move", {
          task_id: task.id,
          section_id: moveSectionId || null,
          index: 0,
        });
      }
      showToast("Task moved", "success");
      close();
    } catch {
      showToast("Could not move the task", "error");
    } finally {
      setBusy(false);
    }
  };

  const nudgeStart = (delta: number) =>
    setStretchStart((prev) => {
      const next = addDays(prev, delta);
      return next > stretchDue ? stretchDue : next;
    });

  const nudgeDue = (delta: number) =>
    setStretchDue((prev) => {
      const next = addDays(prev, delta);
      return next < stretchStart ? stretchStart : next;
    });

  const handleStretch = async () => {
    const start = stretchStart <= stretchDue ? stretchStart : stretchDue;
    const due = stretchStart <= stretchDue ? stretchDue : stretchStart;
    const changed = start !== (task.start_date ?? "") || due !== (task.due_date ?? "");
    if (!changed) {
      setMode("actions");
      return;
    }
    setBusy(true);
    try {
      await updateTask(task.id, { start_date: start, due_date: due });
      showToast("Task stretched", "success");
      close();
    } catch {
      showToast("Could not stretch the task", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
      <div className="pointer-events-auto w-full max-w-md rounded-2xl border border-border bg-surface p-2 shadow-lg slide-up">
        <div className="mb-1 flex items-center gap-2 px-2">
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-primary" title={task.title}>
            {task.title}
          </span>
          <button
            onClick={close}
            className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-hover hover:text-primary"
            aria-label="Close actions"
          >
            ✖
          </button>
        </div>

        {mode === "actions" ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => void handleDone()}
              disabled={busy}
              className="btn btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
            >
              Done
            </button>
            <button
              onClick={() => void handleDuplicate()}
              disabled={busy}
              className="btn bg-elevated border border-border px-3 py-1.5 text-xs text-secondary hover:text-primary disabled:opacity-50"
            >
              Duplicate
            </button>
            <button
              onClick={() => setMode("move")}
              disabled={busy}
              className="btn bg-elevated border border-border px-3 py-1.5 text-xs text-secondary hover:text-primary disabled:opacity-50"
            >
              Move
            </button>
            <button
              onClick={() => setMode("stretch")}
              disabled={busy}
              className="btn bg-elevated border border-border px-3 py-1.5 text-xs text-secondary hover:text-primary disabled:opacity-50"
            >
              Stretch
            </button>
            <button
              onClick={() => void handleDelete()}
              disabled={busy}
              className="btn bg-elevated border border-danger/30 px-3 py-1.5 text-xs text-danger hover:bg-danger/10 disabled:opacity-50"
            >
              Delete
            </button>
            <button
              onClick={close}
              className="btn bg-elevated border border-border px-3 py-1.5 text-xs text-muted hover:text-primary"
            >
              Cancel
            </button>
          </div>
        ) : mode === "stretch" ? (
          <div className="space-y-2 p-1">
            <div className="text-center text-[11px] font-medium text-secondary">
              {spanDays(stretchStart, stretchDue)} day{spanDays(stretchStart, stretchDue) === 1 ? "" : "s"}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-9 shrink-0 text-[11px] font-medium text-secondary">Start</span>
              <button
                onClick={() => nudgeStart(-1)}
                aria-label="Start one day earlier"
                className="btn bg-elevated border border-border px-2.5 py-1 text-xs text-secondary hover:text-primary"
              >
                -1
              </button>
              <span className="flex-1 text-center text-xs text-primary">{stretchStart}</span>
              <button
                onClick={() => nudgeStart(1)}
                aria-label="Start one day later"
                className="btn bg-elevated border border-border px-2.5 py-1 text-xs text-secondary hover:text-primary"
              >
                +1
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-9 shrink-0 text-[11px] font-medium text-secondary">End</span>
              <button
                onClick={() => nudgeDue(-1)}
                aria-label="End one day earlier"
                className="btn bg-elevated border border-border px-2.5 py-1 text-xs text-secondary hover:text-primary"
              >
                -1
              </button>
              <span className="flex-1 text-center text-xs text-primary">{stretchDue}</span>
              <button
                onClick={() => nudgeDue(1)}
                aria-label="End one day later"
                className="btn bg-elevated border border-border px-2.5 py-1 text-xs text-secondary hover:text-primary"
              >
                +1
              </button>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => void handleStretch()}
                disabled={busy}
                className="btn btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
              >
                Apply
              </button>
              <button
                onClick={() => setMode("actions")}
                className="btn bg-elevated border border-border px-3 py-1.5 text-xs text-secondary hover:text-primary"
              >
                Back
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2 p-1">
            <label className="block text-[11px] font-medium text-secondary">
              Move to date
              <input
                type="date"
                value={moveDate}
                onChange={(e) => setMoveDate(e.target.value)}
                className="input-field mt-1 w-full"
              />
            </label>
            {sectionKind && sections.length > 0 && (
              <label className="block text-[11px] font-medium text-secondary">
                Section
                <select
                  value={moveSectionId}
                  onChange={(e) => setMoveSectionId(e.target.value)}
                  className="input-field mt-1 w-full"
                >
                  <option value="">Unsorted</option>
                  {sections.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => void handleMove()}
                disabled={busy}
                className="btn btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
              >
                Move
              </button>
              <button
                onClick={() => setMode("actions")}
                className="btn bg-elevated border border-border px-3 py-1.5 text-xs text-secondary hover:text-primary"
              >
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
