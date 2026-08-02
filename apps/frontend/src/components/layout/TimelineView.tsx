"use client";

import { useMemo, useCallback, useState, useEffect, useRef } from "react";
import { DndContext, type DragEndEvent, type DragMoveEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { useAppStore, type NavFilter } from "@/stores/app-store";
import { useTimeline } from "@/hooks/useTimeline";
import { TimelineHeader } from "@/components/timeline/TimelineHeader";
import { TimelineGrid } from "@/components/timeline/TimelineGrid";
import { TimelineLane } from "@/components/timeline/TimelineLane";
import { TaskDetailDrawer } from "@/components/tasks/TaskDetailDrawer";
import { TaskForm } from "@/components/tasks/TaskForm";
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { CalendarView } from "@/components/calendar/CalendarView";
import { ListView } from "@/components/list/ListView";
import { Modal } from "@/components/ui/Modal";
import { PopoverMenu } from "@/components/ui/PopoverMenu";
import { useTasks } from "@/hooks/useTasks";
import { useUiModule } from "@/lib/ui-module-registry";
import { useLocalBool } from "@/lib/use-local-bool";
import { useRouter } from "next/navigation";
import { parseLocalDate, toLocalDateString } from "@/lib/utils";
import { DAY_WIDTH } from "@/components/timeline/constants";

// How many days to prepend/append per expansion step.
const EXPAND_STEP = 7;

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
  hideProjects?: boolean;
}

export function TimelineView({ onToggleRight, onOpenSticky, hideProjects = false }: TimelineViewProps) {
  const { tasks, selectedTaskId, setSelectedTaskId, projects, navFilter, setNavFilter, selectedProjectId, selectedTagId, searchQuery, setSearchQuery } = useAppStore();
  const { visibleRange, viewDays, expandBackward, expandForward } = useTimeline(20, 10);
  const { createTask, updateTask } = useTasks();
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [formDefaultDate, setFormDefaultDate] = useState<Date | null>(null);
  const [viewMode, setViewMode] = useState<"timeline" | "kanban" | "calendar" | "list">("timeline");
  const [viewDropdownOpen, setViewDropdownOpen] = useState(false);
  const viewButtonRef = useRef<HTMLButtonElement | null>(null);
  const router = useRouter();
  const bodyRef = useRef<HTMLDivElement>(null);
  const timelineOn = useUiModule("viewTimeline");
  const kanbanOn = useUiModule("viewKanban") && useLocalBool("prysm_feature_kanban", true);
  const calendarOn = useUiModule("viewCalendar") && useLocalBool("prysm_feature_calendar", true);
  const listOn = useUiModule("viewList");
  const projectRailOn = useUiModule("projectRail");
  const stickyOn = useUiModule("stickyNotes");

  const viewModules: Record<"timeline" | "kanban" | "calendar" | "list", boolean> = {
    timeline: timelineOn,
    kanban: kanbanOn,
    calendar: calendarOn,
    list: listOn,
  };
  const enabledViews = (Object.keys(viewModules) as ("timeline" | "kanban" | "calendar" | "list")[]).filter((v) => viewModules[v]);
  const activeViewEnabled = viewModules[viewMode];

  useEffect(() => {
    if (!activeViewEnabled && enabledViews.length > 0) {
      setViewMode(enabledViews[0]);
    }
  }, [activeViewEnabled, enabledViews.length]);

  useEffect(() => {
    const onNewTask = () => {
      setFormDefaultDate(null);
      setShowTaskForm(true);
    };
    window.addEventListener("prysm-new-task", onNewTask);
    return () => window.removeEventListener("prysm-new-task", onNewTask);
  }, []);

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
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      activeTasks = activeTasks.filter(
        (t) => t.title.toLowerCase().includes(q) || (t.description && t.description.toLowerCase().includes(q))
      );
    }
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
  }, [tasks, navFilter, selectedProjectId, selectedTagId, searchQuery]);

  const monthLabel = useMemo(() => {
    const mid = new Date(visibleRange.start);
    mid.setDate(mid.getDate() + Math.floor(viewDays / 2));
    return mid.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }, [visibleRange.start, viewDays]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || viewMode !== "timeline") return;
    // Position "today" (column baseLeftOffset) at the left edge, leaving room to
    // browse backwards before expansion kicks in.
    body.scrollLeft = 10 * DAY_WIDTH;
  }, [viewMode]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || viewMode !== "timeline") return;
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    const handleScroll = () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const threshold = DAY_WIDTH * 1.5;
        if (body.scrollLeft < threshold) {
          // Prepend days on the left; the viewport must shift right by exactly the
          // number of added columns to stay visually anchored (no jump).
          body.scrollLeft += EXPAND_STEP * DAY_WIDTH;
          expandBackward(EXPAND_STEP);
        }
        if (body.scrollLeft + body.clientWidth > body.scrollWidth - threshold) {
          expandForward(EXPAND_STEP);
        }
      }, 60);
    };
    body.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      body.removeEventListener("scroll", handleScroll);
      if (scrollTimer) clearTimeout(scrollTimer);
    };
  }, [expandBackward, expandForward, viewMode]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, delta } = event;
      if (!active) return;
      const taskId = active.id as string;
      // Each day column is a fixed width in the infinite timeline.
      const dayWidth = DAY_WIDTH;
      const daysShifted = Math.round(delta.x / dayWidth);
      if (daysShifted === 0) return;
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;
      const fields: Record<string, string> = {};
      if (task.start_date) {
        const d = parseLocalDate(task.start_date);
        d.setDate(d.getDate() + daysShifted);
        fields.start_date = toLocalDateString(d);
      }
      if (task.due_date) {
        const d = parseLocalDate(task.due_date);
        d.setDate(d.getDate() + daysShifted);
        fields.due_date = toLocalDateString(d);
      }
      if (!task.start_date && !task.due_date) return;
      await updateTask(taskId, fields);
    },
    [tasks, updateTask]
  );

  // Expand the timeline forward/backward while dragging a task near the left or
  // right edge, so the canvas feels infinite. Works alongside dnd-kit autoScroll.
  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const body = bodyRef.current;
      if (!body) return;
      const edgeZone = DAY_WIDTH * 1.5;
      const dragX = body.clientWidth / 2 + event.delta.x;

      // Near the right edge → grow forward and scroll right to reveal the new days.
      if (dragX > body.clientWidth - edgeZone) {
        const remaining = body.scrollWidth - (body.scrollLeft + body.clientWidth);
        if (remaining < edgeZone) {
          expandForward(EXPAND_STEP);
          body.scrollLeft += EXPAND_STEP * DAY_WIDTH;
        }
      }

      // Near the left edge → grow backward and keep the view anchored.
      if (dragX < edgeZone && body.scrollLeft <= EXPAND_STEP * DAY_WIDTH) {
        expandBackward(EXPAND_STEP);
        body.scrollLeft = Math.max(0, body.scrollLeft + EXPAND_STEP * DAY_WIDTH);
      }
    },
    [expandBackward, expandForward]
  );

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

  const hasTasks = Object.keys(tasksByProject).length > 0;

  const viewModeLabel = viewMode === "timeline" ? "Timeline" : viewMode === "kanban" ? "Kanban" : viewMode === "calendar" ? "Calendar" : "List";

  return (
    <div className="flex flex-col bg-base" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 shrink-0 overflow-x-auto">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span className="text-lg font-bold text-primary mr-2 hidden md:block">{viewModeLabel}</span>

        {filterBadge && (
          <span className="inline-flex items-center gap-1 bg-accent/15 text-accent text-[10px] px-2 py-0.5 rounded shrink-0">
            {filterBadge}
            <button onClick={() => setNavFilter(null)} className="hover:text-primary">✕</button>
          </span>
        )}

        <input
          id="global-search"
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search… (⌘F)"
          className="input-field text-xs w-32 sm:w-40 lg:w-48 px-2.5 shrink min-w-0"
        />

        <div className="flex-1" />

        {viewMode === "timeline" && (
          <span className="hidden lg:inline-flex text-xs font-medium text-muted bg-elevated px-3 py-1.5 rounded-full shrink-0">{monthLabel}</span>
        )}

        <div className="shrink-0">
          <button
            ref={viewButtonRef}
            onClick={() => setViewDropdownOpen(v => !v)}
            className="btn bg-elevated border border-border text-xs px-3 py-1.5 rounded-full text-secondary hover:text-primary inline-flex items-center gap-1.5"
            aria-haspopup="menu"
            aria-expanded={viewDropdownOpen}
            data-testid="view-mode-toggle"
          >
            {viewModeLabel}
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
          </button>
          <PopoverMenu
            open={viewDropdownOpen}
            triggerRef={viewButtonRef}
            align="right"
            onClose={() => setViewDropdownOpen(false)}
            className="w-40"
          >
            {timelineOn && (
              <button
                onClick={() => { setViewMode("timeline"); setViewDropdownOpen(false); }}
                className={`block w-full px-4 py-2 text-left text-xs transition-colors hover:bg-hover ${viewMode === "timeline" ? "text-accent font-semibold" : "text-secondary"}`}
              >
                Timeline
              </button>
            )}
            {kanbanOn && (
              <button
                onClick={() => { setViewMode("kanban"); setViewDropdownOpen(false); }}
                className={`block w-full px-4 py-2 text-left text-xs transition-colors hover:bg-hover ${viewMode === "kanban" ? "text-accent font-semibold" : "text-secondary"}`}
              >
                Kanban
              </button>
            )}
            {calendarOn && (
              <button
                onClick={() => { setViewMode("calendar"); setViewDropdownOpen(false); }}
                className={`block w-full px-4 py-2 text-left text-xs transition-colors hover:bg-hover ${viewMode === "calendar" ? "text-accent font-semibold" : "text-secondary"}`}
              >
                Calendar
              </button>
            )}
            {listOn && (
              <button
                onClick={() => { setViewMode("list"); setViewDropdownOpen(false); }}
                className={`block w-full px-4 py-2 text-left text-xs transition-colors hover:bg-hover ${viewMode === "list" ? "text-accent font-semibold" : "text-secondary"}`}
              >
                List
              </button>
            )}
          </PopoverMenu>
        </div>

        {stickyOn && (
        <button onClick={onOpenSticky} className="btn bg-elevated border border-border text-xs px-3 py-1.5 rounded-full text-secondary hover:text-primary">
          Notes
        </button>
        )}

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

      {/* Main content area */}
      {viewMode === "kanban" ? (
        <KanbanBoard />
      ) : viewMode === "calendar" ? (
        <CalendarView />
      ) : viewMode === "list" ? (
        <ListView />
      ) : (
      <div className="flex" style={{ flex: 1, minHeight: 0 }}>
        {!hideProjects && projectRailOn && (
        <div className="hidden lg:block shrink-0 border-r border-border/40 bg-surface overflow-y-auto" style={{ width: 200 }}>
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
        )}

        {/* Right timeline canvas */}
        <div className="flex flex-col" data-timeline-canvas style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
          <div ref={bodyRef} className="flex flex-col" data-timeline-body style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            <DndContext sensors={sensors} onDragEnd={handleDragEnd} onDragMove={handleDragMove}>
              <div className="relative" style={{ minHeight: "100%", width: days.length * DAY_WIDTH }}>
                <TimelineHeader days={days} />
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

      {/* Task detail drawer */}
      {selectedTask && (
        <TaskDetailDrawer task={selectedTask} onClose={() => setSelectedTaskId(null)} />
      )}
    </div>
  );
}
