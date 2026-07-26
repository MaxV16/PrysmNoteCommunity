"use client";

import { useMemo, useCallback, useState } from "react";
import { DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { useAppStore, type NavFilter } from "@/stores/app-store";
import { useTimeline } from "@/hooks/useTimeline";
import { TimelineHeader } from "@/components/timeline/TimelineHeader";
import { TimelineGrid } from "@/components/timeline/TimelineGrid";
import { TimelineLane } from "@/components/timeline/TimelineLane";
import { TaskDetail } from "@/components/tasks/TaskDetail";
import { TaskForm } from "@/components/tasks/TaskForm";
import { Modal } from "@/components/ui/Modal";
import { useTasks } from "@/hooks/useTasks";

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
  viewDays: number;
  isMobile: boolean;
  rightOpen: boolean;
}

export function TimelineView({ viewDays, isMobile, rightOpen }: TimelineViewProps) {
  const { tasks, selectedTaskId, setSelectedTaskId, projects, navFilter, setNavFilter, selectedProjectId, selectedTagId } = useAppStore();
  const { visibleRange, scrollOffset, setScrollOffset } = useTimeline(14);
  const { createTask, updateTask } = useTasks();
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [formDefaultDate, setFormDefaultDate] = useState<Date | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const days = useMemo(() => {
    const result: Date[] = [];
    const current = new Date(visibleRange.start);
    for (let i = 0; i < viewDays; i++) {
      result.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
    return result;
  }, [visibleRange.start, viewDays]);

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
      const timelineEl = document.querySelector("[data-timeline-container]");
      const timelineWidth = timelineEl ? timelineEl.clientWidth : window.innerWidth;
      const dayWidth = timelineWidth / viewDays;
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
    [tasks, updateTask, viewDays]
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
    <div className="flex flex-col overflow-hidden bg-base">
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <div className="flex items-center gap-2">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          <h2 className="text-sm font-semibold text-primary hidden sm:block">Timeline</h2>
        </div>
        {filterBadge && (
          <span className="badge bg-accent/15 text-accent gap-1 text-[10px] px-2">
            {filterBadge}
            <button onClick={() => setNavFilter(null)} className="hover:text-primary p-0.5">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </span>
        )}
        {projectFilterName && (
          <span className="badge bg-blue-500/15 text-blue-400 gap-1 text-[10px] px-2">
            {projectFilterName}
            <button onClick={() => useAppStore.getState().setSelectedProjectId(null)} className="hover:text-primary p-0.5">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </span>
        )}
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <button onClick={handlePrevWeek} className="btn bg-elevated px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <button onClick={handleNextWeek} className="btn bg-elevated px-2 py-1 text-xs text-secondary hover:bg-hover hover:text-primary">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
        <button
          onClick={() => { setFormDefaultDate(null); setShowTaskForm(!showTaskForm); }}
          className="btn btn-primary px-3 py-1.5 text-xs gap-1.5"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          <span className="hidden sm:inline">New Task</span>
        </button>
      </div>

      {/* Inline task creation form */}
      {showTaskForm && !formDefaultDate && (
        <div className="border-b border-border bg-surface px-4 py-3 slide-up">
          <TaskForm onSubmit={handleCreateTask} onCancel={() => setShowTaskForm(false)} />
        </div>
      )}

      {/* Task creation modal (day double-click) */}
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

      {/* Timeline area */}
      <div className="flex-1 overflow-auto" data-timeline-container>
        <TimelineHeader days={days} />
        <DndContext sensors={!isMobile ? sensors : undefined} onDragEnd={!isMobile ? handleDragEnd : undefined}>
          <div className="relative">
            <TimelineGrid days={days} />
            {hasTasks ? (
              Object.entries(tasksByProject).map(([projectId, projectTasks]) => {
                const project = projects.find((p) => p.id === projectId);
                const label = projectId === "__none__" ? "No Project" : project?.name || "Unknown";
                return (
                  <TimelineLane
                    key={projectId}
                    label={label}
                    tasks={projectTasks}
                    days={days}
                    projectId={projectId}
                    onTaskClick={(id) => setSelectedTaskId(id)}
                    onDayDoubleClick={handleDayDoubleClick}
                  />
                );
              })
            ) : (
              <TimelineLane
                label=""
                tasks={[]}
                days={days}
                onDayDoubleClick={handleDayDoubleClick}
              />
            )}
            {!hasTasks && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center text-center pointer-events-none">
                <div className="flex flex-col items-center gap-3">
                  <span className="text-4xl">📋</span>
                  <p className="text-sm text-muted">No tasks scheduled</p>
                  <p className="text-xs text-muted">Double-click a day column or create a task to get started</p>
                </div>
              </div>
            )}
          </div>
        </DndContext>
      </div>

      {/* Task detail panel */}
      {selectedTask && (
        <div className="border-t border-border bg-surface slide-up" style={{ maxHeight: "40vh", overflow: "auto" }}>
          <div className="px-4 py-3">
            <TaskDetail task={selectedTask} onClose={() => setSelectedTaskId(null)} />
          </div>
        </div>
      )}
    </div>
  );
}