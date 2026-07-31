"use client";

import { useMemo, useCallback, useState, useEffect } from "react";
import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { useAppStore, type NavFilter } from "@/stores/app-store";
import { useTimeline } from "@/hooks/useTimeline";
import { TimelineHeader } from "@/components/timeline/TimelineHeader";
import { TimelineGrid } from "@/components/timeline/TimelineGrid";
import { TimelineLane } from "@/components/timeline/TimelineLane";
import { TaskDetail } from "@/components/tasks/TaskDetail";
import { TaskForm } from "@/components/tasks/TaskForm";
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { Modal } from "@/components/ui/Modal";
import { useTasks } from "@/hooks/useTasks";
import { useRouter } from "next/navigation";

function isToday(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const today = new Date();
  return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
}

function isWithinNext7Days(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weekLater = new Date(today);
  weekLater.setDate(weekLater.getDate() + 7);
  d.setHours(0, 0, 0, 0);
  return d >= today && d <= weekLater;
}

function applyNavFilter(tasks: ReturnType<typeof useAppStore.getState>["tasks"], filter: NavFilter) {
  if (!filter) return tasks;
  switch (filter) {
    case "inbox":
      return tasks.filter((t) => !t.start_date && !t.due_date);
    case "today":
      return tasks.filter((t) => isToday(t.start_date) || isToday(t.due_date));
    case "next7":
      return tasks.filter((t) => isWithinNext7Days(t.start_date) || isWithinNext7Days(t.due_date));
  }
}

interface TimelineViewProps {
  onToggleRight?: () => void;
  onOpenSticky?: () => void;
}

export function TimelineView({ onToggleRight, onOpenSticky }: TimelineViewProps) {
  const [isMobile, setIsMobile] = useState(false);
  const { tasks, selectedTaskId, setSelectedTaskId, projects, navFilter, setNavFilter, selectedProjectId, selectedTagId } = useAppStore();
  const { visibleRange, scrollOffset, setScrollOffset } = useTimeline(14);
  const { createTask, updateTask } = useTasks();
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [formDefaultDate, setFormDefaultDate] = useState<Date | null>(null);
  const [kanbanMode, setKanbanMode] = useState(false);
  const router = useRouter();

  useEffect(() => {
    setIsMobile(window.innerWidth < 768);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const viewDays = 14;

  const days = useMemo(() => {
    const result: Date[] = [];
    const current = new Date(visibleRange.start);
    for (let i = 0; i < viewDays; i++) {
      result.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
    return result;
  }, [visibleRange.start]);

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) || null,
    [tasks, selectedTaskId]
  );

  const tasksByProject = useMemo(() => {
    const map: Record<string, typeof tasks> = {};
    let activeTasks = applyNavFilter(
      tasks.filter((t) => t.status !== "done" && t.status !== "cancelled" && !t.is_archived),
      navFilter
    );
    if (selectedProjectId) {
      activeTasks = activeTasks.filter((t) => t.project_id === selectedProjectId);
    }
    if (selectedTagId) {
      activeTasks = activeTasks.filter((t) => t.tags?.some((tag) => tag.id === selectedTagId));
    }
    for (const task of activeTasks) {
      const pid = task.project_id || "__none__";
      if (!map[pid]) map[pid] = [];
      map[pid].push(task);
    }
    return map;
  }, [tasks, navFilter, selectedProjectId, selectedTagId]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, delta } = event;
      if (!active) return;
      const taskId = active.id as string;
      const dayWidth = (document.querySelector("[data-timeline-body]") as HTMLElement)?.clientWidth / viewDays || 100;
      const daysShifted = Math.round(delta.x / dayWidth);
      if (daysShifted === 0) return;
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;
      const fields: Record<string, string> = {};
      if (task.start_date) {
        const d = new Date(task.start_date);
        d.setDate(d.getDate() + daysShifted);
        fields.start_date = d.toISOString().split("T")[0];
      }
      if (task.due_date) {
        const d = new Date(task.due_date);
        d.setDate(d.getDate() + daysShifted);
        fields.due_date = d.toISOString().split("T")[0];
      }
      if (!task.start_date && !task.due_date) return;
      await updateTask(taskId, fields);
    },
    [tasks, updateTask]
  );

  const handlePrevWeek = () => setScrollOffset(scrollOffset - 7);
  const handleNextWeek = () => setScrollOffset(scrollOffset + 7);

  const handleCreateTask = useCallback(
    async (data: {
      title: string; description?: string; start_date?: string; due_date?: string;
      project_id?: string | null; status?: string; priority?: number;
      tag_ids?: string[]; recurrence_rule?: string; estimated_minutes?: number;
    }) => {
      await createTask(data);
      setShowTaskForm(false);
      setFormDefaultDate(null);
    },
    [createTask]
  );

  const handleDayDoubleClick = useCallback((day: Date) => {
    setFormDefaultDate(day);
    setShowTaskForm(true);
  }, []);

  const filterBadge = navFilter
    ? navFilter === "inbox" ? "Inbox" : navFilter === "today" ? "Today" : "Next 7 Days"
    : null;

  const projectFilterName = selectedProjectId
    ? projects.find((p) => p.id === selectedProjectId)?.name
    : null;

  const hasTasks = Object.keys(tasksByProject).length > 0;

  return (
    <div className="flex flex-col bg-base" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
      {/* Compact toolbar */}
      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 shrink-0">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span className="text-lg font-bold text-primary mr-2 hidden sm:block">Timeline</span>

        {filterBadge && (
          <span className="inline-flex items-center gap-1 bg-accent/15 text-accent text-[10px] px-2 py-0.5 rounded">
            {filterBadge}
            <button onClick={() => setNavFilter(null)} className="hover:text-primary">✕</button>
          </span>
        )}

        <div className="flex-1" />

        <div className="flex items-center gap-1">
          <button onClick={handlePrevWeek} className="btn bg-elevated px-3 py-1.5 text-xs text-secondary hover:bg-hover">
            ◀
          </button>
          <button onClick={handleNextWeek} className="btn bg-elevated px-3 py-1.5 text-xs text-secondary hover:bg-hover">
            ▶
          </button>
        </div>

        <button
          onClick={() => setKanbanMode(v => !v)}
          className={`btn text-xs px-3 py-1.5 rounded-full ${kanbanMode ? "bg-accent text-white" : "bg-elevated border border-border text-secondary hover:text-primary"}`}
        >
          {kanbanMode ? "Timeline" : "Kanban"}
        </button>

        <button onClick={onOpenSticky} className="btn bg-elevated border border-border text-xs px-3 py-1.5 rounded-full text-secondary hover:text-primary">
          Notes
        </button>

        <button
          onClick={() => { setFormDefaultDate(null); setShowTaskForm(!showTaskForm); }}
          className="btn btn-primary px-4 py-1.5 text-xs"
        >
          + New
        </button>

        <button onClick={() => router.push("/settings")} className="btn bg-elevated border border-border text-xs px-3 py-1.5 rounded-full text-secondary hover:text-primary" title="Settings">
          ⚙
        </button>

        <button onClick={() => onToggleRight?.()} className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-accent to-purple-500 text-white hover:from-accent-hover text-base" title="AI">
          ⚡
        </button>
      </div>

      {/* Inline task form */}
      {showTaskForm && !formDefaultDate && (
        <div className="border-b border-border bg-surface px-4 py-2 shrink-0 max-h-[50vh] overflow-y-auto">
          <TaskForm onSubmit={handleCreateTask} onCancel={() => setShowTaskForm(false)} />
        </div>
      )}

      {/* Modal for day double-click */}
      <Modal
        isOpen={showTaskForm && !!formDefaultDate}
        onClose={() => { setShowTaskForm(false); setFormDefaultDate(null); }}
        title="Create Task"
      >
        <TaskForm
          onSubmit={handleCreateTask}
          onCancel={() => { setShowTaskForm(false); setFormDefaultDate(null); }}
          defaultDate={formDefaultDate?.toISOString().split("T")[0]}
        />
      </Modal>

      {/* Timeline Gantt-chart area or Kanban */}
      {kanbanMode ? (
        <KanbanBoard />
      ) : (
      <div className="flex" style={{ flex: 1, minHeight: 0 }}>
        {/* Middle category column: fixed 200px Y-axis labels */}
        <div className="shrink-0 border-r border-border/40 bg-surface overflow-y-auto" style={{ width: 200 }}>
          <div className="sticky top-0 z-10 h-10 border-b border-border/40 flex items-center px-3 bg-surface">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">Projects</span>
          </div>
          {hasTasks ? (
            Object.keys(tasksByProject).map((pid) => {
              const project = projects.find((p) => p.id === pid);
              const label = pid === "__none__" ? "No Project" : project?.name || "Unknown";
              const count = tasksByProject[pid].length;
              return (
                <div key={pid} className="flex items-center gap-2 border-b border-border/30 px-3" style={{ minHeight: 48 }}>
                  <div className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: project?.color || "var(--text-muted)" }} />
                  <span className="truncate text-xs font-medium text-secondary flex-1">{label}</span>
                  <span className="text-[10px] text-muted">{count}</span>
                </div>
              );
            })
          ) : (
            <div className="flex items-center justify-center px-3 py-8 text-xs text-muted">
              No tasks
            </div>
          )}
        </div>

        {/* Right timeline canvas */}
        <div className="flex flex-col" data-timeline-canvas style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
          <TimelineHeader days={days} />
          <div className="flex flex-col" data-timeline-body style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            <DndContext sensors={!isMobile ? sensors : undefined} onDragEnd={!isMobile ? handleDragEnd : undefined}>
              <div className="relative" style={{ minHeight: "100%" }}>
                <TimelineGrid days={days} />
                {hasTasks ? (
                  Object.entries(tasksByProject).map(([projectId, projectTasks]) => (
                    <TimelineLane
                      key={projectId}
                      tasks={projectTasks}
                      days={days}
                      onTaskClick={(id) => setSelectedTaskId(id)}
                      onDayDoubleClick={handleDayDoubleClick}
                    />
                  ))
                ) : (
                  <TimelineLane
                    tasks={[]}
                    days={days}
                    onDayDoubleClick={handleDayDoubleClick}
                  />
                )}
              </div>
            </DndContext>
          </div>
        </div>
      </div>
      )}

      {/* Task detail bottom panel */}
      {selectedTask && (
        <div className="shrink-0 border-t border-border bg-surface overflow-auto" style={{ maxHeight: "30vh" }}>
          <div className="px-4 py-3">
            <TaskDetail task={selectedTask} onClose={() => setSelectedTaskId(null)} />
          </div>
        </div>
      )}
    </div>
  );
}
