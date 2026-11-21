"use client";

import { useState, useMemo, useCallback } from "react";
import { useAppStore } from "@/stores/app-store";
import type { Task } from "@/types/task";
import { useTasks } from "@/hooks/useTasks";
import { useVisibleTasks } from "@/hooks/useVisibleTasks";
import { useToast } from "@/lib/toast-context";
import { useBatchDelete } from "@/hooks/useBatchDelete";
import { TaskForm } from "@/components/tasks/TaskForm";
import { Modal } from "@/components/ui/Modal";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { TaskContextMenu, type ContextMenuState } from "@/components/tasks/TaskContextMenu";
import { SelectionActionBar } from "@/components/tasks/SelectionActionBar";
import { useSelectionBatchActions } from "@/components/tasks/SelectionBatchActions";
import { TIER_COLORS, normalizePriority } from "@/lib/priority";
import { useLocalBool } from "@/lib/use-local-bool";
import { formatDate } from "@/lib/dates";
import { taskTimeLabel } from "@/lib/task-time";
import { useLongPress } from "@/lib/use-long-press";

const PRIORITY_COLORS: Record<number, string> = TIER_COLORS;

export function ListView() {
  const tasks = useAppStore((s) => s.tasks);
  const setSelectedTaskId = useAppStore((s) => s.setSelectedTaskId);
  const selectedTaskIds = useAppStore((s) => s.selectedTaskIds);
  const toggleTaskSelected = useAppStore((s) => s.toggleTaskSelected);
  const clearTaskSelection = useAppStore((s) => s.clearTaskSelection);
  const setSelectedTaskIds = useAppStore((s) => s.setSelectedTaskIds);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const activeListId = useAppStore((s) => s.activeListId);
  const { updateTask, createTask } = useTasks();
  const { busy: batchDeleting, softDeleteWithUndo } = useBatchDelete();
  const { showToast } = useToast();
  const {
    extra: batchExtra,
    modals: batchModals,
    busy: batchBusy,
    actionError: batchActionError,
  } = useSelectionBatchActions();
  const soundOn = useLocalBool("prysm_notif_sound", true);
  const rewardsOn = useLocalBool("prysm_rewards", true);
  const [sortBy, setSortBy] = useState<"date" | "priority">("date");
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [menu, setMenu] = useState<{ state: ContextMenuState; x: number; y: number } | null>(null);
  const [expandedSubtasks, setExpandedSubtasks] = useState<Set<string>>(new Set());

  const visible = useVisibleTasks();
  const visibleTasks = useMemo(() => {
    const filtered = [...visible];
    switch (sortBy) {
      case "priority":
        filtered.sort((a, b) => a.priority - b.priority);
        break;
      case "date":
      default:
        filtered.sort((a, b) => {
          const da = a.due_date || a.start_date || "";
          const db = b.due_date || b.start_date || "";
          if (!da && !db) {
            const ta = a.start_time || "";
            const tb = b.start_time || "";
            if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
            return 0;
          }
          if (!da) return 1;
          if (!db) return -1;
          if (da !== db) return da.localeCompare(db);
          const ta = a.start_time || "";
          const tb = b.start_time || "";
          if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
          if (ta && !tb) return -1;
          if (!ta && tb) return 1;
          return 0;
        });
        break;
    }
    return filtered;
  }, [visible, sortBy]);

  const childrenByParent = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const t of tasks) {
      if (!t.parent_task_id) continue;
      (map[t.parent_task_id] ||= []).push(t);
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
    }
    return map;
  }, [tasks]);

  const toggleSubtasks = useCallback((id: string) => {
    setExpandedSubtasks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allVisibleSelected = visibleTasks.length > 0 && visibleTasks.every((t) => selectedTaskIds.includes(t.id));

  const handleSelectAll = () => {
    const store = useAppStore.getState();
    if (allVisibleSelected) {
      const removed = new Set(visibleTasks.map((t) => t.id));
      store.setSelectedTaskIds(store.selectedTaskIds.filter((id) => !removed.has(id)));
    } else {
      const union = Array.from(new Set([...store.selectedTaskIds, ...visibleTasks.map((t) => t.id)]));
      store.setSelectedTaskIds(union);
    }
  };

  const handleCreateTask = async (data: Record<string, unknown>) => {
    try {
      await createTask({
        ...data,
        list_id: (data.list_id as string | undefined) ?? activeListId ?? undefined,
      });
      setShowTaskForm(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create the task. Try again.";
      showToast(message, "error");
    }
  };

  const handleToggleStatus = async (task: Task) => {
    const next = task.status === "done" ? "todo" : "done";
    if (next === "done") {
      if (soundOn) {
        const { playCompletionSound } = await import("@/lib/sounds");
        playCompletionSound();
      }
      if (rewardsOn) {
        const { celebrate } = await import("@/lib/celebrate");
        celebrate();
      }
    }
    await updateTask(task.id, { status: next });
  };

  const openCardMenu = useCallback((e: React.MouseEvent, task: Task) => {
    setMenu({ state: { kind: "task", task }, x: e.clientX, y: e.clientY });
  }, []);

  // Touch long-press on a row opens the mobile action bar (the row itself has no
  // drag gesture here).
  const longPress = useLongPress((p) => {
    const el = (p.target as HTMLElement | null)?.closest?.("[data-list-row]");
    const id = el?.getAttribute("data-task-id");
    if (id) useAppStore.getState().setMobileActionTaskId(id);
  }, {});

  const handleEmptyNewTask = useCallback(() => {
    setShowTaskForm(true);
  }, []);

  const handleDelete = async () => {
    const ids = [...selectedTaskIds];
    if (ids.length === 0) return;
    const ok = await softDeleteWithUndo(ids);
    if (ok) {
      clearTaskSelection();
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2 shrink-0 sm:gap-3 sm:px-4">
        <button
          onClick={handleSelectAll}
          title={allVisibleSelected ? "Deselect all visible" : "Select all visible"}
          aria-label="Select all visible tasks"
          className={`relative flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 transition-colors pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-[''] ${
            allVisibleSelected ? "bg-accent border-accent" : "border-border hover:border-accent/50"
          }`}
        >
          {allVisibleSelected && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--bg-base)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          )}
        </button>
        <div className="relative min-w-0 flex-1">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tasks..."
            className="input-field pl-8 text-xs"
          />
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          </span>
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-primary"
            >
              ✕
            </button>
          )}
        </div>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          aria-label="Sort tasks"
          className="input-field h-9 text-xs w-[5.5rem] shrink-0 sm:h-10 sm:w-28"
        >
          <option value="date">By Date</option>
          <option value="priority">By Priority</option>
        </select>
        <button
          onClick={() => setShowTaskForm(true)}
          className="btn btn-primary pointer-coarse:min-h-9 px-3 py-2 text-xs shrink-0 sm:px-4 sm:py-1.5"
        >
          + New
        </button>
      </div>

      {selectedTaskIds.length > 0 && (
        <SelectionActionBar
          count={selectedTaskIds.length}
          busy={batchBusy || batchDeleting}
          onDelete={() => void handleDelete()}
          onClear={clearTaskSelection}
          actionError={batchActionError}
          extra={batchExtra}
        />
      )}

      <div
        className="flex-1 overflow-auto"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ state: { kind: "empty" }, x: e.clientX, y: e.clientY });
        }}
        onPointerDown={(e) => {
          const target = e.target as HTMLElement;
          longPress.onPointerDown(e);
          if (target.closest("[data-list-row], button, input, select, textarea, a")) return;
          clearTaskSelection();
        }}
        onPointerMove={longPress.onPointerMove}
        onPointerUp={longPress.onPointerUp}
        onPointerCancel={longPress.onPointerCancel}
      >
        {visibleTasks.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
            </span>
            <p className="text-sm font-semibold text-primary">No tasks found</p>
            <p className="text-xs text-secondary">Try a different filter, or add a task.</p>
            <button
              onClick={() => setShowTaskForm(true)}
              className="btn-gradient mt-3 rounded-lg px-4 py-2 text-xs font-semibold"
            >
              Create a task
            </button>
          </div>
        ) : (
          <div className="divide-y divide-border/30">
            {visibleTasks.map((task) => {
              const isDone = task.status === "done";
              const isSelected = selectedTaskIds.includes(task.id);
              const subtasks = childrenByParent[task.id] ?? [];
              const subtasksExpanded = expandedSubtasks.has(task.id);
              const shownSubtasks = subtasksExpanded ? subtasks : subtasks.slice(0, 2);
              return (
                <div key={task.id}>
                <div
                  data-list-row
                  data-task-id={task.id}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey) {
                      e.preventDefault();
                      toggleTaskSelected(task.id);
                      return;
                    }
                    clearTaskSelection();
                    setSelectedTaskId(task.id);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openCardMenu(e, task);
                  }}
                  className={`flex items-center gap-3 px-4 py-2.5 hover:bg-hover/20 transition-opacity cursor-pointer ${isDone ? "opacity-50" : ""} ${
                    isSelected ? "bg-accent/5" : ""
                  }`}
                >
                  <button
                    onClick={(e) => { e.stopPropagation(); handleToggleStatus(task); }}
                    aria-label={isDone ? `Mark ${task.title} as not done` : `Mark ${task.title} as done`}
                    className={`relative h-4 w-4 shrink-0 rounded border-2 flex items-center justify-center transition-colors pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-[''] ${
                      isDone ? "bg-accent border-accent" : "border-border hover:border-accent/50"
                    }`}
                  >
                    {isDone && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--bg-base)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    )}
                  </button>
                  <span
                    className="h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: PRIORITY_COLORS[normalizePriority(task.priority)] || "var(--text-muted)" }}
                  />
                  <div className="flex-1 min-w-0">
                    <span className={`text-sm text-scale-sm truncate block transition-colors duration-[var(--dur-slow)] ${isDone ? "line-through text-muted" : "text-primary"}`}>
                      {task.title}
                    </span>
                    {(task.due_date || task.start_date) && (
                      <span className="mt-0.5 block truncate text-[10px] text-muted">
                        {task.due_date
                          ? `${task.start_date && task.start_date !== task.due_date ? `From ${formatDate(new Date(task.start_date + "T00:00:00"), { includeYear: false })} ` : ""}Due ${formatDate(new Date(task.due_date + "T00:00:00"), { includeYear: false })}`
                          : `From ${formatDate(new Date(task.start_date! + "T00:00:00"), { includeYear: false })}`}
                        {taskTimeLabel(task) && ` · ${taskTimeLabel(task)}`}
                      </span>
                    )}
                  </div>
                  {task.tags && task.tags.length > 0 && (
                    <span className="flex shrink-0 gap-1">
                      {task.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag.id}
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ backgroundColor: tag.color || "var(--text-muted)" }}
                          title={tag.name}
                        />
                      ))}
                    </span>
                  )}
                </div>
                {subtasks.length > 0 && (
                  <div className="space-y-1 pb-2 pl-[3.25rem] pr-4">
                    {shownSubtasks.map((sub) => {
                      const subDone = sub.status === "done";
                      return (
                        <div key={sub.id} data-subtask-id={sub.id} className="flex items-center gap-2">
                          <button
                            onClick={(e) => { e.stopPropagation(); handleToggleStatus(sub); }}
                            aria-label={subDone ? `Mark ${sub.title} not done` : `Mark ${sub.title} done`}
                            className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors ${
                              subDone ? "bg-accent border-accent" : "border-border hover:border-accent/50"
                            }`}
                          >
                            {subDone && (
                              <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="var(--bg-base)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            )}
                          </button>
                          <span className={`truncate text-xs ${subDone ? "line-through text-muted" : "text-secondary"}`}>
                            {sub.title}
                          </span>
                        </div>
                      );
                    })}
                    {subtasks.length > 2 && (
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleSubtasks(task.id); }}
                        className="text-[10px] text-secondary transition-colors hover:text-primary"
                      >
                        {subtasksExpanded ? "Show less" : `... ${subtasks.length - 2} more`}
                      </button>
                    )}
                  </div>
                )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {batchModals}

      <Modal
        isOpen={showTaskForm}
        onClose={() => setShowTaskForm(false)}
        title="New Task"
      >
        <TaskForm
          onSubmit={handleCreateTask}
          onCancel={() => setShowTaskForm(false)}
        />
      </Modal>

      <ContextMenu
        open={!!menu}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
      >
        <TaskContextMenu menu={menu?.state ?? null} onClose={() => setMenu(null)} onNewTask={handleEmptyNewTask} />
      </ContextMenu>
    </div>
  );
}