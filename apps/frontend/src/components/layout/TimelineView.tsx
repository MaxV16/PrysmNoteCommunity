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
import { DAY_WIDTH, BAR_HEIGHT, BAR_GAP, TOP_PADDING } from "@/components/timeline/constants";

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

export type TimelineViewMode = "timeline" | "kanban" | "calendar" | "list";

interface TimelineViewProps {
  onToggleRight?: () => void;
  onOpenSticky?: () => void;
  viewMode: TimelineViewMode;
  onViewModeChange: (m: TimelineViewMode) => void;
}

export function TimelineView({ onToggleRight, onOpenSticky, viewMode, onViewModeChange }: TimelineViewProps) {
  const { tasks, selectedTaskId, setSelectedTaskId, navFilter, setNavFilter, selectedTagId, searchQuery, setSearchQuery } = useAppStore();
  const { visibleRange, viewDays, setScrollOffset, expandBackward, expandForward } = useTimeline(20, 10);
  const { createTask, updateTask } = useTasks();
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [formDefaultDate, setFormDefaultDate] = useState<Date | null>(null);
  const [viewDropdownOpen, setViewDropdownOpen] = useState(false);
  const viewButtonRef = useRef<HTMLButtonElement | null>(null);
  const router = useRouter();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [panActive, setPanActive] = useState(false);
  const panStartRef = useRef<{ x: number; scrollLeft: number } | null>(null);
  const panCursorRef = useRef<"grab" | "grabbing">("grab");
  const timelineOn = useUiModule("viewTimeline");
  const kanbanModuleOn = useUiModule("viewKanban");
  const calendarModuleOn = useUiModule("viewCalendar");
  const kanbanLocalOn = useLocalBool("prysm_feature_kanban", true);
  const calendarLocalOn = useLocalBool("prysm_feature_calendar", true);
  const kanbanOn = kanbanModuleOn && kanbanLocalOn;
  const calendarOn = calendarModuleOn && calendarLocalOn;
  const listOn = useUiModule("viewList");
  const stickyOn = useUiModule("stickyNotes");

  const viewModules: Record<TimelineViewMode, boolean> = {
    timeline: timelineOn,
    kanban: kanbanOn,
    calendar: calendarOn,
    list: listOn,
  };
  const enabledViews = (Object.keys(viewModules) as TimelineViewMode[]).filter((v) => viewModules[v]);
  const activeViewEnabled = viewModules[viewMode];

  useEffect(() => {
    if (!activeViewEnabled && enabledViews.length > 0) {
      onViewModeChange(enabledViews[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- enabledViews is a
    // fresh filtered array each render; only the current mode/reset matter.
  }, [activeViewEnabled, enabledViews]);

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

  const visibleTasks = useMemo(() => {
    let activeTasks = applyNavFilter(
      // Keep completed tasks visible (they render semi-transparent & clickable in
      // TaskBar) instead of hiding them when a task is marked done.
      tasks.filter((t) => t.status !== "cancelled" && !t.is_archived),
      navFilter
    );
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      activeTasks = activeTasks.filter(
        (t) => t.title.toLowerCase().includes(q) || (t.description && t.description.toLowerCase().includes(q))
      );
    }
    if (selectedTagId) {
      activeTasks = activeTasks.filter((t) => t.tags?.some((tag) => tag.id === selectedTagId));
    }
    return activeTasks;
  }, [tasks, navFilter, selectedTagId, searchQuery]);

  const monthLabel = useMemo(() => {
    const mid = new Date(visibleRange.start);
    mid.setDate(mid.getDate() + Math.floor(viewDays / 2));
    return mid.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }, [visibleRange.start, viewDays]);

  // Period navigation: shift the visible window by a page of days and keep the
  // view anchored by translating the canvas scroll position to match.
  const navigatePeriod = useCallback((dir: "prev" | "next" | "today") => {
    const body = bodyRef.current;
    const step = Math.max(7, viewDays);
    if (dir === "prev") {
      setScrollOffset((s) => s - step);
      if (body) body.scrollLeft += step * DAY_WIDTH;
    } else if (dir === "next") {
      setScrollOffset((s) => s + step);
      if (body) body.scrollLeft -= step * DAY_WIDTH;
    } else {
      setScrollOffset(-10);
      if (body) body.scrollLeft = 10 * DAY_WIDTH;
    }
  }, [setScrollOffset, viewDays]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || safeMode !== "timeline") return;
    // Position "today" (column baseLeftOffset) at the left edge, leaving room to
    // browse backwards before expansion kicks in.
    body.scrollLeft = 10 * DAY_WIDTH;
  }, [viewMode]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || safeMode !== "timeline") return;
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

  // Keep the timeline canvas at least as wide as its container so there is no
  // dead/empty region on the right of the last rendered day. Grows forward to
  // match the visible width on mount and on resize.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || safeMode !== "timeline") return;
    const fill = () => {
      const need = Math.ceil(body.clientWidth / DAY_WIDTH) + 2;
      const has = days.length;
      if (has < need) {
        expandForward(need - has);
      }
    };
    fill();
    const ro = new ResizeObserver(() => fill());
    ro.observe(body);
    return () => ro.disconnect();
  }, [days.length, expandForward, viewMode]);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, delta } = event;
      if (!active) return;
      const dragId = active.id as string;
      // Each day column is a fixed width in the infinite timeline. A tiny drag
      // still counts as at least one day so it never feels like a dead snap-back.
      const dayWidth = DAY_WIDTH;
      const whole = Math.round(delta.x / dayWidth);
      const daysShifted = delta.x === 0 ? 0 : (whole === 0 ? Math.sign(delta.x) : whole);
      if (daysShifted === 0) return;

      // Resize: dragging a left/right bar handle extends the task's start/due
      // date so it spans multiple days. id format: "<taskId>:left|right".
      const resizeMatch = dragId.match(/^(.+):(left|right)$/);
      if (resizeMatch) {
        const [, resizeTaskId, side] = resizeMatch;
        const task = tasks.find((t) => t.id === resizeTaskId);
        if (!task) return;
        const fields: Record<string, string> = {};
        if (side === "left") {
          const start = task.start_date ? parseLocalDate(task.start_date) : (task.due_date ? parseLocalDate(task.due_date) : new Date());
          const d = new Date(start);
          d.setDate(d.getDate() + daysShifted);
          fields.start_date = toLocalDateString(d);
          // An undated task grabbed by its left edge: only a start date is set
          // (single-day bar); if it had only a due date, extending left expands
          // backward from that due date.
          if (!task.start_date && task.due_date) {
            // keep due_date as-is (span backward) — start already set above.
          }
        } else {
          const end = task.due_date ? parseLocalDate(task.due_date) : (task.start_date ? parseLocalDate(task.start_date) : new Date());
          const d = new Date(end);
          d.setDate(d.getDate() + daysShifted);
          fields.due_date = toLocalDateString(d);
        }
        const store = useAppStore.getState();
        store.setTasks(
          store.tasks.map((t) => (t.id === resizeTaskId ? { ...t, ...fields } : t))
        );
        await updateTask(resizeTaskId, fields);
        return;
      }

      const taskId = dragId;
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
      // A partially/completely undated task dropped onto the timeline: assign it
      // the date of the day it landed on (drags start from the "today" column).
      if (!task.start_date && !task.due_date) {
        const t = new Date();
        t.setDate(t.getDate() + daysShifted);
        fields.start_date = toLocalDateString(t);
        fields.due_date = toLocalDateString(t);
      }
      // Optimistically update the store so the bar visibly snaps to its new day
      // immediately (no waiting on the server round-trip), keeping the UI in sync
      // with the drag even if the refetch is slow.
      const store = useAppStore.getState();
      store.setTasks(
        store.tasks.map((t) => (t.id === taskId ? { ...t, ...fields } : t))
      );
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

  // Drag-to-pan the timeline: grabbing empty space and dragging scrolls the
  // canvas horizontally (like a map). Only starts when the pointer goes down on
  // empty space, never on a task bar (which starts a task drag) or on the grid's
  // interactive day cells (which handle double-click-to-add).
  const onTimelinePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const body = bodyRef.current;
      if (!body || e.button !== 0) return;
      const target = e.target as HTMLElement;
      // Never pan from an interactive element (task bars, resize handles, buttons, inputs).
      if (target.closest("[data-task-bar], [data-resize-handle], button, input, select, textarea, a, [data-day-column]")) {
        return;
      }
      panStartRef.current = { x: e.clientX, scrollLeft: body.scrollLeft };
      panCursorRef.current = "grabbing";
      setPanActive(true);
    },
    []
  );

  const onTimelinePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const body = bodyRef.current;
      const start = panStartRef.current;
      if (!body || !start) return;
      const dx = e.clientX - start.x;
      body.scrollLeft = start.scrollLeft - dx;
    },
    []
  );

  const onTimelinePointerUp = useCallback(() => {
    panStartRef.current = null;
    panCursorRef.current = "grab";
    setPanActive(false);
  }, []);

  const handleCreateTask = useCallback(
    async (data: {
      title: string; description?: string; start_date?: string; due_date?: string;
      status?: string; priority?: number;
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

  const hasTasks = visibleTasks.length > 0;

  // Timeline is a single lane: all visible tasks stack vertically in one row.
  const rowTaskCount = visibleTasks.length;
  const laneHeight = TOP_PADDING * 2 + Math.max(1, rowTaskCount) * (BAR_HEIGHT + BAR_GAP) - BAR_GAP;

  // Guard against a corrupt/unexpected viewMode: only render a sub-view when it is
  // one of the known values, otherwise fall back to the timeline branch.
  const safeMode: TimelineViewMode = viewModules[viewMode] ? viewMode : "timeline";

  const viewModeLabel = safeMode === "timeline" ? "Timeline" : safeMode === "kanban" ? "Kanban" : safeMode === "calendar" ? "Calendar" : "List";

  return (
    <div className="flex flex-col bg-base" style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
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

        {safeMode === "timeline" && (
          <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-elevated p-0.5">
            <button
              onClick={() => navigatePeriod("prev")}
              aria-label="Previous period"
              className="flex h-6 w-6 items-center justify-center rounded-full text-secondary hover:bg-hover hover:text-primary"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button
              onClick={() => navigatePeriod("today")}
              className="rounded-full px-2 py-0.5 text-[11px] font-medium text-secondary transition-colors hover:bg-hover hover:text-primary"
              title="Go to today"
            >
              Today
            </button>
            <button
              onClick={() => navigatePeriod("next")}
              aria-label="Next period"
              className="flex h-6 w-6 items-center justify-center rounded-full text-secondary hover:bg-hover hover:text-primary"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            <span className="mx-1 hidden text-xs font-medium text-muted lg:inline">{monthLabel}</span>
          </div>
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
                onClick={() => { onViewModeChange("timeline"); setViewDropdownOpen(false); }}
                className={`block w-full px-4 py-2 text-left text-xs transition-colors hover:bg-hover ${viewMode === "timeline" ? "text-accent font-semibold" : "text-secondary"}`}
              >
                Timeline
              </button>
            )}
            {kanbanOn && (
              <button
                onClick={() => { onViewModeChange("kanban"); setViewDropdownOpen(false); }}
                className={`block w-full px-4 py-2 text-left text-xs transition-colors hover:bg-hover ${viewMode === "kanban" ? "text-accent font-semibold" : "text-secondary"}`}
              >
                Kanban
              </button>
            )}
            {calendarOn && (
              <button
                onClick={() => { onViewModeChange("calendar"); setViewDropdownOpen(false); }}
                className={`block w-full px-4 py-2 text-left text-xs transition-colors hover:bg-hover ${viewMode === "calendar" ? "text-accent font-semibold" : "text-secondary"}`}
              >
                Calendar
              </button>
            )}
            {listOn && (
              <button
                onClick={() => { onViewModeChange("list"); setViewDropdownOpen(false); }}
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
      {safeMode === "kanban" ? (
        <KanbanBoard />
      ) : safeMode === "calendar" ? (
        <CalendarView />
      ) : safeMode === "list" ? (
        <ListView />
      ) : (
      <div className="flex" style={{ flex: 1, minHeight: 0 }}>
        {/* Single timeline canvas: all tasks render in one lane */}
        <div className="relative flex flex-col" data-timeline-canvas style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
          <div
            ref={bodyRef}
            className="relative flex flex-col"
            data-timeline-body
            style={{
              flex: 1,
              overflow: "auto",
              minHeight: 0,
              cursor: panActive ? "grabbing" : "grab",
              userSelect: panActive ? "none" : undefined,
            }}
            onPointerDown={onTimelinePointerDown}
            onPointerMove={onTimelinePointerMove}
            onPointerUp={onTimelinePointerUp}
            onPointerLeave={onTimelinePointerUp}
          >
            <DndContext sensors={sensors} onDragEnd={handleDragEnd} onDragMove={handleDragMove}>
              <div className="relative" style={{ minHeight: "100%", width: days.length * DAY_WIDTH }}>
                <TimelineHeader days={days} />
                <TimelineGrid days={days} />
                <TimelineLane
                  tasks={visibleTasks}
                  days={days}
                  rowHeight={laneHeight}
                  onTaskClick={(id) => setSelectedTaskId(id)}
                  onDayDoubleClick={handleDayDoubleClick}
                />
              </div>
            </DndContext>
          </div>

          {!hasTasks && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4">
              <div className="pointer-events-auto max-w-sm rounded-2xl border border-border/60 bg-surface/85 p-6 text-center backdrop-blur-sm">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                </div>
                <p className="mt-3 text-sm font-semibold text-primary">A clean calendar — for now</p>
                <p className="mt-1 text-xs leading-relaxed text-secondary">
                  No tasks match this view yet. Create a task to see it appear on its day, or double-click a date to plan there.
                </p>
                <button
                  onClick={() => { setFormDefaultDate(null); setShowTaskForm(true); }}
                  className="mt-4 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover"
                >
                  Create a task
                </button>
              </div>
            </div>
          )}
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
