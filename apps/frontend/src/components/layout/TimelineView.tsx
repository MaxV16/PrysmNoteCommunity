"use client";

import { useMemo, useCallback, useState, useEffect, useRef } from "react";
import { DndContext } from "@dnd-kit/core";
import { useAppStore } from "@/stores/app-store";
import { useTimeline } from "@/hooks/useTimeline";
import { todayStart } from "@/lib/dates";
import { TimelineHeader } from "@/components/timeline/TimelineHeader";
import { TimelineGrid } from "@/components/timeline/TimelineGrid";
import { TimelineLane } from "@/components/timeline/TimelineLane";
import { TaskDetailDrawer } from "@/components/tasks/TaskDetailDrawer";
import { TaskForm } from "@/components/tasks/TaskForm";
import dynamic from "next/dynamic";

const KanbanBoard = dynamic(() => import("@/components/kanban/KanbanBoard").then((m) => ({ default: m.KanbanBoard })), { ssr: false });
const CalendarView = dynamic(() => import("@/components/calendar/CalendarView").then((m) => ({ default: m.CalendarView })), { ssr: false });
const ListView = dynamic(() => import("@/components/list/ListView").then((m) => ({ default: m.ListView })), { ssr: false });
const BoardView = dynamic(() => import("@/components/board/BoardView").then((m) => ({ default: m.BoardView })), { ssr: false });
import { Modal } from "@/components/ui/Modal";
import { PopoverMenu } from "@/components/ui/PopoverMenu";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { TaskContextMenu, type ContextMenuState } from "@/components/tasks/TaskContextMenu";
import { useTasks, refreshTasksPreservingWindow } from "@/hooks/useTasks";
import { useBatchDelete } from "@/hooks/useBatchDelete";
import { api } from "@/lib/api";
import { useUiModule } from "@/lib/ui-module-registry";
import { useLocalBool } from "@/lib/use-local-bool";
import { useRouter } from "next/navigation";
import { parseLocalDate, toLocalDateString } from "@/lib/utils";
import type { Task, TaskStatus } from "@/types/task";
import { useResponsiveDayWidth, DAY_HEADER_HEIGHT, SECTION_HEADER_HEIGHT, MIN_LANE_HEIGHT, type ZoomLevel } from "@/components/timeline/constants";
import { computeLaneLayout } from "@/components/timeline/lane-layout";
import { PREF_DEFAULT_VIEW } from "@/lib/preferences";
import { usePreferencesStore } from "@/stores/preferences-store";
import { useStickyBoard } from "@/components/sticky/StickyNoteBoard";
import { useIsMobileOS } from "@/lib/use-is-mobile-os";
import { matchesSearchQuery } from "@/lib/task-search";
import { applyNavFilter, navFilterLabel } from "@/lib/task-filters";
import { useVisibleTasks } from "@/hooks/useVisibleTasks";
import { applyMoveDays, applyResizeDays } from "@/lib/timeline-drag";
import { applyBoardDrop } from "@/lib/board-dnd";
import { TimelineDragContext, type TimelineBarCommit } from "@/hooks/useTimelineBarDrag";
import { useMediaQuery } from "@/lib/use-media-query";
import { useToast } from "@/lib/toast-context";
import { SelectionActionBar } from "@/components/tasks/SelectionActionBar";
import { LeftLabelsCol } from "@/components/timeline/LeftLabelsCol";
import { useBoardSections } from "@/hooks/useBoardSections";
import { useSyncScroll } from "@/hooks/useSyncScroll";
import { FOREGROUND_REFRESH_EVENT } from "@/hooks/useForegroundRefresh";
import {
  persistSectionsMode,
  resolveInitialSectionsMode,
  type TimelineSectionsMode,
} from "@/lib/timeline-sections-mode";
import {
  TIMELINE_TODAY_INDEX,
  dayIndexForDate,
  dayIndexFromScrollLeft,
  monthLabelForViewport,
  scrollLeftForDayIndex,
  scrollLeftToCenterDay,
  sliceStartForViewport,
  totalCanvasWidth,
} from "@/lib/timeline-window";

// Shared empty array so a lane with no tasks keeps a stable prop identity.
const EMPTY_TASKS: Task[] = [];

export type TimelineViewMode = "timeline" | "kanban" | "calendar" | "list" | "board";

interface TimelineViewProps {
  onToggleRight?: () => void;
  onOpenSidebar?: () => void;
  viewMode: TimelineViewMode;
  onViewModeChange: (m: TimelineViewMode) => void;
}

export function TimelineView({ onToggleRight, onOpenSidebar, viewMode, onViewModeChange }: TimelineViewProps) {
  const tasks = useAppStore((s) => s.tasks);
  const selectedTaskId = useAppStore((s) => s.selectedTaskId);
  const setSelectedTaskId = useAppStore((s) => s.setSelectedTaskId);
  const selectedTaskIds = useAppStore((s) => s.selectedTaskIds);
  const navFilter = useAppStore((s) => s.navFilter);
  const setNavFilter = useAppStore((s) => s.setNavFilter);
  const selectedTagId = useAppStore((s) => s.selectedTagId);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const activeListId = useAppStore((s) => s.activeListId);
  const lists = useAppStore((s) => s.lists);
  const { days, visibleRange, sliceStart, moveSlice, today, zoom, zoomIn, zoomOut, zoomLevels } = useTimeline();
  const { createTask, persistTask, fetchRange, fetchTasks } = useTasks();
  const { busy: batchDeleting, softDeleteWithUndo } = useBatchDelete();
  const { showToast } = useToast();
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [formDefaultDate, setFormDefaultDate] = useState<Date | null>(null);
  const [formBoardSectionId, setFormBoardSectionId] = useState<string | null>(null);
  const [formStatus, setFormStatus] = useState<TaskStatus | undefined>(undefined);
  const [menu, setMenu] = useState<{ state: ContextMenuState; x: number; y: number } | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const router = useRouter();
  const bodyRef = useRef<HTMLDivElement>(null);
  const panStartRef = useRef<{
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
    pointerId: number;
    active: boolean;
    captured: boolean;
  } | null>(null);
  // Native pan engine state (see onTimelinePointerDown): one write per frame,
  // and a hook the pan effect can call to rebuild the slice after the gesture.
  const panRafRef = useRef(0);
  const panLatestRef = useRef<{ x: number; y: number } | null>(null);
  const postScrollRef = useRef<() => void>(() => {});

  // Selection box (Ctrl/Cmd + drag on empty canvas): the ref tracks the live
  // gesture; the state mirrors the rect so the overlay re-renders as it moves.
  const selectionBoxRef = useRef<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    active: boolean;
    pointerId: number;
  } | null>(null);
  const [selectionRect, setSelectionRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  const timelineOn = useUiModule("viewTimeline");
  const kanbanModuleOn = useUiModule("viewKanban");
  const calendarModuleOn = useUiModule("viewCalendar");
  const kanbanLocalOn = useLocalBool("prysm_feature_kanban", true);
  const calendarLocalOn = useLocalBool("prysm_feature_calendar", true);
  const kanbanOn = kanbanModuleOn && kanbanLocalOn;
  const calendarOn = calendarModuleOn && calendarLocalOn;
  const listOn = useUiModule("viewList");
  const boardOn = useUiModule("viewBoard");
  const isMobileOS = useIsMobileOS();
  const stickyOn = useUiModule("stickyNotes") && !isMobileOS;
  const { open: openStickyNote } = useStickyBoard();
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const tags = useAppStore((s) => s.tags);

  // Timeline swimlane sections via board_sections API, scoped to the active
  // list so a new list starts with no sections of its own.
  const {
    sections: timelineSections,
    loading: sectionsLoading,
    addSection: addTimelineSection,
    renameSection: renameTimelineSection,
    removeSection: removeTimelineSection,
    moveSection: moveTimelineSection,
  } = useBoardSections("timeline", activeListId);
  const [sectionCollapsed, setSectionCollapsed] = useState<Record<string, boolean>>({});
  const toggleSection = useCallback((id: string) => {
    setSectionCollapsed((prev) => ({ ...prev, [id]: !(prev[id] ?? false) }));
  }, []);
  const labelsColRef = useRef<HTMLDivElement | null>(null);
  const timelineGridContainerRef = useRef<HTMLDivElement | null>(null);
  const gridScrollRef = useRef<HTMLDivElement | null>(null);
  // Latest scroll offset, kept current by a passive scroll listener so a pan
  // never has to force layout by reading it at press time.
  const scrollPosRef = useRef({ left: 0, top: 0 });

  // Mobile: drag-to-pan stays native (the canvas scrolls), while task drag uses
  // the TouchSensor's hold-to-pickup constraint so it never fights the scroll.
  const smallScreen = useMediaQuery("(max-width: 767px)");
  // The left section column is a two-state rail: expanded (full labels) or
  // collapsed (color dot + chevron + count). The `>`/`<` control lives at the
  // top of the column itself; on a phone the rail is the default so the canvas
  // keeps its width without losing sections.
  const [sectionsMode, setSectionsMode] = useState<TimelineSectionsMode>("expanded");
  const sectionsPrefInit = useRef(false);
  useEffect(() => {
    if (sectionsPrefInit.current) return;
    sectionsPrefInit.current = true;
    const mode = resolveInitialSectionsMode();
    setSectionsMode(mode);
    // Normalizes the choice and clears any legacy fully-hidden preference.
    persistSectionsMode(mode);
  }, []);
  const changeSectionsMode = useCallback((mode: TimelineSectionsMode) => {
    setSectionsMode(mode);
    persistSectionsMode(mode);
  }, []);
  const sectionsRail = sectionsMode === "rail";
  const toggleSectionsRail = useCallback(() => {
    changeSectionsMode(sectionsMode === "rail" ? "expanded" : "rail");
  }, [changeSectionsMode, sectionsMode]);

  // Responsive column width: ~5-6 days visible on phones (clamp 56..120px).
  const dayWidth = useResponsiveDayWidth(zoom);

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
  const firstEnabledView = enabledViews[0];

  // Guard against a corrupt/unexpected viewMode: only render a sub-view when it is
  // one of the known values, otherwise fall back to the timeline branch.
  const safeMode: TimelineViewMode = viewModules[viewMode] ? viewMode : "timeline";

  useEffect(() => {
    if (!activeViewEnabled && firstEnabledView) {
      onViewModeChange(firstEnabledView);
    }
    // `onViewModeChange` is a stable shell callback; depending on it would re-run
    // on every parent render. The first enabled view id is the only input that
    // can change here, so the dep list is intentionally narrow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeViewEnabled, firstEnabledView]);

  const openTaskForm = useCallback(
    (opts?: { date?: Date | null; boardSectionId?: string | null; status?: TaskStatus }) => {
      setFormDefaultDate(opts?.date ?? null);
      setFormBoardSectionId(opts?.boardSectionId ?? null);
      setFormStatus(opts?.status);
      setShowTaskForm(true);
    },
    []
  );
  const closeTaskForm = useCallback(() => {
    setShowTaskForm(false);
    setFormDefaultDate(null);
    setFormBoardSectionId(null);
    setFormStatus(undefined);
  }, []);

  useEffect(() => {
    // `prysm-new-task` may carry an optional scope so a create triggered from
    // elsewhere (sidebar, mobile tab bar, AI) lands in the active board column.
    const onNewTask = (event: Event) => {
      const detail = (event as CustomEvent<{
        boardSectionId?: string | null;
        status?: TaskStatus;
        listId?: string | null;
        date?: string;
      }>).detail;
      openTaskForm({
        date: detail?.date ? parseLocalDate(detail.date) : null,
        boardSectionId: detail?.boardSectionId ?? null,
        status: detail?.status,
      });
    };
    window.addEventListener("prysm-new-task", onNewTask);
    return () => window.removeEventListener("prysm-new-task", onNewTask);
  }, [openTaskForm]);

  // Desktop mouse: a small activation distance keeps a click from reading as a
  // drag. Touch: a short hold starts the drag (long-press pickup) while a quick
  // swipe still scrolls the timeline. The activation logic lives in
  // useTimelineBarDrag, which each bar/handle consumes via TimelineDragContext.

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) || null,
    [tasks, selectedTaskId]
  );

  // Single source of truth for what a filtered view shows: the smart list plus
  // the active list, tag and search, shared with every other view.
  const visibleTasks = useVisibleTasks();

  // The month/year shown in the toolbar tracks the day at the middle of the
  // viewport, not the middle of the whole rendered canvas. The canvas can grow
  // to thousands of days (far-future recurrences), and using its midpoint made
  // the label drift years away from what the user was actually looking at.
  const [monthLabel, setMonthLabel] = useState(() =>
    todayStart().toLocaleDateString("en-US", { month: "long", year: "numeric" })
  );
  // Mirror of the label so a scroll can skip the state write entirely when the
  // month has not changed. Calling the setter with an unchanged value still
  // costs a render pass, which is the whole component at 60fps during a pan.
  const monthLabelRef = useRef(monthLabel);

  // Per-section task counts shown in the left labels column.
  const sectionTaskCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const t of visibleTasks) {
      if (t.board_section_id) {
        counts[t.board_section_id] = (counts[t.board_section_id] ?? 0) + 1;
      }
    }
    return counts;
  }, [visibleTasks]);

  // Exact lane height per section, computed with the same algorithm the lane
  // renders with (including its minimum), so the left swimlane labels stay
  // aligned with their lanes. Also keeps the per-section task arrays stable so
  // a memoized lane is not re-rendered by an unrelated parent render.
  const { sectionLaneHeights, sectionTasksById } = useMemo(() => {
    const heights: Record<string, number> = {};
    const byId: Record<string, Task[]> = {};
    for (const section of timelineSections) {
      const sectionTasks = visibleTasks.filter((t) => t.board_section_id === section.id);
      byId[section.id] = sectionTasks;
      heights[section.id] = Math.max(
        computeLaneLayout(sectionTasks, days).height,
        MIN_LANE_HEIGHT
      );
    }
    return { sectionLaneHeights: heights, sectionTasksById: byId };
  }, [timelineSections, visibleTasks, days]);

  // Tasks that belong to no section. They render in one extra lane under the
  // sections, so the label column gets a matching "Unsorted" row.
  const unsortedTasks = useMemo(
    () =>
      visibleTasks.filter(
        (t) => !t.board_section_id || !timelineSections.some((s) => s.id === t.board_section_id)
      ),
    [visibleTasks, timelineSections]
  );
  const unsortedLaneHeight = useMemo(
    () => Math.max(computeLaneLayout(unsortedTasks, days).height, MIN_LANE_HEIGHT),
    [unsortedTasks, days]
  );

  // Period navigation: step the viewport by one screen of days. The canvas is a
  // fixed, very wide strip, so these are plain scroll writes: the browser clamps
  // them, nothing can run out, and the position never jumps.
  const navigatePeriod = useCallback(
    (dir: "prev" | "next" | "today") => {
      const body = bodyRef.current;
      if (!body) return;
      if (dir === "today") {
        body.scrollLeft = scrollLeftToCenterDay(
          TIMELINE_TODAY_INDEX,
          dayWidth,
          body.clientWidth
        );
        return;
      }
      const pagePx = Math.max(7, Math.round(body.clientWidth / dayWidth)) * dayWidth;
      body.scrollLeft += dir === "prev" ? -pagePx : pagePx;
    },
    [dayWidth]
  );

  // Center today when the timeline (re)opens, and keep the same leftmost day
  // when the column width changes on a resize. The park happens at most once per
  // timeline open: switching to another view and back parks again, but an
  // incidental effect re-run (or a resize) can never snap the canvas back to
  // today after the user has scrolled elsewhere.
  const lastDayWidthRef = useRef(dayWidth);
  const hasParkedRef = useRef(false);
  // Ctrl/Cmd + wheel zoom is one discrete step per gesture burst. Without a
  // cooldown a single trackpad scroll fires dozens of wheel events and the zoom
  // races to the end (which read as "flicker, only a couple of sizes"); the
  // anchor keeps the day under the cursor pinned while the column width changes
  // so the canvas does not jump.
  const lastWheelZoomRef = useRef(0);
  const zoomAnchorRef = useRef<{ dayIndex: number; offsetX: number } | null>(null);
  useEffect(() => {
    if (safeMode !== "timeline") {
      hasParkedRef.current = false;
      return;
    }
    const body = bodyRef.current;
    if (!body) return;
    const previousWidth = lastDayWidthRef.current;
    lastDayWidthRef.current = dayWidth;
    if (previousWidth > 0 && previousWidth !== dayWidth) {
      const anchor = zoomAnchorRef.current;
      zoomAnchorRef.current = null;
      if (anchor) {
        // Keep the day under the cursor in place across the width change.
        body.scrollLeft = scrollLeftForDayIndex(anchor.dayIndex, dayWidth) - anchor.offsetX;
      } else {
        // Day-preserving rescale: keep the leftmost day, not today.
        body.scrollLeft = Math.round(body.scrollLeft / previousWidth) * dayWidth;
      }
      scrollPosRef.current = { left: body.scrollLeft, top: body.scrollTop };
      return;
    }
    if (hasParkedRef.current) return;
    hasParkedRef.current = true;
    body.scrollLeft = scrollLeftToCenterDay(
      TIMELINE_TODAY_INDEX,
      dayWidth,
      body.clientWidth
    );
    scrollPosRef.current = { left: body.scrollLeft, top: body.scrollTop };
  }, [safeMode, dayWidth]);

  // Latest slice start for the scroll listener, which is attached once per
  // (view, width) rather than on every slice change.
  const sliceStartRef = useRef(sliceStart);
  sliceStartRef.current = sliceStart;

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || safeMode !== "timeline") return;
    const rafRef = { current: 0 };
    let pending = false;

    // The label is anchored to the viewport's LEFT edge (see
    // monthLabelForViewport), so it only changes on an actual scroll.
    const updateLabel = () => {
      const next = monthLabelForViewport({
        scrollLeft: body.scrollLeft,
        clientWidth: body.clientWidth,
        dayWidth,
        today,
      });
      if (monthLabelRef.current === next) return;
      monthLabelRef.current = next;
      setMonthLabel(next);
    };

    // Re-render the slice around the viewport once it nears a slice edge. The
    // rendered days keep their absolute pixel positions, so this is invisible
    // and no scroll compensation is ever needed.
    const rebuildSlice = () => {
      const nextStart = sliceStartForViewport({
        scrollLeft: body.scrollLeft,
        clientWidth: body.clientWidth,
        dayWidth,
        currentStart: sliceStartRef.current,
      });
      if (nextStart !== null) moveSlice(nextStart);
    };

    updateLabel();
    rebuildSlice();

    const runPostScroll = () => {
      updateLabel();
      rebuildSlice();
    };
    postScrollRef.current = runPostScroll;

    const handleScroll = () => {
      // While a pan is in flight the only per-frame work is the scroll write
      // made by applyPan, so return BEFORE any read. Reading scrollLeft/
      // scrollTop here flushes layout on every scroll event of the gesture and
      // reads a value the pan never uses (it drives the canvas from its own
      // captured start offset), so the read was pure cost. A React render here
      // (month label + slice rebuild) is what made Windows judder too; the pan
      // end settles the tracked position and the scroll event that follows runs
      // this normally.
      if (panStartRef.current?.active) return;
      // Keep the pan start position fresh without forcing a layout read at
      // press time (reading scrollLeft there flushes layout and stalled the
      // pan start on Windows).
      scrollPosRef.current = { left: body.scrollLeft, top: body.scrollTop };
      if (pending) return;
      pending = true;
      rafRef.current = requestAnimationFrame(() => {
        pending = false;
        runPostScroll();
      });
    };
    body.addEventListener("scroll", handleScroll, { passive: true });
    scrollPosRef.current = { left: body.scrollLeft, top: body.scrollTop };

    // A width-only change (the AI dock, the sidebar, a scrollbar appearing) must
    // rebuild the slice and re-clamp if the canvas shrank, but it must NOT write
    // the month label: the left edge did not move, so the month did not change.
    let lastWidth = body.clientWidth;
    const ro = new ResizeObserver(() => {
      const width = body.clientWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      const maxScroll = Math.max(0, body.scrollWidth - body.clientWidth);
      if (body.scrollLeft > maxScroll) body.scrollLeft = maxScroll;
      rebuildSlice();
    });
    ro.observe(body);

    // Wheel/trackpad panning. Native scrolling owns the axis the canvas can
    // actually scroll; this maps Shift+wheel and horizontal trackpad deltas to
    // the timeline so a Windows mouse can pan without dragging, and normalizes
    // deltaMode because Windows reports line/page deltas rather than pixels.
    // Ctrl/Cmd + wheel zooms the timeline (discrete levels).
    const handleWheel = (e: WheelEvent) => {
      const canScrollVertically = body.scrollHeight > body.clientHeight + 1;
      const shift = e.shiftKey;
      const ctrlOrMeta = e.ctrlKey || e.metaKey;
      const horizontal = shift || Math.abs(e.deltaX) > Math.abs(e.deltaY);

      // Ctrl/Cmd + wheel = zoom. One step per burst, anchored on the day under
      // the pointer, so a trackpad flick changes the zoom exactly once and the
      // content stays put instead of racing to the end and jumping.
      if (ctrlOrMeta && e.deltaY !== 0) {
        e.preventDefault();
        const now = performance.now();
        if (now - lastWheelZoomRef.current < 140) return;
        lastWheelZoomRef.current = now;
        const rect = body.getBoundingClientRect();
        const offsetX = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
        zoomAnchorRef.current = {
          dayIndex: dayIndexFromScrollLeft(body.scrollLeft + offsetX, dayWidth),
          offsetX,
        };
        if (e.deltaY < 0) zoomIn();
        else zoomOut();
        return;
      }

      if (!horizontal && canScrollVertically) return;
      let dx = e.deltaX;
      let dy = e.deltaY;
      if (e.deltaMode === 1) {
        dx *= 16;
        dy *= 16;
      } else if (e.deltaMode === 2) {
        dx *= body.clientWidth;
        dy *= body.clientHeight;
      }
      if (shift && dx === 0) {
        dx = dy;
        dy = 0;
      }
      if (Math.abs(dx) >= Math.abs(dy)) {
        if (dx !== 0) {
          e.preventDefault();
          body.scrollLeft += dx;
        }
      } else if (!canScrollVertically) {
        e.preventDefault();
        body.scrollLeft += dy;
      }
    };
    body.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      body.removeEventListener("scroll", handleScroll);
      body.removeEventListener("wheel", handleWheel);
      ro.disconnect();
      cancelAnimationFrame(rafRef.current);
    };
  }, [safeMode, dayWidth, today, moveSlice, zoomIn, zoomOut]);

  // Sync vertical scroll between the left labels column and the day grid body.
  useSyncScroll(bodyRef, labelsColRef, [
    sectionsLoading,
    timelineSections.length,
    safeMode,
    sectionsRail,
  ]);

  // Commit from the timeline pointer engine. Called once per gesture with the
  // exact day count the snapped preview showed; optimistic store write first,
  // then a silent background persist (no awaited refetch inside the gesture).
  // A drop can change the section (vertical drag onto another lane), the dates
  // (horizontal drag), or both at once.
  const handleBarCommit = useCallback(
    async (commit: TimelineBarCommit) => {
      const { task, mode, days, sectionId } = commit;
      const store = useAppStore.getState();
      const sectionChanged = sectionId !== undefined && sectionId !== task.board_section_id;

      const dateFields: Record<string, string> =
        days === 0
          ? {}
          : mode === "move"
          ? applyMoveDays(task, days)
          : applyResizeDays(task, days, mode === "resize-left" ? "left" : "right");

      const selectedIds = store.selectedTaskIds;
      if (
        !sectionChanged &&
        mode === "move" &&
        days !== 0 &&
        selectedIds.length > 1 &&
        selectedIds.includes(task.id)
      ) {
        // Multi-drag: shift every selected bar by the same day delta and persist
        // with one batch-reschedule.
        const previous = store.tasks;
        const fieldsByTask = new Map<string, Record<string, string>>();
        for (const id of selectedIds) {
          const t = store.tasks.find((x) => x.id === id);
          if (!t) continue;
          fieldsByTask.set(id, applyMoveDays(t, days));
        }
        store.setTasks(
          store.tasks.map((t) =>
            fieldsByTask.has(t.id) ? { ...t, ...fieldsByTask.get(t.id) } : t
          )
        );
        try {
          await api.post("/tasks/batch-reschedule", {
            task_ids: Array.from(fieldsByTask.keys()),
            delta_days: days,
          });
        } catch (e) {
          store.setTasks(previous);
          showToast(
            e instanceof Error && e.message
              ? e.message
              : "Could not move the selected tasks.",
            "error"
          );
        }
        return;
      }

      if (!sectionChanged && Object.keys(dateFields).length === 0) return;

      const previous = store.tasks;
      let next = store.tasks.map((t) =>
        t.id === task.id ? { ...t, ...dateFields } : t
      );
      if (sectionChanged) {
        // Reuse the board-move semantics (free section pins by id, status
        // section sets status, Unsorted clears the pin) and renumber the
        // destination's board_order exactly as the server will.
        next = applyBoardDrop(
          next,
          task.id,
          { sectionId: sectionId ?? null, index: Number.MAX_SAFE_INTEGER },
          timelineSections
        );
        if (sectionId) setSectionCollapsed((prev) => ({ ...prev, [sectionId]: false }));
      }
      store.setTasks(next);

      try {
        if (sectionChanged) {
          await api.post("/tasks/board-move", {
            task_id: task.id,
            section_id: sectionId ?? null,
            index: Number.MAX_SAFE_INTEGER,
          });
        }
        if (Object.keys(dateFields).length > 0) {
          await persistTask(task.id, dateFields);
        }
      } catch {
        store.setTasks(previous);
        showToast("Could not move the task. Please try again.", "error");
      }
    },
    [persistTask, showToast, timelineSections]
  );

  const sectionIds = useMemo(
    () => new Set(timelineSections.map((s) => s.id)),
    [timelineSections]
  );

  const dragContextValue = useMemo(
    () => ({
      dayWidth,
      sectionIds,
      onCommit: (commit: TimelineBarCommit) => void handleBarCommit(commit),
    }),
    [dayWidth, sectionIds, handleBarCommit]
  );

  // Drag-to-pan the timeline: grabbing empty space scrolls the canvas on both
  // axes (like a map). The pan is driven by native window pointer events,
  // coalesced to a single scroll write per frame, so high-rate Windows pointer
  // input cannot thrash the main thread the way a per-event React handler did.
  // It activates on the first pixel (no dead zone) and defers the
  // month-label/slice render until the gesture ends. The pointer is captured
  // lazily, only once the gesture actually becomes a pan (first move), so a
  // stationary double-click on a day cell still reaches it instead of being
  // retargeted to the scroll body. The pointer is only captured from empty
  // canvas, never from a task bar/handle or a button/input.
  const applyPan = useCallback(() => {
    panRafRef.current = 0;
    const body = bodyRef.current;
    const start = panStartRef.current;
    const latest = panLatestRef.current;
    if (!body || !start || !latest) return;
    body.scrollLeft = start.scrollLeft - (latest.x - start.x);
    body.scrollTop = start.scrollTop - (latest.y - start.y);
  }, []);

  const onNativePanMove = useCallback(
    (e: PointerEvent) => {
      const start = panStartRef.current;
      if (!start || e.pointerId !== start.pointerId) return;
      // Prefer coalesced events so a high-polling-rate device still resolves to
      // a single write on the next frame.
      const coalesced = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      const last = coalesced.length > 0 ? coalesced[coalesced.length - 1] : e;
      panLatestRef.current = { x: last.clientX, y: last.clientY };
      if (!start.active) {
        // Activate on the very first pixel of real movement and write it
        // synchronously, so the canvas follows the first move instead of
        // waiting a frame. There is deliberately no pixel threshold: a 1px dead
        // zone is perceptible on Windows and high-DPI displays deliver
        // sub-pixel deltas, so any change engages the pan. The grab styles are
        // applied at press, not here, so this path writes only the scroll
        // offset and cannot force a style recalc mid-gesture.
        // NOTE: scrollLeft/scrollTop writes here trigger a scroll event which
        // on Windows with contain: paint (not "layout") only triggers a paint
        // invalidation, not a full layout recomputation, the key fix for the
        // ~1s activation delay (was: layout style paint forced layout on every
        // scroll write during pan).
        if (last.clientX === start.x && last.clientY === start.y) return;
        start.active = true;
        // Capture the pointer only now, on the first real movement. Capturing
        // at press retargeted the native dblclick to the body, which silently
        // broke double-click-to-create on a day cell; a stationary press no
        // longer captures, so the day cell still receives its click/dblclick.
        const body = bodyRef.current;
        if (body && !start.captured) {
          try { body.setPointerCapture(start.pointerId); start.captured = true; } catch {}
        }
        applyPan();
      }
      if (panRafRef.current === 0) panRafRef.current = requestAnimationFrame(applyPan);
    },
    [applyPan]
  );

  const onNativePanUp = useCallback(
    (e: PointerEvent) => {
      const start = panStartRef.current;
      if (!start || e.pointerId !== start.pointerId) return;
      if (panRafRef.current !== 0) {
        cancelAnimationFrame(panRafRef.current);
        panRafRef.current = 0;
      }
      // Settle the exact final position before tearing the gesture down.
      panLatestRef.current = { x: e.clientX, y: e.clientY };
      applyPan();
      const body = bodyRef.current;
      // The scroll listener skipped its tracked-position update for the whole
      // gesture and the final write may emit no scroll event, so refresh it
      // once here. This single read happens at gesture end, never inside the
      // pan, and keeps the next press's captured start offset correct.
      if (body) {
        scrollPosRef.current = { left: body.scrollLeft, top: body.scrollTop };
      }
      // A press on empty canvas clears the selection. It is deferred to release
      // so pressing cannot re-render the whole canvas before the first pointer
      // move is handled; a plain click still clears, because pointerup fires.
      if (useAppStore.getState().selectedTaskIds.length > 0) {
        useAppStore.getState().clearTaskSelection();
      }
      panStartRef.current = null;
      panLatestRef.current = null;
      if (body) {
        if (start.captured) {
          try { body.releasePointerCapture(start.pointerId); } catch {}
        }
        body.style.cursor = "";
        body.style.userSelect = "";
      }
      window.removeEventListener("pointermove", onNativePanMove);
      window.removeEventListener("pointerup", onNativePanUp);
      window.removeEventListener("pointercancel", onNativePanUp);
      // The final write may not emit a scroll event if the offset did not
      // change; rebuild the slice/label once regardless so a pan settles.
      requestAnimationFrame(() => postScrollRef.current());
    },
    [applyPan, onNativePanMove]
  );

  // Selection box (Ctrl/Cmd + drag on empty canvas)
  const onSelectionBoxMove = useCallback(
    (e: PointerEvent) => {
      const box = selectionBoxRef.current;
      if (!box || e.pointerId !== box.pointerId) return;
      box.currentX = e.clientX;
      box.currentY = e.clientY;
      const body = bodyRef.current;
      if (!body) return;
      // Rect in canvas content coordinates (the overlay scrolls with the strip).
      const rect = body.getBoundingClientRect();
      const x1 = box.startX - rect.left + body.scrollLeft;
      const y1 = box.startY - rect.top + body.scrollTop;
      const x2 = box.currentX - rect.left + body.scrollLeft;
      const y2 = box.currentY - rect.top + body.scrollTop;
      setSelectionRect({
        left: Math.min(x1, x2),
        top: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
      });
    },
    []
  );

  const onSelectionBoxUp = useCallback(
    (e: PointerEvent) => {
      const box = selectionBoxRef.current;
      if (!box || e.pointerId !== box.pointerId) return;
      const body = bodyRef.current;

      if (body) {
        // Hit-test against the real rendered task bars (viewport rects), which
        // covers both axes exactly as the user sees them.
        const sx1 = Math.min(box.startX, box.currentX);
        const sx2 = Math.max(box.startX, box.currentX);
        const sy1 = Math.min(box.startY, box.currentY);
        const sy2 = Math.max(box.startY, box.currentY);
        const dragged = Math.abs(sx2 - sx1) > 4 && Math.abs(sy2 - sy1) > 4;

        const selectedIds: string[] = [];
        body.querySelectorAll<HTMLElement>("[data-task-id]").forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.left < sx2 && r.right > sx1 && r.top < sy2 && r.bottom > sy1) {
            const id = el.dataset.taskId;
            if (id) selectedIds.push(id);
          }
        });

        if (selectedIds.length > 0) {
          useAppStore.getState().setSelectedTaskIds(selectedIds);
        } else if (dragged) {
          useAppStore.getState().clearTaskSelection();
        }
      }

      selectionBoxRef.current = null;
      setSelectionRect(null);
      window.removeEventListener("pointermove", onSelectionBoxMove);
      window.removeEventListener("pointerup", onSelectionBoxUp);
      window.removeEventListener("pointercancel", onSelectionBoxUp);
      if (body) {
        // Match the pan teardown: never leave the canvas holding the pointer,
        // or the next press on a task bar would be retargeted and the drag
        // would silently do nothing.
        try {
          body.releasePointerCapture(box.pointerId);
        } catch {
          // Capture may already have been released implicitly.
        }
        body.style.cursor = "";
        body.style.userSelect = "";
      }
    },
    [onSelectionBoxMove]
  );

  const onTimelinePointerDown = useCallback(
    (e: React.PointerEvent) => {
      const body = bodyRef.current;
      if (!body || e.button !== 0) return;
      // Touch keeps native `pan-x pan-y` scrolling (the custom pan would fight
      // it); mouse and pen can pan even in a narrow window.
      if (smallScreen && e.pointerType === "touch") return;
      const target = e.target as HTMLElement;
      // Never pan from an interactive element (task bars, resize handles, buttons, inputs).
      if (target.closest("[data-task-bar], [data-resize-handle], button, input, select, textarea, a")) {
        return;
      }

      // Ctrl/Cmd + drag = selection box
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        selectionBoxRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          currentX: e.clientX,
          currentY: e.clientY,
          active: true,
          pointerId: e.pointerId,
        };
        body.style.cursor = "crosshair";
        body.style.userSelect = "none";
        try { body.setPointerCapture(e.pointerId); } catch {}
        window.addEventListener("pointermove", onSelectionBoxMove);
        window.addEventListener("pointerup", onSelectionBoxUp);
        window.addEventListener("pointercancel", onSelectionBoxUp);
        return;
      }

      // The empty-canvas selection clear is deferred to release (see
      // onNativePanUp): doing it here re-rendered the whole canvas before the
      // first pointer move was handled, which is a large part of why the pan
      // felt like it took a beat to start on Windows.
      // Read the tracked position, never `body.scrollLeft` (that read flushes
      // layout of the whole canvas and stalled the pan start).
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        scrollLeft: scrollPosRef.current.left,
        scrollTop: scrollPosRef.current.top,
        pointerId: e.pointerId,
        active: false,
        captured: false,
      };
      panLatestRef.current = { x: e.clientX, y: e.clientY };
      // Apply the grab affordance at press, while no layout is dirty, instead
      // of mid-gesture where a style write would force a recalc on the move
      // path. onNativePanUp restores both.
      body.style.cursor = "grabbing";
      body.style.userSelect = "none";
      // Do NOT capture the pointer here: capturing on a stationary press
      // retargets the native dblclick away from a day cell and broke
      // double-click-to-create on desktop. onNativePanMove captures lazily on
      // the first real movement instead, so no pan move is lost and a
      // stationary double-click still reaches the day cell.
      window.addEventListener("pointermove", onNativePanMove);
      window.addEventListener("pointerup", onNativePanUp);
      window.addEventListener("pointercancel", onNativePanUp);
    },
    [smallScreen, onNativePanMove, onNativePanUp, onSelectionBoxMove, onSelectionBoxUp]
  );

  // Never leave native pan listeners attached after unmount.
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onNativePanMove);
      window.removeEventListener("pointerup", onNativePanUp);
      window.removeEventListener("pointercancel", onNativePanUp);
      if (panRafRef.current !== 0) cancelAnimationFrame(panRafRef.current);
    },
    [onNativePanMove, onNativePanUp]
  );

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
        const created = await createTask({
          ...data,
          list_id: data.list_id ?? useAppStore.getState().activeListId ?? undefined,
        });
        // A newly created task must be visible right away. If the active filter,
        // search, or tag would hide it, relax that filter so it shows up instead
        // of vanishing until the next refresh.
        const store = useAppStore.getState();
        if (store.navFilter && applyNavFilter([created], store.navFilter).length === 0) {
          store.setNavFilter(null);
        }
        if (store.searchQuery && !matchesSearchQuery(created, store.searchQuery)) {
          store.setSearchQuery("");
        }
        if (store.selectedTagId && !created.tags?.some((tag) => tag.id === store.selectedTagId)) {
          store.setSelectedTagId(null);
        }
        closeTaskForm();
        // Bring the new task's date into view when it is off-screen.
        const targetDate = created.start_date || created.due_date;
        const body = bodyRef.current;
        if (targetDate && body) {
          const index = dayIndexForDate(parseLocalDate(targetDate), today);
          const startIndex = dayIndexFromScrollLeft(body.scrollLeft, dayWidth);
          const visibleDays = Math.max(1, Math.floor(body.clientWidth / dayWidth));
          if (index < startIndex || index > startIndex + visibleDays - 1) {
            body.scrollLeft = scrollLeftToCenterDay(index, dayWidth, body.clientWidth);
            scrollPosRef.current = { left: body.scrollLeft, top: body.scrollTop };
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not create the task. Try again.";
        showToast(message, "error");
      }
    },
    [createTask, showToast, closeTaskForm, dayWidth, today]
  );

  const handleDayDoubleClick = useCallback((day: Date, sectionId?: string | null) => {
    openTaskForm({ date: day, boardSectionId: sectionId ?? null });
  }, [openTaskForm]);

  // Stable identity so a memoized lane is not invalidated on every render.
  const handleTaskClick = useCallback(
    (id: string) => setSelectedTaskId(id),
    [setSelectedTaskId]
  );

  // Right-click on a task bar opens the task context menu.
  const openTaskMenu = useCallback((e: React.MouseEvent, task: Task) => {
    setMenu({ state: { kind: "task", task }, x: e.clientX, y: e.clientY });
  }, []);

  // Right-click on an empty day cell opens a day-scoped new-task menu.
  const openDayMenu = useCallback(
    (e: React.MouseEvent, day: Date, section?: { id: string | null; title: string } | null) => {
      setMenu({
        state: { kind: "empty", day: toLocalDateString(day), section: section ?? undefined },
        x: e.clientX,
        y: e.clientY,
      });
    },
    []
  );

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
    // Only suppress the native menu on blank canvas. Interactive elements above
    // return early so inputs keep their own copy/paste context menu, and task
    // bars / day cells handle their own preventDefault in their handlers.
    e.preventDefault();
    setMenu({ state: { kind: "empty" }, x: e.clientX, y: e.clientY });
  }, []);

  // Empty-area "New task" reuses the existing form flow, pre-scoped to a day
  // when the menu was opened on one.
  const handleEmptyNewTask = useCallback(
    (ctx: { day?: string; section?: { id: string | null; title: string } }) => {
      openTaskForm({
        date: ctx.day ? parseLocalDate(ctx.day) : null,
        boardSectionId: ctx.section?.id ?? null,
      });
    },
    [openTaskForm]
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
    ? navFilterLabel(navFilter)
    : activeListId
      ? lists.find((l) => l.id === activeListId)?.name || null
      : null;

  const hasTasks = visibleTasks.length > 0;

  // Lane height is driven by TimelineLane's computedHeight (the busiest-day
  // stack), never by the total visible-task count: a 3000-task import must not
  // stretch a single lane to ~144k px. TimelineLane keeps a sane minimum for
  // empty states.

  // Lazy range fetch: materialize tasks for the rendered slice plus a buffer, so
  // far dates get their bars without a full reload (endless recurrences expand
  // server-side). fetchRange itself skips already-covered windows.
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base">
      {/* Toolbar - a single non-wrapping row. The controls a phone needs most
          stay inline; every secondary action lives in the always-present
          "More" menu so nothing ever stacks or clips at any width. */}
      <div className="flex flex-nowrap items-center gap-x-1.5 overflow-x-auto border-b border-border bg-surface px-2 py-2 shrink-0 [scrollbar-width:none] sm:gap-x-3 sm:px-3" data-testid="timeline-toolbar">
        {onOpenSidebar && (
          <button
            onClick={onOpenSidebar}
            className="pointer-coarse:h-11 pointer-coarse:w-11 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-secondary transition-colors hover:bg-hover hover:text-primary md:hidden"
            aria-label="Open sidebar"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
        )}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="hidden shrink-0 sm:block">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/>
          <line x1="8" y1="2" x2="8" y2="6"/>
          <line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span className="text-lg font-bold text-primary mr-2 hidden md:block shrink-0">{viewModeLabel}</span>

        {(filterBadge || selectedTagId || searchQuery) && (
          <span className="inline-flex max-w-[45vw] items-center gap-1 rounded bg-accent/15 px-2 py-0.5 text-[10px] text-accent shrink-0 sm:max-w-none">
            <span className="truncate">
              {[
                filterBadge,
                selectedTagId ? `#${tags.find((t) => t.id === selectedTagId)?.name ?? ""}` : null,
                searchQuery ? `"${searchQuery}"` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <button
              onClick={() => {
                setNavFilter(null);
                const store = useAppStore.getState();
                store.setActiveListId(null);
                store.setSelectedTagId(null);
                store.setSearchQuery("");
              }}
              className="hover:text-primary"
              aria-label="Clear all filters"
            >✕</button>
          </span>
        )}

        {/* Search first, then the view switcher and the period nav, so the
            controls a phone needs most stay visible without scrolling. */}
        <div className="flex shrink-0 items-center">
          <button
            onClick={() => {
              setSearchOpen(true);
              requestAnimationFrame(() => document.getElementById("global-search")?.focus());
            }}
            className="pointer-coarse:h-11 pointer-coarse:w-11 flex h-8 w-8 items-center justify-center rounded-full text-secondary transition-colors hover:bg-hover hover:text-primary"
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
            className={`h-8 shrink overflow-hidden rounded-lg border text-xs text-primary outline-none transition-all duration-200 placeholder:text-muted focus:border-accent ${
              searchOpen
                ? "w-36 border-border bg-elevated px-2.5 sm:w-44 lg:w-56"
                : "w-0 border-0 bg-transparent p-0 opacity-0"
            }`}
          />
        </div>

        {/* Desktop-only spacer: keeps the primary controls left and pushes the
            rest right; phones pack everything to the left and scroll. */}
        <div className="hidden min-w-0 flex-1 sm:block" />

        {safeMode === "timeline" && (
          <div className="flex shrink-0 items-center gap-0.5 rounded-full bg-elevated p-0.5">
            <button
              onClick={() => navigatePeriod("prev")}
              aria-label="Previous period"
              className="relative flex h-6 w-6 items-center justify-center rounded-full text-secondary hover:bg-hover hover:text-primary pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <button
              onClick={() => navigatePeriod("today")}
              className="rounded-full px-2 py-0.5 text-[11px] font-medium text-secondary transition-colors hover:bg-hover hover:text-primary"
              aria-label="Go to today"
            >
              Today
            </button>
            <button
              onClick={() => navigatePeriod("next")}
              aria-label="Next period"
              className="relative flex h-6 w-6 items-center justify-center rounded-full text-secondary hover:bg-hover hover:text-primary pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
            <span className="mx-1 hidden text-xs font-medium text-muted sm:inline">{monthLabel}</span>
          </div>
        )}

        {/* Secondary actions: inline on wide screens, in the More menu below
            on narrower ones so the row never wraps or clips. */}
        {!smallScreen && (
          <div className="hidden shrink-0 items-center gap-x-2 lg:flex">
            <button
              onClick={() => {
                void refreshTasksPreservingWindow();
                window.dispatchEvent(new CustomEvent(FOREGROUND_REFRESH_EVENT));
              }}
              className="btn bg-elevated border border-border text-xs px-3 py-1.5 rounded-full text-secondary hover:text-primary shrink-0"
              aria-label="Refresh tasks"
              data-testid="refresh-tasks"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-1"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Refresh
            </button>
            {safeMode === "timeline" && (
              <button
                onClick={() => {
                  void addTimelineSection({ title: `Section ${timelineSections.length + 1}` });
                }}
                className="btn bg-elevated border border-border text-xs px-3 py-1.5 rounded-full text-secondary hover:text-primary shrink-0"
                aria-label="Add section"
              >
                + Section
              </button>
            )}
            <button onClick={() => router.push("/settings")} className="btn bg-elevated border border-border text-xs px-3 py-1.5 rounded-full text-secondary hover:text-primary shrink-0" aria-label="Settings" data-tour="settings">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            {stickyOn && (
              <button
                onClick={() => openStickyNote()}
                className="btn bg-elevated border border-border text-xs px-3 py-1.5 rounded-full text-secondary hover:text-primary shrink-0"
                aria-label="Notes"
              >
                Notes
              </button>
            )}
          </div>
        )}

        <button
          onClick={() => openTaskForm()}
          className="pointer-coarse:h-11 pointer-coarse:w-11 btn btn-primary flex h-8 w-8 shrink-0 items-center justify-center rounded-full p-0"
          aria-label="New task"
          data-testid="new-task-button"
          title="New task"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>

        <button onClick={() => onToggleRight?.()} className="pointer-coarse:h-11 pointer-coarse:w-11 gradient-bg flex h-8 w-8 shrink-0 min-w-8 items-center justify-center rounded-full text-[var(--on-gradient)] shadow-glow hover:brightness-110" aria-label="AI" data-tour="ai-panel">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M12 2.5l1.7 4.8 4.8 1.7-4.8 1.7L12 15.5l-1.7-4.8L5.5 9l4.8-1.7L12 2.5z" />
            <path d="M18.6 14.4l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
          </svg>
        </button>

        {/* The view switcher and every secondary action live in this menu, on
            every screen size, so the bar stays a single tidy row. */}
        <button
          ref={mobileMenuButtonRef}
          onClick={() => setMobileMenuOpen((v) => !v)}
          className="pointer-coarse:h-11 pointer-coarse:w-11 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-secondary transition-colors hover:bg-hover hover:text-primary"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={mobileMenuOpen}
          data-testid="view-mode-toggle"
          data-tour="view-switcher"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <circle cx="12" cy="5" r="1.7" />
            <circle cx="12" cy="12" r="1.7" />
            <circle cx="12" cy="19" r="1.7" />
          </svg>
        </button>
        <PopoverMenu
          open={mobileMenuOpen}
          triggerRef={mobileMenuButtonRef}
          align="right"
          onClose={() => setMobileMenuOpen(false)}
          className="w-48"
        >
          <button
            onClick={() => { setMobileMenuOpen(false); openTaskForm(); }}
            className="block w-full px-4 py-2 text-left text-xs font-semibold text-primary transition-colors hover:bg-hover"
          >
            New task
          </button>
          {safeMode === "timeline" && (
            <button
              onClick={() => { setMobileMenuOpen(false); setSelectionMode((v) => !v); }}
              className="block w-full px-4 py-2 text-left text-xs text-secondary transition-colors hover:bg-hover hover:text-primary"
            >
              {selectionMode ? "Done selecting" : "Select tasks"}
            </button>
          )}
          {safeMode === "timeline" && timelineSections.length > 0 && (
            <button
              onClick={() => { setMobileMenuOpen(false); toggleSectionsRail(); }}
              className="block w-full px-4 py-2 text-left text-xs text-secondary transition-colors hover:bg-hover hover:text-primary"
            >
              {sectionsRail ? "Expand sections" : "Collapse sections"}
            </button>
          )}
          <button
            onClick={() => {
              setMobileMenuOpen(false);
              void refreshTasksPreservingWindow();
              window.dispatchEvent(new CustomEvent(FOREGROUND_REFRESH_EVENT));
            }}
            className="block w-full px-4 py-2 text-left text-xs text-secondary transition-colors hover:bg-hover hover:text-primary"
          >
            Refresh
          </button>
          {safeMode === "timeline" && (
            <button
              onClick={() => {
                setMobileMenuOpen(false);
                void addTimelineSection({ title: `Section ${timelineSections.length + 1}` });
              }}
              className="block w-full px-4 py-2 text-left text-xs text-secondary transition-colors hover:bg-hover hover:text-primary"
              aria-label="Add section"
            >
              New section
            </button>
          )}
          <button
            onClick={() => { setMobileMenuOpen(false); router.push("/settings"); }}
            className="block w-full px-4 py-2 text-left text-xs text-secondary transition-colors hover:bg-hover hover:text-primary"
          >
            Settings
          </button>
          {stickyOn && (
            <button
              onClick={() => { setMobileMenuOpen(false); openStickyNote(); }}
              className="block w-full px-4 py-2 text-left text-xs text-secondary transition-colors hover:bg-hover hover:text-primary"
            >
              Notes
            </button>
          )}
          <button
            onClick={() => { setMobileMenuOpen(false); window.dispatchEvent(new CustomEvent("prysm:show-reminders")); }}
            className="block w-full px-4 py-2 text-left text-xs text-secondary transition-colors hover:bg-hover hover:text-primary"
          >
            Notifications
          </button>
          <div className="mt-1 border-t border-border pt-1">
            {timelineOn && (
              <button
                onClick={() => { onViewModeChange("timeline"); setMobileMenuOpen(false); }}
                className={`block w-full px-4 py-2 text-left text-xs transition-colors hover:bg-hover ${viewMode === "timeline" ? "text-accent font-semibold" : "text-secondary"}`}
              >
                Timeline
              </button>
            )}
            {kanbanOn && (
              <button
                onClick={() => { onViewModeChange("kanban"); setMobileMenuOpen(false); }}
                className={`block w-full px-4 py-2 text-left text-xs transition-colors hover:bg-hover ${viewMode === "kanban" ? "text-accent font-semibold" : "text-secondary"}`}
              >
                Kanban
              </button>
            )}
            {calendarOn && (
              <button
                onClick={() => { onViewModeChange("calendar"); setMobileMenuOpen(false); }}
                className={`block w-full px-4 py-2 text-left text-xs transition-colors hover:bg-hover ${viewMode === "calendar" ? "text-accent font-semibold" : "text-secondary"}`}
              >
                Calendar
              </button>
            )}
            {listOn && (
              <button
                onClick={() => { onViewModeChange("list"); setMobileMenuOpen(false); }}
                className={`block w-full px-4 py-2 text-left text-xs transition-colors hover:bg-hover ${viewMode === "list" ? "text-accent font-semibold" : "text-secondary"}`}
              >
                List
              </button>
            )}
            {boardOn && (
              <button
                onClick={() => { onViewModeChange("board"); setMobileMenuOpen(false); }}
                className={`block w-full px-4 py-2 text-left text-xs transition-colors hover:bg-hover ${viewMode === "board" ? "text-accent font-semibold" : "text-secondary"}`}
              >
                Board
              </button>
            )}
          </div>
          <div className="mt-1 border-t border-border pt-1">
            {defaultView === safeMode ? (
              <div className="flex w-full items-center px-4 py-2 text-xs text-muted">
                <span>Default view</span>
                <svg className="ml-auto text-accent" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              </div>
            ) : (
              <button
                onClick={() => { setPreference(PREF_DEFAULT_VIEW, safeMode); setMobileMenuOpen(false); }}
                data-testid="set-default-view"
                className="block w-full px-4 py-2 text-left text-xs text-secondary transition-colors hover:bg-hover hover:text-primary"
              >
                Set as default view
              </button>
            )}
          </div>
        </PopoverMenu>
      </div>

      {/* Centered quick-add modal (toolbar + New, right-click, empty state) */}
      <Modal
        isOpen={showTaskForm}
        onClose={closeTaskForm}
        title="New Task"
      >
        <TaskForm
          onSubmit={handleCreateTask}
          onCancel={closeTaskForm}
          defaultDate={formDefaultDate ? toLocalDateString(formDefaultDate) : undefined}
          defaultStatus={formStatus}
          boardSectionId={formBoardSectionId}
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
      <DndContext>
      <TimelineDragContext.Provider value={dragContextValue}>
      <div className="flex" style={{ flex: 1, minHeight: 0 }}>
        {/* Left swimlane labels column (droppable targets must be inside DndContext) */}
        {!sectionsLoading && timelineSections.length > 0 && (
          <LeftLabelsCol
            sections={timelineSections}
            counts={sectionTaskCounts}
            collapsedMap={sectionCollapsed}
            rowHeights={sectionLaneHeights}
            unsortedCount={unsortedTasks.length}
            unsortedHeight={unsortedLaneHeight}
            onToggleCollapse={toggleSection}
            onRename={(id, title) => void renameTimelineSection(id, title)}
            onMove={(id, dir) => void moveTimelineSection(id, dir)}
            onDelete={(id) => void removeTimelineSection(id)}
            onAddSection={() => {
              void addTimelineSection({ title: `Section ${timelineSections.length + 1}` });
            }}
            rail={sectionsRail}
            onToggleRail={toggleSectionsRail}
            scrollRef={labelsColRef}
          />
        )}

        {/* Main timeline canvas */}
          <div className="relative flex flex-col" data-timeline-canvas data-tour="timeline" style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
          <div
            ref={bodyRef}
            className="relative flex flex-col"
            data-timeline-body
            data-timeline-range={`${toLocalDateString(visibleRange.start)}:${toLocalDateString(visibleRange.end)}`}
            style={{
              flex: 1,
              overflow: "auto",
              overscrollBehavior: "contain",
              minHeight: 0,
              contain: "paint",
              touchAction: "pan-x pan-y",
              // Never let a press on empty canvas start a native text-selection
              // drag: that fights the pan and stalls it (very noticeable on
              // Windows). The bars set their own drag affordance.
              userSelect: "none",
              WebkitUserSelect: "none",
            }}
            onPointerDown={onTimelinePointerDown}
            onDragStart={(e) => e.preventDefault()}
            draggable={false}
            onContextMenu={openCanvasMenu}
          >
              {/* The full, fixed-width scrollable strip. Only the slice below is
                  rendered, but each rendered day keeps its absolute pixel
                  position (left = dayIndex * dayWidth), so moving the slice or
                  scrolling never shifts a date. */}
              <div
                className="relative"
                style={{ minHeight: "100%", width: totalCanvasWidth(dayWidth) }}
              >
                <div
                  className="relative"
                  style={{ marginLeft: sliceStart * dayWidth, width: days.length * dayWidth }}
                >
                  <TimelineHeader days={days} dayWidth={dayWidth} />
                <TimelineGrid days={days} dayWidth={dayWidth} />
                {timelineSections.length > 0 ? (
                  <>
                    {timelineSections.map((section) => {
                      const collapsed = sectionCollapsed[section.id] ?? false;
                      // Stable identity from the memo above, so an unchanged
                      // lane is skipped by React.memo.
                      const sectionTasks = sectionTasksById[section.id] ?? EMPTY_TASKS;
                      // A collapsed section renders a placeholder row, not
                      // nothing, so the left label and canvas lanes stay aligned.
                      if (collapsed) {
                        return (
                          <div
                            key={section.id}
                            data-timeline-lane
                            data-lane-section-id={section.id}
                            className="border-b border-border/30"
                            style={{ height: SECTION_HEADER_HEIGHT }}
                          />
                        );
                      }
                      return (
                        <div
                          key={section.id}
                          data-timeline-lane
                          data-lane-section-id={section.id}
                          className="relative"
                          style={
                            section.color && /^#[0-9a-fA-F]{6}$/.test(section.color)
                              ? { backgroundColor: `${section.color}14` }
                              : undefined
                          }
                        >
                          <TimelineLane
                            tasks={sectionTasks}
                            days={days}
                            dayWidth={dayWidth}
                            sectionId={section.id}
                            sectionLabel={section.title}
                            onTaskClick={handleTaskClick}
                            onDayDoubleClick={handleDayDoubleClick}
                            onDayAdd={handleDayDoubleClick}
                            onTaskContextMenu={openTaskMenu}
                            onDayContextMenu={openDayMenu}
                            selectMode={selectionMode}
                          />
                          {sectionTasks.length === 0 && (
                            <div className="pointer-events-none absolute inset-0 z-30 flex items-center px-3">
                              <span className="rounded-md border border-dashed border-border px-2 py-1 text-[10px] text-muted">
                                Drop tasks here
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {/* Unsorted tasks that don't belong to any section. Only
                        rendered when it has tasks, and the label column shows
                        a matching row, so lanes and labels never desync. */}
                    {unsortedTasks.length > 0 && (
                      <div
                        data-timeline-lane
                        data-lane-section-id=""
                        className="relative"
                      >
                        <TimelineLane
                          tasks={unsortedTasks}
                          days={days}
                          dayWidth={dayWidth}
                          onTaskClick={handleTaskClick}
                          onDayDoubleClick={handleDayDoubleClick}
                          onDayAdd={handleDayDoubleClick}
                          onTaskContextMenu={openTaskMenu}
                          onDayContextMenu={openDayMenu}
                          selectMode={selectionMode}
                        />
                      </div>
                    )}
                  </>
                ) : (
                  <div data-timeline-lane data-lane-section-id="" className="relative">
                    <TimelineLane
                      tasks={visibleTasks}
                      days={days}
                      dayWidth={dayWidth}
                      onTaskClick={handleTaskClick}
                      onDayDoubleClick={handleDayDoubleClick}
                      onDayAdd={handleDayDoubleClick}
                      onTaskContextMenu={openTaskMenu}
                      onDayContextMenu={openDayMenu}
                      selectMode={selectionMode}
                    />
                  </div>
                )}
                </div>
              </div>

              {/* Selection box overlay */}
              {selectionRect && (
                <div
                  className="absolute z-50 pointer-events-none border-2 border-dashed border-accent bg-accent/10"
                  style={{
                    left: selectionRect.left,
                    top: selectionRect.top,
                    width: selectionRect.width,
                    height: selectionRect.height,
                  }}
                />
              )}

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
                  onClick={() => openTaskForm()}
                  className="btn-gradient mt-4 rounded-lg px-4 py-2 text-xs font-semibold"
                >
                  Create a task
                </button>
              </div>
            </div>
          )}
          {/* Fade the canvas' left edge so a partially visible first day reads
              as "scroll for more" rather than a clipped header fragment. */}
          <div
            aria-hidden
            data-testid="timeline-left-fade"
            className="pointer-events-none absolute inset-y-0 left-0 z-20 w-3 bg-gradient-to-r from-base to-transparent"
          />
          </div>
      </div>
      </TimelineDragContext.Provider>
      </DndContext>
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
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+3rem)] z-40 flex justify-center px-4">
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
