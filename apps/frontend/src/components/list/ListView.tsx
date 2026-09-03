"use client";

import { useState, useMemo, useCallback } from "react";
import { useAppStore } from "@/stores/app-store";
import type { Task } from "@/types/task";
import { useTasks } from "@/hooks/useTasks";
import { TaskForm } from "@/components/tasks/TaskForm";
import { Modal } from "@/components/ui/Modal";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { TaskContextMenu, type ContextMenuState } from "@/components/tasks/TaskContextMenu";
import { TIER_COLORS, normalizePriority } from "@/lib/priority";
import { useLocalBool } from "@/lib/use-local-bool";
import { formatDate } from "@/lib/dates";
import { matchesSearchQuery } from "@/lib/task-search";

const PRIORITY_COLORS: Record<number, string> = TIER_COLORS;

export function ListView() {
  const tasks = useAppStore((s) => s.tasks);
  const setSelectedTaskId = useAppStore((s) => s.setSelectedTaskId);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const { updateTask, createTask } = useTasks();
  const soundOn = useLocalBool("prysm_notif_sound", true);
  const [sortBy, setSortBy] = useState<"date" | "priority">("date");
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [menu, setMenu] = useState<{ state: ContextMenuState; x: number; y: number } | null>(null);

  const visibleTasks = useMemo(() => {
    let filtered = tasks.filter((t) => !t.is_archived);
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
          if (!da && !db) return 0;
          if (!da) return 1;
          if (!db) return -1;
          return da.localeCompare(db);
        });
        break;
    }
    return filtered;
  }, [tasks, searchQuery, sortBy]);

  const handleCreateTask = async (data: Record<string, unknown>) => {
    await createTask(data);
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

  return (
    <div className="flex flex-col h-full bg-base">
      <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2 shrink-0">
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

      <div
        className="flex-1 overflow-auto"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ state: { kind: "empty" }, x: e.clientX, y: e.clientY });
        }}
      >
        {visibleTasks.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-xs text-muted">No tasks found</div>
        ) : (
          <div className="divide-y divide-border/30">
            {visibleTasks.map((task) => {
              const isDone = task.status === "done";
              return (
                <div
                  key={task.id}
                  data-list-row
                  onClick={() => setSelectedTaskId(task.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openCardMenu(e, task);
                  }}
                  className={`flex items-center gap-3 px-4 py-2.5 hover:bg-hover/20 transition-opacity cursor-pointer ${isDone ? "opacity-50" : ""}`}
                >
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
