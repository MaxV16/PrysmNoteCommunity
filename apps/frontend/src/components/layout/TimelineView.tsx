"use client";

import { useMemo, useCallback, useState, useEffect, useRef } from "react";
import { DndContext, type DragEndEvent, type DragMoveEvent, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import { useAppStore, type NavFilter } from "@/stores/app-store";
import { useTimeline } from "@/hooks/useTimeline";
import { todayISO, todayStart } from "@/lib/dates";
import { TimelineHeader } from "@/components/timeline/TimelineHeader";
import { TimelineGrid } from "@/components/timeline/TimelineGrid";
import { TimelineLane } from "@/components/timeline/TimelineLane";
import { TaskDetailDrawer } from "@/components/tasks/TaskDetailDrawer";
import { TaskForm } from "@/components/tasks/TaskForm";
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { CalendarView } from "@/components/calendar/CalendarView";
import { ListView } from "@/components/list/ListView";
import { BoardView } from "@/components/board/BoardView";
import { Modal } from "@/components/ui/Modal";
import { PopoverMenu } from "@/components/ui/PopoverMenu";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { TaskContextMenu, type ContextMenuState } from "@/components/tasks/TaskContextMenu";
import { useTasks } from "@/hooks/useTasks";
import { useBatchDelete } from "@/hooks/useBatchDelete";
import { api } from "@/lib/api";
import { useUiModule } from "@/lib/ui-module-registry";
import { useLocalBool } from "@/lib/use-local-bool";
import { useRouter } from "next/navigation";
import { parseLocalDate, toLocalDateString } from "@/lib/utils";
import type { Task } from "@/types/task";
import { useResponsiveDayWidth } from "@/components/timeline/constants";
import { PREF_DEFAULT_VIEW } from "@/lib/preferences";
import { usePreferencesStore } from "@/stores/preferences-store";
import { openNotesWindow } from "@/lib/notes";
import { matchesSearchQuery } from "@/lib/task-search";
import { useMediaQuery } from "@/lib/use-media-query";
import { useToast } from "@/lib/toast-context";
import { SelectionActionBar } from "@/components/tasks/SelectionActionBar";
import { useTimelineSections } from "@/hooks/useTimelineSections";
import type { TimelineSection } from "@/hooks/useTimelineSections";
import { TimelineSectionsLayer, SECTION_DROPPABLE_PREFIX } from "@/components/timeline/TimelineSectionsLayer";

// How many days to prepend/append per expansion step.
const EXPAND_STEP = 7;

function isToday(dateStr: string | null): boolean {
  if (!dateStr) return false;
  return dateStr === todayISO();
}

function isWithinNext7Days(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const today = todayISO();
  const start = new Date(`${today}T00:00:00`);
  const weekLater = new Date(start);
  weekLater.setDate(weekLater.getDate() + 7);
  const d = new Date(`${dateStr}T00:00:00`);
  return d >= start && d <= weekLater;
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
    case "all":
      return tasks;
    case "completed":
      return tasks.filter((t) => t.status === "done");
  }
}

export type TimelineViewMode = "timeline" | "kanban" | "calendar" | "list" | "board";

interface TimelineViewProps {
  onToggleRight?: () => void;
  onOpenSidebar?: () => void;
  viewMode: TimelineViewMode;
  onViewModeChange: (m: TimelineViewMode) => void;
}

export function TimelineView({ onToggleRight, onOpenSidebar, viewMode, onViewModeChange }: TimelineViewProps) {
  const { tasks, selectedTaskId, setSelectedTaskId, selectedTaskIds, navFilter, setNavFilter, selectedTagId, searchQuery, setSearchQuery, activeListId, lists } = useAppStore();
  const { visibleRange, viewDays, setScrollOffset, expandBackward, expandForward } = useTimeline(20, 10);
  const { createTask, updateTask, fetchRange } = useTasks();
  const { busy: batchDeleting, softDeleteWithUndo } = useBatchDelete();
  const { showToast } = useToast();
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [formDefaultDate, setFormDefaultDate] = useState<Date | null>(null);
  const [menu, setMenu] = useState<{ state: ContextMenuState; x: number; y: number } | null>(null);
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
  const boardOn = useUiModule("viewBoard");
  const stickyOn = useUiModule("stickyNotes");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [sectionsOn, setSectionsOn] = useState(false);
  const sectionsButtonRef = useRef<HTMLButtonElement | null>(null);
  const [sectionsDropdownOpen, setSectionsDropdownOpen] = useState(false);
  const { sections, addSection, renameSection, removeSection } = useTimelineSections();
  const tags = useAppStore((s) => s.tags);

  // Mobile: drag-to-reschedule and drag-to-pan fight the touch scroll gesture,
  // so both are disabled on small screens (tap-to-open + check-off still work).
  const smallScreen = useMediaQuery("(max-width: 767px)");

  // Responsive column width: ~5-6 days visible on phones (clamp 56..120px).
  const dayWidth = useResponsiveDayWidth();

  const defaultView = usePreferencesStore(
    (s) => (s.prefs[PREF_DEFAULT_VIEW] as TimelineViewMode) || "timeline"
  );
  const setPreference = usePreferencesStore((s) => s.setPreference);

  const viewModules: Record<TimelineViewMode, boolean> = {
    timeline: timelineOn,
    kanban: kanbanOn,
    calendar: calendarOn,
    list: listOn,
    board: boardOn,
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
    if (activeListId) {
      activeTasks = activeTasks.filter((t) => t.list_id === activeListId);
    }
    if (searchQuery) {
      activeTasks = activeTasks.filter((t) => matchesSearchQuery(t, searchQuery));
    }
    if (selectedTagId) {
      activeTasks = activeTasks.filter((t) => t.tags?.some((tag) => tag.id === selectedTagId));
    }
    return activeTasks;
  }, [tasks, navFilter, activeListId, selectedTagId, searchQuery]);

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
      if (body) body.scrollLeft += step * dayWidth;
    } else if (dir === "next") {
      setScrollOffset((s) => s + step);
      if (body) body.scrollLeft -= step * dayWidth;
    } else {
      setScrollOffset(-10);
      if (body) body.scrollLeft = 10 * dayWidth;
    }
  }, [setScrollOffset, viewDays, dayWidth]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || safeMode !== "timeline") return;
    // Position "today" (column baseLeftOffset) at the left edge, leaving room to
    // browse backwards before expansion kicks in.
    body.scrollLeft = 10 * dayWidth;
  }, [viewMode, dayWidth]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || safeMode !== "timeline") return;
    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    const handleScroll = () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const threshold = dayWidth * 1.5;
        if (body.scrollLeft < threshold) {
          // Prepend days on the left; the viewport must shift right by exactly the
          // number of added columns to stay visually anchored (no jump).
          body.scrollLeft += EXPAND_STEP * dayWidth;
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
  }, [expandBackward, expandForward, viewMode, dayWidth]);

  // Keep the timeline canvas at least as wide as its container so there is no
  // dead/empty region on the right of the last rendered day. Grows forward to
  // match the visible width on mount and on resize.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || safeMode !== "timeline") return;
    const fill = () => {
      const need = Math.ceil(body.clientWidth / dayWidth) + 2;
      const has = days.length;
      if (has < need) {
        expandForward(need - has);
      }
    };
    fill();
    const ro = new ResizeObserver(() => fill());
    ro.observe(body);
    return () => ro.disconnect();
  }, [days.length, expandForward, viewMode, dayWidth]);

  // Timeline sections: splitting at the 50% handle creates a new nameable band
  // (start 50% -> end 100%). Naming/coloring/rule editing happens inline on the
  // band itself; deleting a band just removes the display layer.
  const handleSplit = useCallback(async () => {
    try {
      await addSection({
        name: `Section ${sections.length + 1}`,
        color: undefined,
        start_pct: 50,
        end_pct: 100,
        rule_kind: "all",
      });
      showToast("Timeline section created", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not create the section", "error");
    }
  }, [addSection, sections.length, showToast]);

  const applySectionRule = useCallback(
    async (taskId: string, section: TimelineSection) => {
      const kind = section.rule_kind;
      const value = section.rule_value;
      if (!kind || kind === "all" || !value) return;
      const patch: Record<string, unknown> = {};
      if (kind === "list") {
        patch.list_id = value;
      } else if (kind === "tag") {
        await api.post(`/tags/tasks/${taskId}?tag_id=${value}`);
        showToast("Tag applied to the task", "success");
        return;
      } else if (kind === "priority") {
        patch.priority = parseInt(value.split(",")[0], 10);
      } else if (kind === "status") {
        patch.status = value;
      }
      await updateTask(taskId, patch);
      showToast("Section rule applied to the task", "success");
    },
    [updateTask, showToast]
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, delta, over } = event;
      if (!active) return;
      const dragId = active.id as string;

      // Dropping a task onto a section BAND applies that band's rule to the
      // task (priority/status/list/tag) instead of rescheduling it. The band
      // is registered as a droppable with id "section:<id>".
      if (over && typeof over.id === "string" && over.id.startsWith(SECTION_DROPPABLE_PREFIX) && !dragId.includes(":")) {
        const sectionId = over.id.slice(SECTION_DROPPABLE_PREFIX.length);
        const section = sections.find((s) => s.id === sectionId);
        if (section) {
          await applySectionRule(dragId, section);
        }
        return;
      }

      // Each day column is a fixed width in the infinite timeline. A tiny drag
      // still counts as at least one day so it never feels like a dead snap-back.
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
            // keep due_date as-is (span backward) - start already set above.
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

      const selectedIds = useAppStore.getState().selectedTaskIds;
      if (selectedIds.length > 1 && selectedIds.includes(taskId)) {
        // Multi-drag: shift every selected bar by the same delta, exactly like
        // the single-task path below, then persist via one batch-reschedule.
        const store = useAppStore.getState();
        const previous = store.tasks;
        const fieldsByTask = new Map<string, Record<string, string>>();
        for (const id of selectedIds) {
          const t = store.tasks.find((x) => x.id === id);
          if (!t) continue;
          const f: Record<string, string> = {};
          if (t.start_date) {
            const d = parseLocalDate(t.start_date);
            d.setDate(d.getDate() + daysShifted);
            f.start_date = toLocalDateString(d);
          }
          if (t.due_date) {
            const d = parseLocalDate(t.due_date);
            d.setDate(d.getDate() + daysShifted);
            f.due_date = toLocalDateString(d);
          }
          if (!t.start_date && !t.due_date) {
            const d = new Date();
            d.setDate(d.getDate() + daysShifted);
            f.start_date = toLocalDateString(d);
            f.due_date = toLocalDateString(d);
          }
          fieldsByTask.set(id, f);
        }
        store.setTasks(
          store.tasks.map((t) =>
            fieldsByTask.has(t.id) ? { ...t, ...fieldsByTask.get(t.id) } : t
          )
        );
        try {
          await api.post("/tasks/batch-reschedule", {
            task_ids: selectedIds,
            delta_days: daysShifted,
          });
        } catch {
          store.setTasks(previous);
        }
        return;
      }

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
    [tasks, updateTask, dayWidth, sections, applySectionRule]
  );

  // Expand the timeline forward/backward while dragging a task near the left or
  // right edge, so the canvas feels infinite. Works alongside dnd-kit autoScroll.
  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      const body = bodyRef.current;
      if (!body) return;
      const edgeZone = dayWidth * 1.5;
      const dragX = body.clientWidth / 2 + event.delta.x;

      // Near the right edge → grow forward and scroll right to reveal the new days.
      if (dragX > body.clientWidth - edgeZone) {
        const remaining = body.scrollWidth - (body.scrollLeft + body.clientWidth);
        if (remaining < edgeZone) {
          expandForward(EXPAND_STEP);
          body.scrollLeft += EXPAND_STEP * dayWidth;
        }
      }

      // Near the left edge → grow backward and keep the view anchored.
      if (dragX < edgeZone && body.scrollLeft <= EXPAND_STEP * dayWidth) {
        expandBackward(EXPAND_STEP);
        body.scrollLeft = Math.max(0, body.scrollLeft + EXPAND_STEP * dayWidth);
      }
    },
    [expandBackward, expandForward, dayWidth]
  );

  // Drag-to-pan the timeline: grabbing empty space and dragging scrolls the
  // canvas horizontally (like a map). Only starts when the pointer goes down on
  // empty space, never on a task bar (which starts a task drag) or on the grid's
  // interactive day cells (which handle double-click-to-add).
  const onTimelinePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const body = bodyRef.current;
      if (!body || e.button !== 0) return;
      if (smallScreen) return;
      const target = e.target as HTMLElement;
      // Never pan from an interactive element (task bars, resize handles, buttons, inputs).
      if (target.closest("[data-task-bar], [data-resize-handle], button, input, select, textarea, a, [data-day-column]")) {
        return;
      }
      useAppStore.getState().clearTaskSelection();
      panStartRef.current = { x: e.clientX, scrollLeft: body.scrollLeft };
      panCursorRef.current = "grabbing";
      setPanActive(true);
    },
    [smallScreen]
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
      start_time?: string; end_time?: string;
      status?: string; priority?: number;
      tag_ids?: string[]; recurrence_rule?: string; recurrence_end_date?: string; estimated_minutes?: number;
      list_id?: string;
    }) => {
      // New tasks from a list-filtered view land in that list, unless the form
      // explicitly picked a different list (the dropdown choice always wins).
      // Otherwise the backend assigns the default "My Tasks" list.
      try {
        await createTask({
          ...data,
          list_id: data.list_id ?? useAppStore.getState().activeListId ?? undefined,
        });
        setShowTaskForm(false);
        setFormDefaultDate(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not create the task. Try again.";
        showToast(message, "error");
      }
    },
    [createTask, showToast]
  );

  const handleDayDoubleClick = useCallback((day: Date) => {
    setFormDefaultDate(day);
    setShowTaskForm(true);
  }, []);

  // Right-click on a task bar opens the task context menu.
  const openTaskMenu = useCallback((e: React.MouseEvent, task: Task) => {
    setMenu({ state: { kind: "task", task }, x: e.clientX, y: e.clientY });
  }, []);

  // Right-click on an empty day cell opens a day-scoped new-task menu.
  const openDayMenu = useCallback((e: React.MouseEvent, day: Date) => {
    setMenu({ state: { kind: "empty", day: toLocalDateString(day) }, x: e.clientX, y: e.clientY });
  }, []);

  // Right-click on the plain timeline canvas (not a task bar, day cell or
  // interactive element) opens a bare new-task/new-note menu.
  const openCanvasMenu = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.closest(
        "[data-task-bar], [data-resize-handle], button, input, select, textarea, a, [data-day-column]"
      )
    ) {
      return;
    }
    setMenu({ state: { kind: "empty" }, x: e.clientX, y: e.clientY });
  }, []);

  // Empty-area "New task" reuses the existing form flow, pre-scoped to a day
  // when the menu was opened on one.
  const handleEmptyNewTask = useCallback(
    (ctx: { day?: string; section?: { id: string | null; title: string } }) => {
      setFormDefaultDate(ctx.day ? parseLocalDate(ctx.day) : null);
      setShowTaskForm(true);
    },
    []
  );

  // Mobile select mode + desktop floating bar share one batch delete flow.
  const handleBatchDelete = useCallback(async () => {
    const ids = useAppStore.getState().selectedTaskIds;
    if (ids.length === 0) return;
    const ok = await softDeleteWithUndo(ids);
    if (ok) {
      useAppStore.getState().clearTaskSelection();
      setSelectionMode(false);
    }
    // On failure keep the selection so the user can retry.
  }, [softDeleteWithUndo]);
  const selectedCount = selectedTaskIds.length;

  const filterBadge = navFilter
    ? navFilter === "inbox" ? "Inbox" : navFilter === "today" ? "Today" : "Next 7 Days"
    : activeListId
      ? lists.find((l) => l.id === activeListId)?.name || null
      : null;

  const hasTasks = visibleTasks.length > 0;

  // Lane height is driven by TimelineLane's computedHeight (the busiest-day
  // stack), never by the total visible-task count: a 3000-task import must not
  // stretch a single lane to ~144k px. TimelineLane keeps a sane minimum for
  // empty states.

  // Guard against a corrupt/unexpected viewMode: only render a sub-view when it is
  // one of the known values, otherwise fall back to the timeline branch.
  const safeMode: TimelineViewMode = viewModules[viewMode] ? viewMode : "timeline";

  // On mount, pre-expand the canvas to cover the full date range of all tasks
  // plus a buffer. This ensures a horizontal scrollbar appears when tasks exist
  // outside the initial 20-day window, so scroll-based expansion triggers.
  useEffect(() => {
    if (safeMode !== "timeline") return;
    const today = todayStart();
    let minDays = 0;
    let maxDays = 0;
    for (const t of tasks) {
      const ds = t.start_date || t.due_date;
      if (!ds) continue;
      const d = parseLocalDate(ds);
      if (Number.isNaN(d.getTime())) continue;
      const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
      if (diff < minDays) minDays = diff;
      if (diff > maxDays) maxDays = diff;
    }
    // Current window: scrollOffset=-10 at day 0 of days array, so leftmost
    // day offset = -10, rightmost = -10 + days.length.
    const currentLeftScroll = -10;
    const currentRightCount = currentLeftScroll + days.length;
    const targetLeftScroll = Math.min(currentLeftScroll, minDays - 14);
    const targetRightCount = Math.max(currentRightCount, maxDays + 14);
    if (targetLeftScroll < currentLeftScroll) {
      expandBackward(currentLeftScroll - targetLeftScroll);
    }
    if (targetRightCount > currentRightCount) {
      expandForward(targetRightCount - currentRightCount);
    }
  // Only run on mount (tasks list is stable after first render).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeMode]);

  // Lazy range fetch: when the expanded DOM window (plus a buffer) grows beyond
  // the store's loaded window, fetch the union so far dates are materialized on
  // demand (endless recurrences expand server-side) and bars appear without a
  // full reload. fetchRange itself skips already-covered windows.
  useEffect(() => {
    if (safeMode !== "timeline") return;
    const bufferDays = 30;
    const start = new Date(visibleRange.start);
    start.setDate(start.getDate() - bufferDays);
    const end = new Date(visibleRange.end);
    end.setDate(end.getDate() + bufferDays);
    const timer = setTimeout(() => {
      void fetchRange(toLocalDateString(start), toLocalDateString(end));
    }, 150);
    return () => clearTimeout(timer);
  }, [visibleRange, fetchRange, safeMode]);

  const viewModeLabel = safeMode === "timeline" ? "Timeline" : safeMode === "kanban" ? "Kanban" : safeMode === "calendar" ? "Calendar" : safeMode === "list" ? "List" : "Board";

  return (
    <div className="flex flex-col bg-base" style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      {/* Toolbar - wraps instead of clipping on narrow screens */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface px-3 py-2 shrink-0">
        {onOpenSidebar && (
          <button
            onClick={onOpenSidebar}
            className="pointer-coarse:h-11 pointer-coarse:w-11 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-secondary transition-colors hover:bg-hover hover:text-primary md:hidden"
            aria-label="Open sidebar"
            title="Menu"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
        )}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span className="text-lg font-bold text-primary mr-2 hidden md:block shrink-0">{viewModeLabel}</span>

        {filterBadge && (
          <span className="inline-flex items-center gap-1 bg-accent/15 text-accent text-[10px] px-2 py-0.5 rounded shrink-0">
            {filterBadge}
            <button onClick={() => setNavFilter(null)} className="hover:text-primary">✕</button>
          </span>
        )}

        <div className="flex shrink-0 items-center">
          <button
            onClick={() => {
              setSearchOpen(true);
              requestAnimationFrame(() => document.getElementById("global-search")?.focus());
            }}
            className="pointer-coarse:h-11 pointer-coarse:w-11 flex h-8 w-8 items-center justify-center rounded-full text-secondary transition-colors hover:bg-hover hover:text-primary"
            title="Search (⌘F)"
            aria-label="Search"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <path d="m21 21-4.35-4.35"/>
            </svg>
          </button>
          <input
            id="global-search"
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onFocus={() => setSearchOpen(true)}
            onBlur={() => { if (!searchQuery) setSearchOpen(false); }}
            placeholder="Search… (⌘F)"
            className={`h-8 shrink rounded-lg border px-2.5 text-xs text-primary outline-none transition-all duration-200 placeholder:text-muted focus:border-accent ${
              searchOpen
                ? "w-36 border-border bg-elevated sm:w-44 lg:w-56"
                : "w-0 border-transparent bg-transparent px-0 opacity-0"
            }`}
          />
        </div>

        <div className="flex-1 min-w-0" />

        {smallScreen && safeMode === "timeline" && (
          <button
            onClick={() => setSelectionMode((v) => !v)}
            className={`btn rounded-full border px-3 py-1.5 text-xs shrink-0 transition-colors ${
              selectionMode
                ? "bg-accent text-[var(--on-gradient)] border-transparent"
                : "bg-elevated border-border text-secondary hover:text-primary"
            }`}
            aria-pressed={selectionMode}
          >
            {selectionMode ? "Done" : "Select"}
          </button>
        )}

        {safeMode === "timeline" && (
          <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-elevated p-0.5">
            <button
              onClick={() => navigatePeriod("prev")}
              aria-label="Previous period"
              className="pointer-coarse:h-10 pointer-coarse:w-10 flex h-6 w-6 items-center justify-center rounded-full text-secondary hover:bg-hover hover:text-primary"
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
              className="pointer-coarse:h-10 pointer-coarse:w-10 flex h-6 w-6 items-center justify-center rounded-full text-secondary hover:bg-hover hover:text-primary"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            <span className="mx-1 hidden text-xs font-medium text-muted sm:inline">{monthLabel}</span>
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
            data-tour="view-switcher"
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
            {boardOn && (
              <button
                onClick={() => { onViewModeChange("board"); setViewDropdownOpen(false); }}
                className={`block w-full px-4 py-2 text-left text-xs transition-colors hover:bg-hover ${viewMode === "board" ? "text-accent font-semibold" : "text-secondary"}`}
              >
                Board
              </button>
            )}
            <div className="mt-1 border-t border-border pt-1">
              {defaultView === safeMode ? (
                <div className="flex w-full items-center px-4 py-2 text-xs text-muted">
                  <span>Default view</span>
                  <svg className="ml-auto text-accent" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                </div>
              ) : (
                <button
                  onClick={() => { setPreference(PREF_DEFAULT_VIEW, safeMode); setViewDropdownOpen(false); }}
                  data-testid="set-default-view"
                  className="block w-full px-4 py-2 text-left text-xs text-secondary transition-colors hover:bg-hover hover:text-primary"
                >
                  Set as default view
                </button>
              )}
            </div>
          </PopoverMenu>
        </div>

        {safeMode === "timeline" && (
          <div className="shrink-0">
            <button
              ref={sectionsButtonRef}
              onClick={() => setSectionsDropdownOpen(v => !v)}
              className={`btn border text-xs px-3 py-1.5 rounded-full inline-flex items-center gap-1.5 transition-colors ${
                sectionsOn
                  ? "bg-accent text-[var(--on-gradient)] border-transparent"
                  : "bg-elevated border-border text-secondary hover:text-primary"
              }`}
              aria-haspopup="menu"
              aria-expanded={sectionsDropdownOpen}
              data-testid="sections-toggle"
              data-tour="timeline-sections"
            >
              Sections
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>
            </button>
            <PopoverMenu
              open={sectionsDropdownOpen}
              triggerRef={sectionsButtonRef}
              align="right"
              onClose={() => setSectionsDropdownOpen(false)}
              className="w-52"
            >
              <div className="px-3 py-2 text-xs font-medium text-secondary">Timeline Sections</div>
              <button
                onClick={() => {
                  setSectionsOn(v => !v);
                  setSectionsDropdownOpen(false);
                }}
                className="flex w-full items-center justify-between px-3 py-2 text-left text-xs text-secondary transition-colors hover:bg-hover"
              >
                <span>{sectionsOn ? "Sections shown" : "Show sections"}</span>
                <span
                  className={`inline-flex h-4 w-7 items-center rounded-full px-0.5 transition-colors ${sectionsOn ? "bg-accent" : "bg-elevated border border-border"}`}
                  aria-hidden
                >
                  <span className={`h-3 w-3 rounded-full bg-white transition-transform ${sectionsOn ? "translate-x-3" : ""}`} />
                </span>
              </button>
              {sections.length > 0 && (
                <>
                  <div className="mt-1 border-t border-border/60 pt-1">
                    <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Bands</div>
                    {sections.map((s) => (
                      <div key={s.id} className="flex items-center gap-2 px-3 py-1.5 text-xs text-secondary">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color ?? undefined }} />
                        <span className="min-w-0 flex-1 truncate">{s.name}</span>
                        <span className="text-[10px] text-muted">{s.start_pct}%</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <div className="mt-1 border-t border-border/60 pt-1">
                <p className="px-3 py-1.5 text-[10px] leading-relaxed text-muted">
                  Drag a task onto a band to apply its rule (list, tag, priority or status).
                </p>
              </div>
            </PopoverMenu>
          </div>
        )}

        <button
          onClick={() => { setFormDefaultDate(null); setShowTaskForm(true); }}
          className="btn btn-primary px-4 py-1.5 text-xs shrink-0"
        >
          + New
        </button>

        <button onClick={() => router.push("/settings")} className="btn bg-elevated border border-border text-xs px-3 py-1.5 rounded-full text-secondary hover:text-primary shrink-0" title="Settings" data-tour="settings">
          ⚙
        </button>

        {stickyOn && (
          <button
            onClick={() => openNotesWindow()}
            className="btn bg-elevated border border-border text-xs px-3 py-1.5 rounded-full text-secondary hover:text-primary shrink-0"
            title="Notes"
          >
            Notes
          </button>
        )}

        <button onClick={() => onToggleRight?.()} className="pointer-coarse:h-11 pointer-coarse:w-11 gradient-bg flex h-8 w-8 shrink-0 min-w-8 items-center justify-center rounded-full text-[var(--on-gradient)] shadow-glow hover:brightness-110" title="AI" data-tour="ai-panel">
          ⚡
        </button>
      </div>

      {/* Centered quick-add modal (toolbar + New, right-click, empty state) */}
      <Modal
        isOpen={showTaskForm}
        onClose={() => { setShowTaskForm(false); setFormDefaultDate(null); }}
        title="New Task"
      >
        <TaskForm
          onSubmit={handleCreateTask}
          onCancel={() => { setShowTaskForm(false); setFormDefaultDate(null); }}
          defaultDate={formDefaultDate ? formDefaultDate.toISOString().split("T")[0] : undefined}
        />
      </Modal>

      {/* Main content area */}
      {safeMode === "board" ? (
        <BoardView tasks={visibleTasks} />
      ) : safeMode === "kanban" ? (
        <KanbanBoard />
      ) : safeMode === "calendar" ? (
        <CalendarView />
      ) : safeMode === "list" ? (
        <ListView />
      ) : (
      <div className="flex" style={{ flex: 1, minHeight: 0 }}>
        {/* Single timeline canvas: all tasks render in one lane */}
        <div className="relative flex flex-col" data-timeline-canvas data-tour="timeline" style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
          <div
            ref={bodyRef}
            className="relative flex flex-col"
            data-timeline-body
            style={{
              flex: 1,
              overflow: "auto",
              overscrollBehavior: "x contain",
              minHeight: 0,
              cursor: panActive ? "grabbing" : "grab",
              userSelect: panActive ? "none" : undefined,
            }}
            onPointerDown={onTimelinePointerDown}
            onPointerMove={onTimelinePointerMove}
            onPointerUp={onTimelinePointerUp}
            onPointerLeave={onTimelinePointerUp}
            onContextMenu={openCanvasMenu}
          >
            <DndContext sensors={sensors} onDragEnd={handleDragEnd} onDragMove={handleDragMove}>
              <div className="relative" style={{ minHeight: "100%", width: days.length * dayWidth }}>
                <TimelineHeader days={days} dayWidth={dayWidth} />
                <TimelineGrid days={days} dayWidth={dayWidth} />
                <TimelineLane
                  tasks={visibleTasks}
                  days={days}
                  dayWidth={dayWidth}
                  onTaskClick={(id) => setSelectedTaskId(id)}
                  onDayDoubleClick={handleDayDoubleClick}
                  onDayAdd={handleDayDoubleClick}
                  onTaskContextMenu={openTaskMenu}
                  onDayContextMenu={openDayMenu}
                  dragDisabled={smallScreen}
                  selectMode={selectionMode}
                />
                {sectionsOn && (
                  <TimelineSectionsLayer
                    sections={sections}
                    tasks={visibleTasks}
                    days={days}
                    dayWidth={dayWidth}
                    bodyRef={bodyRef}
                    lists={lists}
                    tags={tags}
                    onSplit={() => void handleSplit()}
                    onRename={(id, name) => void renameSection(id, { name })}
                    onSetRule={(id, kind, value) => void renameSection(id, { rule_kind: kind, rule_value: value })}
                    onDelete={(id) => void removeSection(id)}
                  />
                )}
              </div>
            </DndContext>
          </div>

          {!hasTasks && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4">
              <div className="pointer-events-auto max-w-sm rounded-2xl border border-border/60 bg-surface/85 p-6 text-center backdrop-blur-sm">
                <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                </div>
                <p className="mt-3 text-sm font-semibold text-primary">A clean calendar - for now</p>
                <p className="mt-1 text-xs leading-relaxed text-secondary">
                  No tasks match this view yet. Create a task to see it appear on its day, or double-click a date to plan there.
                </p>
                <button
                  onClick={() => { setFormDefaultDate(null); setShowTaskForm(true); }}
                  className="btn-gradient mt-4 rounded-lg px-4 py-2 text-xs font-semibold"
                >
                  Create a task
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      )}

      {/* Desktop floating batch-action bar covers the timeline/kanban/board/calendar
          modes (list has its own inline toolbar). Always visible while a selection
          exists so Delete is never keyboard-only on desktop. */}
      {safeMode !== "list" && selectedTaskIds.length > 0 && (
        <SelectionActionBar
          floating
          count={selectedTaskIds.length}
          busy={batchDeleting}
          onDelete={() => void handleBatchDelete()}
          onClear={() => useAppStore.getState().clearTaskSelection()}
        />
      )}

  {/* Mobile batch action bar (select mode on the timeline) */}
      {selectionMode && selectedCount > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-16 z-40 flex justify-center px-4">
          <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-border bg-surface px-4 py-2 shadow-lg">
            <span className="text-xs font-medium text-secondary">{selectedCount} selected</span>
            <button
              onClick={() => void handleBatchDelete()}
              disabled={batchDeleting}
              className="btn bg-elevated border border-danger/30 px-3 py-1 text-xs text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
            >
              {batchDeleting ? "Deleting…" : "Delete"}
            </button>
            <button
              onClick={() => useAppStore.getState().clearTaskSelection()}
              className="btn bg-elevated border border-border px-3 py-1 text-xs text-secondary hover:text-primary"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Task detail drawer */}
      {selectedTask && (
        <TaskDetailDrawer task={selectedTask} onClose={() => setSelectedTaskId(null)} />
      )}

      {/* Task / workspace right-click menu */}
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
