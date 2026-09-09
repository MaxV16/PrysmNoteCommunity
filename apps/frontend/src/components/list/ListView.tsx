"use client";

import { useState, useMemo, useCallback } from "react";
import { useAppStore } from "@/stores/app-store";
import type { Task } from "@/types/task";
import type { TaskStatus } from "@/types/task";
import { useTasks } from "@/hooks/useTasks";
import { useToast } from "@/lib/toast-context";
import { useBoardSections } from "@/hooks/useBoardSections";
import { TaskForm } from "@/components/tasks/TaskForm";
import { Modal } from "@/components/ui/Modal";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { TaskContextMenu, type ContextMenuState } from "@/components/tasks/TaskContextMenu";
import { TIER_COLORS, normalizePriority } from "@/lib/priority";
import { useLocalBool } from "@/lib/use-local-bool";
import { formatDate } from "@/lib/dates";
import { taskTimeLabel } from "@/lib/task-time";
import { matchesSearchQuery } from "@/lib/task-search";
import { api } from "@/lib/api";

const PRIORITY_COLORS: Record<number, string> = TIER_COLORS;

const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
  cancelled: "Cancelled",
};

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
  const { updateTask, createTask, fetchTasks, deleteTasksBatch, restoreTasksBatch } = useTasks();
  const { showToast } = useToast();
  const { sections: boardSections } = useBoardSections("board");
  const { sections: kanbanSections } = useBoardSections("kanban");
  const soundOn = useLocalBool("prysm_notif_sound", true);
  const [sortBy, setSortBy] = useState<"date" | "priority">("date");
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [menu, setMenu] = useState<{ state: ContextMenuState; x: number; y: number } | null>(null);
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showDateModal, setShowDateModal] = useState(false);
  const [moveDate, setMoveDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const visibleTasks = useMemo(() => {
    let filtered = tasks.filter((t) => !t.is_archived);
    if (activeListId) {
      filtered = filtered.filter((t) => t.list_id === activeListId);
    }
    if (searchQuery) {
      filtered = filtered.filter((t) => matchesSearchQuery(t, searchQuery));
    }
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
  }, [tasks, searchQuery, activeListId, sortBy]);

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
    await createTask(
      activeListId ? { ...data, list_id: activeListId } : data
    );
    setShowTaskForm(false);
  };

  const handleToggleStatus = async (task: Task) => {
    const next = task.status === "done" ? "todo" : "done";
    if (next === "done" && soundOn) {
      const { playCompletionSound } = await import("@/lib/sounds");
      playCompletionSound();
    }
    await updateTask(task.id, { status: next });
  };

  const openCardMenu = useCallback((e: React.MouseEvent, task: Task) => {
    setMenu({ state: { kind: "task", task }, x: e.clientX, y: e.clientY });
  }, []);

  const handleEmptyNewTask = useCallback(() => {
    setShowTaskForm(true);
  }, []);

  const runBatch = async (request: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await request();
      await fetchTasks();
      clearTaskSelection();
      return true;
    } catch {
      setActionError("The batch operation failed. Try again.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handleMoveTo = async (sectionId: string | null) => {
    const ok = await runBatch(() =>
      api.post("/tasks/batch-board-move", {
        task_ids: selectedTaskIds,
        section_id: sectionId,
        index: 0,
      })
    );
    if (ok) setShowMoveModal(false);
  };

  const handleSetDate = async () => {
    if (!moveDate) return;
    const ok = await runBatch(() =>
      api.post("/tasks/batch-set-date", {
        task_ids: selectedTaskIds,
        date: moveDate,
      })
    );
    if (ok) setShowDateModal(false);
  };

  const handleDelete = async () => {
    const ids = [...selectedTaskIds];
    if (ids.length === 0) return;
    const ok = await runBatch(() => deleteTasksBatch(ids));
    if (ok) {
      showToast(
        ids.length === 1 ? "Task moved to Trash" : `${ids.length} tasks moved to Trash`,
        "info",
        {
          label: "Undo",
          onClick: () => {
            void restoreTasksBatch(ids).catch(() => {
              showToast("Could not restore tasks", "error");
            });
          },
        }
      );
    }
  };

  const statusSections = kanbanSections.filter((s) => s.status);

  return (
    <div className="flex flex-col h-full bg-base">
      <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2 shrink-0">
        <button
          onClick={handleSelectAll}
          title={allVisibleSelected ? "Deselect all visible" : "Select all visible"}
          aria-label="Select all visible tasks"
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border-2 transition-colors ${
            allVisibleSelected ? "bg-accent border-accent" : "border-border hover:border-accent/50"
          }`}
        >
          {allVisibleSelected && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--bg-base)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          )}
        </button>
        <div className="relative flex-1">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search tasks..."
            className="input-field pl-8 text-xs"
          />
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted">🔍</span>
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-primary"
            >
              ✕
            </button>
          )}
        </div>
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
          className="input-field text-xs w-28 shrink-0"
        >
          <option value="date">By Date</option>
          <option value="priority">By Priority</option>
        </select>
        <button
          onClick={() => setShowTaskForm(true)}
          className="btn btn-primary px-4 py-1.5 text-xs shrink-0"
        >
          + New
        </button>
      </div>

      {selectedTaskIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-elevated/60 px-4 py-2 shrink-0">
          <span className="text-[11px] font-semibold text-primary">{selectedTaskIds.length} selected</span>
          <button
            onClick={() => setShowMoveModal(true)}
            disabled={busy}
            className="btn bg-elevated border border-border px-3 py-1 text-[11px] text-secondary hover:text-primary rounded-full"
          >
            Move to…
          </button>
          <button
            onClick={() => setShowDateModal(true)}
            disabled={busy}
            className="btn bg-elevated border border-border px-3 py-1 text-[11px] text-secondary hover:text-primary rounded-full"
          >
            Set date
          </button>
          <button
            onClick={() => void handleDelete()}
            disabled={busy}
            className="btn bg-elevated border border-border px-3 py-1 text-[11px] text-danger hover:brightness-125 rounded-full"
          >
            Delete
          </button>
          <button
            onClick={clearTaskSelection}
            className="btn bg-elevated border border-border px-3 py-1 text-[11px] text-secondary hover:text-primary rounded-full"
          >
            Clear
          </button>
          {actionError && <span className="text-[11px] text-danger">{actionError}</span>}
        </div>
      )}

      <div
        className="flex-1 overflow-auto"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ state: { kind: "empty" }, x: e.clientX, y: e.clientY });
        }}
        onPointerDown={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest("[data-list-row], [data-list-check], button, input, select, textarea, a")) return;
          clearTaskSelection();
        }}
      >
        {visibleTasks.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-xs text-muted">No tasks found</div>
        ) : (
          <div className="divide-y divide-border/30">
            {visibleTasks.map((task) => {
              const isDone = task.status === "done";
              const isSelected = selectedTaskIds.includes(task.id);
              return (
                <div
                  key={task.id}
                  data-list-row
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
                    data-list-check
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleTaskSelected(task.id);
                    }}
                    aria-pressed={isSelected}
                    aria-label={isSelected ? `Deselect ${task.title}` : `Select ${task.title}`}
                    className={`h-4 w-4 shrink-0 cursor-pointer rounded border-2 transition-colors ${
                      isSelected ? "bg-accent border-accent text-[var(--bg-base)]" : "border-border hover:border-accent/50 text-transparent"
                    } flex items-center justify-center`}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleToggleStatus(task); }}
                    className={`h-4 w-4 rounded border-2 shrink-0 flex items-center justify-center transition-colors ${
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
                    style={{ backgroundColor: PRIORITY_COLORS[normalizePriority(task.priority)] || "#9E9E9E" }}
                  />
                  <div className="flex-1 min-w-0">
                    <span className={`text-sm truncate block ${isDone ? "line-through text-muted" : "text-primary"}`}>
                      {task.title}
                    </span>
                    {(task.due_date || task.start_date) && (
                      <span className="text-[10px] text-muted mt-0.5 block">
                        {task.start_date && `From ${formatDate(new Date(task.start_date + "T00:00:00"), { includeYear: false })} `}
                        {task.due_date && `${task.start_date ? "→ " : ""}Due ${formatDate(new Date(task.due_date + "T00:00:00"), { includeYear: false })}`}
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
              );
            })}
          </div>
        )}
      </div>

      <Modal
        isOpen={showMoveModal}
        onClose={() => setShowMoveModal(false)}
        title={`Move ${selectedTaskIds.length} task${selectedTaskIds.length === 1 ? "" : "s"}`}
      >
        <div className="space-y-3">
          {statusSections.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">By Status</p>
              <div className="space-y-1">
                {statusSections.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => void handleMoveTo(s.id)}
                    disabled={busy}
                    className="block w-full rounded-lg px-3 py-2 text-left text-xs text-secondary transition-colors hover:bg-hover hover:text-primary disabled:opacity-50"
                  >
                    {STATUS_LABELS[s.status as TaskStatus] ?? s.title}
                  </button>
                ))}
              </div>
            </div>
          )}
          {boardSections.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">Board Sections</p>
              <div className="space-y-1">
                {boardSections.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => void handleMoveTo(s.id)}
                    disabled={busy}
                    className="block w-full rounded-lg px-3 py-2 text-left text-xs text-secondary transition-colors hover:bg-hover hover:text-primary disabled:opacity-50"
                  >
                    {s.title}
                  </button>
                ))}
              </div>
            </div>
          )}
          <button
            onClick={() => void handleMoveTo(null)}
            disabled={busy}
            className="block w-full rounded-lg px-3 py-2 text-left text-xs text-secondary transition-colors hover:bg-hover hover:text-primary disabled:opacity-50"
          >
            Unsorted
          </button>
          {actionError && <p className="text-xs text-danger">{actionError}</p>}
        </div>
      </Modal>

      <Modal
        isOpen={showDateModal}
        onClose={() => setShowDateModal(false)}
        title={`Set date for ${selectedTaskIds.length} task${selectedTaskIds.length === 1 ? "" : "s"}`}
      >
        <div className="space-y-3">
          <input
            type="date"
            value={moveDate}
            onChange={(e) => setMoveDate(e.target.value)}
            className="input-field"
            aria-label="Date to assign"
          />
          {actionError && <p className="text-xs text-danger">{actionError}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => void handleSetDate()}
              disabled={busy || !moveDate}
              className="btn btn-gradient px-5 py-2 text-sm rounded-xl disabled:opacity-50"
            >
              Apply
            </button>
            <button
              onClick={() => setShowDateModal(false)}
              className="btn bg-elevated border border-border text-secondary px-4 py-2 text-sm rounded-xl"
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>

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