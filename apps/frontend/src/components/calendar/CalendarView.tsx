"use client";

import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useAppStore } from "@/stores/app-store";
import type { Task } from "@/types/task";
import { Modal } from "@/components/ui/Modal";
import { TaskForm } from "@/components/tasks/TaskForm";
import { ContextMenu } from "@/components/ui/ContextMenu";
import {
  TaskContextMenu,
  type ContextMenuState,
} from "@/components/tasks/TaskContextMenu";
import { useTasks } from "@/hooks/useTasks";
import { useVisibleTasks } from "@/hooks/useVisibleTasks";
import { useToast } from "@/lib/toast-context";
import { useLongPress } from "@/lib/use-long-press";
import { api } from "@/lib/api";
import { TIER_COLORS, normalizePriority } from "@/lib/priority";
import { taskTimeLabel } from "@/lib/task-time";
import { calendarOffset, daysBetweenISO, weekdayHeaders } from "@/lib/dates";
import { toLocalDateString } from "@/lib/utils";

const PRIORITY_COLORS = TIER_COLORS;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Minimal pointer shape shared by right-click MouseEvents and long-press points. */
type MenuPoint = { clientX: number; clientY: number };

interface CalendarDayCellProps {
  d: number;
  ds: string;
  isToday: boolean;
  dayTasks: Task[];
  selectedTaskIds: string[];
  onDayNewTask: (d: number) => void;
  onOpenCardMenu: (e: MenuPoint, task: Task) => void;
  onOpenDayMenu: (e: MenuPoint, ds: string) => void;
  onTaskClick: (e: React.MouseEvent<HTMLDivElement>, task: Task) => void;
  onChipPointerDown: (
    e: ReactPointerEvent<HTMLDivElement>,
    task: Task,
    ds: string,
  ) => void;
  onChipPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onChipPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onChipPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
  isDropTarget: boolean;
  isDragging: boolean;
  dragTaskIds: string[];
}

function CalendarDayCell({
  d,
  ds,
  isToday,
  dayTasks,
  selectedTaskIds,
  onDayNewTask,
  onOpenCardMenu,
  onOpenDayMenu,
  onTaskClick,
  onChipPointerDown,
  onChipPointerMove,
  onChipPointerUp,
  onChipPointerCancel,
  isDropTarget,
  isDragging,
  dragTaskIds,
}: CalendarDayCellProps) {
  const [visibleCount, setVisibleCount] = useState(3);
  const shown = Math.min(visibleCount, dayTasks.length);
  const cardLongPress = useLongPress((p) => {
    const el = (p.target as HTMLElement | null)?.closest?.("[data-cal-task]");
    const id = el?.getAttribute("data-task-id");
    const task = dayTasks.find((t) => t.id === id);
    if (task) onOpenCardMenu(p, task);
  }, {});
  const dayLongPress = useLongPress((p) => onOpenDayMenu(p, ds), {});

  return (
    <div
      data-cal-day={ds}
      className={`group relative flex flex-col border-r border-b border-border/20 p-1 overflow-hidden hover:bg-hover/20 transition-colors cursor-pointer ${
        isDropTarget ? "ring-2 ring-inset ring-accent/60 bg-accent/10" : ""
      }`}
      onDoubleClick={() => onDayNewTask(d)}
      onPointerDown={(e) => {
        // Prevent the day-level long-press when pressing directly on a chip.
        if ((e.target as HTMLElement).closest?.("[data-cal-task]")) return;
        dayLongPress.onPointerDown(e);
      }}
      onPointerMove={dayLongPress.onPointerMove}
      onPointerUp={dayLongPress.onPointerUp}
      onPointerCancel={dayLongPress.onPointerCancel}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenDayMenu(e, ds);
      }}
    >
      <div className="flex items-start justify-between gap-1 shrink-0">
        <span
          className={`inline-flex items-center justify-center text-xs font-medium w-6 h-6 rounded-full ${
            isToday ? "gradient-bg text-[var(--on-gradient)]" : "text-secondary"
          }`}
        >
          {d}
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {dayTasks.slice(0, shown).map((task) => {
          const dragged = isDragging && dragTaskIds.includes(task.id);
          return (
            <div
              key={task.id}
              data-cal-task
              data-task-id={task.id}
              onClick={(e) => onTaskClick(e, task)}
              onPointerDown={(e) => {
                e.stopPropagation();
                onChipPointerDown(e, task, ds);
                if (e.target === e.currentTarget)
                  cardLongPress.onPointerDown(e);
              }}
              onPointerMove={(e) => {
                onChipPointerMove(e);
                cardLongPress.onPointerMove(e);
              }}
              onPointerUp={(e) => {
                onChipPointerUp(e);
                cardLongPress.onPointerUp(e);
              }}
              onPointerCancel={(e) => {
                onChipPointerCancel(e);
                cardLongPress.onPointerCancel();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onOpenCardMenu(e, task);
              }}
              className={`truncate text-[10px] text-scale-2xs rounded px-1 py-0.5 leading-tight cursor-pointer hover:brightness-110 transition-opacity ${
                selectedTaskIds.includes(task.id) ? "ring-1 ring-accent" : ""
              } ${dragged ? "opacity-40" : ""}`}
              style={{
                backgroundColor: `color-mix(in srgb, ${PRIORITY_COLORS[normalizePriority(task.priority)] || "var(--text-muted)"} 24%, transparent)`,
                borderLeft: `2px solid ${PRIORITY_COLORS[normalizePriority(task.priority)] || "var(--text-muted)"}`,
                color: "var(--text-primary)",
                touchAction: "none",
                ...(dragged
                  ? { cursor: "grabbing", pointerEvents: "none" as const }
                  : {}),
              }}
            >
              {task.start_time ? (
                <span className="font-semibold text-[var(--text-muted)] mr-0.5">
                  {taskTimeLabel(task)?.split(" - ")[0]} ·
                </span>
              ) : null}
              {task.title}
            </div>
          );
        })}
        {dayTasks.length > shown && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setVisibleCount((n) => Math.min(dayTasks.length, n + 10));
            }}
            className="pointer-coarse:min-h-0 block max-w-full truncate rounded px-1 text-left text-[9px] text-muted hover:text-primary"
            aria-label={`Show more tasks on ${ds}`}
          >
            +{Math.min(10, dayTasks.length - shown)} more
          </button>
        )}
        {visibleCount > 3 && shown >= dayTasks.length && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setVisibleCount(3);
            }}
            className="pointer-coarse:min-h-0 block max-w-full truncate rounded px-1 text-left text-[9px] text-muted hover:text-primary"
          >
            Show less
          </button>
        )}
      </div>
    </div>
  );
}

type CalendarDragSession = {
  pointerId: number;
  startX: number;
  startY: number;
  from: string;
  ids: string[];
  active: boolean;
  target: string | null;
};

export function CalendarView() {
  const tasks = useVisibleTasks();
  const activeListId = useAppStore((s) => s.activeListId);
  const setSelectedTaskId = useAppStore((s) => s.setSelectedTaskId);
  const selectedTaskIds = useAppStore((s) => s.selectedTaskIds);
  const toggleTaskSelected = useAppStore((s) => s.toggleTaskSelected);
  const clearTaskSelection = useAppStore((s) => s.clearTaskSelection);
  const { createTask, fetchTasks } = useTasks();
  const { showToast } = useToast();
  const [viewDate, setViewDate] = useState(() => new Date());
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [formDefaultDate, setFormDefaultDate] = useState<Date | null>(null);
  const [menu, setMenu] = useState<{
    state: ContextMenuState;
    x: number;
    y: number;
  } | null>(null);
  const [calConnected, setCalConnected] = useState<boolean | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [moveDays, setMoveDays] = useState(1);
  const [moving, setMoving] = useState(false);
  const dragRef = useRef<CalendarDragSession | null>(null);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const [dragIds, setDragIds] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ connected: boolean; last_synced_at: string | null }>(
        "/calendar/status",
      )
      .then((status) => {
        if (!cancelled) setCalConnected(status.connected);
      })
      .catch(() => {
        if (!cancelled) setCalConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCalendarSync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      await api.post("/calendar/pull");
      await fetchTasks();
      setSyncMessage("Synced");
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startOffset = calendarOffset(firstDay);
  const dayHeaders = weekdayHeaders();

  const tasksByDate = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const task of tasks) {
      const dates = new Set<string>();
      if (task.start_date) dates.add(task.start_date);
      if (task.due_date) dates.add(task.due_date);
      for (const ds of dates) {
        if (!map[ds]) map[ds] = [];
        map[ds].push(task);
      }
    }
    // Timed tasks sort earlier in the day, untimed after them (then priority)
    // so the day cell reads like a schedule rather than insertion order.
    for (const ds of Object.keys(map)) {
      map[ds].sort((a, b) => {
        const at = a.start_time ?? "";
        const bt = b.start_time ?? "";
        if (at && !bt) return -1;
        if (!at && bt) return 1;
        if (at && bt && at !== bt) return at < bt ? -1 : 1;
        const p = a.priority - b.priority;
        if (p !== 0) return p;
        return a.title.localeCompare(b.title);
      });
    }
    return map;
  }, [tasks]);

  const prevMonth = () => setViewDate(new Date(year, month - 1, 1));
  const nextMonth = () => setViewDate(new Date(year, month + 1, 1));

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const handleDayDoubleClick = (day: number) => {
    setFormDefaultDate(new Date(year, month, day));
    setShowTaskForm(true);
  };

  const handleCreateTask = async (data: Record<string, unknown>) => {
    try {
      await createTask({
        ...data,
        list_id:
          (data.list_id as string | undefined) ?? activeListId ?? undefined,
      });
      setShowTaskForm(false);
      setFormDefaultDate(null);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not create the task. Try again.";
      showToast(message, "error");
    }
  };

  const openCardMenu = useCallback((e: MenuPoint, task: Task) => {
    setMenu({ state: { kind: "task", task }, x: e.clientX, y: e.clientY });
  }, []);

  const openDayMenu = useCallback((e: MenuPoint, ds: string) => {
    setMenu({ state: { kind: "empty", day: ds }, x: e.clientX, y: e.clientY });
  }, []);

  const handleTaskClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>, task: Task) => {
      if (suppressClickRef.current) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        toggleTaskSelected(task.id);
        return;
      }
      clearTaskSelection();
      setSelectedTaskId(task.id);
    },
    [clearTaskSelection, setSelectedTaskId, toggleTaskSelected],
  );

  const handleChipPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>, task: Task, ds: string) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const ids = selectedTaskIds.includes(task.id)
        ? [...selectedTaskIds]
        : [task.id];
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        from: ds,
        ids,
        active: false,
        target: ds,
      };
      setDragIds(ids);
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    [selectedTaskIds],
  );

  const resetCalendarDrag = useCallback(() => {
    dragRef.current = null;
    setDragTarget(null);
    setDragIds([]);
    setDragging(false);
  }, []);

  const handleChipPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const session = dragRef.current;
      if (!session || session.pointerId !== e.pointerId) return;
      if (!session.active) {
        if (
          Math.hypot(e.clientX - session.startX, e.clientY - session.startY) < 6
        )
          return;
        session.active = true;
        setDragging(true);
      }
      e.preventDefault();
      const el = document.elementFromPoint(
        e.clientX,
        e.clientY,
      ) as HTMLElement | null;
      const cell = el?.closest?.("[data-cal-day]") as HTMLElement | null;
      const target = cell?.getAttribute("data-cal-day") ?? null;
      if (target !== session.target) {
        session.target = target;
        setDragTarget(target);
      }
    },
    [],
  );

  const handleChipPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const session = dragRef.current;
      if (!session || session.pointerId !== e.pointerId) return;
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      const { active, from, ids, target } = session;
      resetCalendarDrag();
      if (!active) return;
      // The browser fires click after pointerup. Suppress it so dropping a chip
      // never opens the task detail drawer.
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 350);
      if (!target || target === from || ids.length === 0) return;
      const delta = daysBetweenISO(from, target);
      if (delta === 0) return;
      void api
        .post("/tasks/batch-reschedule", { task_ids: ids, delta_days: delta })
        .then(() => fetchTasks())
        .catch(() => showToast("Could not move tasks. Try again.", "error"));
    },
    [fetchTasks, resetCalendarDrag, showToast],
  );

  const handleChipPointerCancel = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      resetCalendarDrag();
    },
    [resetCalendarDrag],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dragRef.current) resetCalendarDrag();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [resetCalendarDrag]);

  const handleEmptyNewTask = useCallback(
    (ctx: { day?: string; section?: { id: string | null; title: string } }) => {
      if (ctx.day) {
        const [y, m, d] = ctx.day.split("-").map(Number);
        setFormDefaultDate(new Date(y, m - 1, d));
        setShowTaskForm(true);
      } else {
        setFormDefaultDate(null);
        setShowTaskForm(true);
      }
    },
    [],
  );

  const handleBatchMove = async () => {
    if (selectedTaskIds.length === 0 || moveDays === 0) return;
    setMoving(true);
    try {
      await api.post("/tasks/batch-reschedule", {
        task_ids: selectedTaskIds,
        delta_days: moveDays,
      });
      await fetchTasks();
      clearTaskSelection();
      setMoveDays(1);
    } catch {
      setSyncMessage("Move failed");
    } finally {
      setMoving(false);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2 shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={prevMonth}
            className="btn bg-elevated px-3 py-1.5 text-xs text-secondary hover:bg-hover"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="text-sm font-semibold text-primary">
            {MONTHS[month]} {year}
          </span>
          <button
            onClick={nextMonth}
            className="btn bg-elevated px-3 py-1.5 text-xs text-secondary hover:bg-hover"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
        <div className="flex items-center gap-2">
          {selectedTaskIds.length > 0 && (
            <div className="flex items-center gap-1.5 rounded-full bg-elevated border border-border px-2 py-1">
              <span className="text-[10px] font-medium text-secondary">
                {selectedTaskIds.length} selected
              </span>
              <input
                type="number"
                value={moveDays}
                onChange={(e) => setMoveDays(Number(e.target.value))}
                aria-label="Move selected tasks by days"
                className="input-field w-14 text-xs"
              />
              <span className="text-[10px] text-muted">days</span>
              <button
                onClick={() => void handleBatchMove()}
                disabled={moving || moveDays === 0}
                className="btn btn-gradient px-2.5 py-0.5 text-[10px] rounded-md disabled:opacity-50"
              >
                {moving ? "Moving…" : "Move"}
              </button>
            </div>
          )}
          {syncMessage && (
            <span className="text-[10px] text-muted">{syncMessage}</span>
          )}
          <button
            onClick={handleCalendarSync}
            disabled={calConnected === false || syncing}
            title={
              calConnected === false
                ? "Connect Google Calendar in Settings to sync"
                : "Pull new events from Google Calendar"
            }
            className="btn bg-elevated px-3 py-1.5 text-xs text-secondary hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {syncing ? (
              <svg
                className="animate-spin"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 12a9 9 0 1 1-9-9" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
            )}
            Sync
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 border-b border-border bg-surface shrink-0">
        {dayHeaders.map((h) => (
          <div
            key={h}
            className="text-center text-[10px] font-semibold uppercase text-muted py-2 border-r border-border/30 last:border-r-0"
          >
            {h}
          </div>
        ))}
      </div>

      <div
        className={`grid grid-cols-7 flex-1 ${dragging ? "cursor-grabbing" : ""}`}
        style={{
          gridTemplateRows: `repeat(${Math.ceil((lastDay.getDate() + startOffset) / 7)}, minmax(0, 1fr))`,
        }}
        onPointerDown={(e) => {
          const target = e.target as HTMLElement;
          if (
            target.closest(
              "[data-cal-task], button, input, select, textarea, a",
            )
          )
            return;
          clearTaskSelection();
        }}
      >
        {Array.from({ length: startOffset }).map((_, i) => (
          <div
            key={`empty-${i}`}
            className="border-r border-b border-border/20"
          />
        ))}
        {Array.from({ length: lastDay.getDate() }, (_, i) => i + 1).map((d) => {
          const ds = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const isToday = ds === todayStr;
          const dayTasks = tasksByDate[ds] || [];

          return (
            <CalendarDayCell
              key={ds}
              d={d}
              ds={ds}
              isToday={isToday}
              dayTasks={dayTasks}
              selectedTaskIds={selectedTaskIds}
              onDayNewTask={handleDayDoubleClick}
              onOpenCardMenu={openCardMenu}
              onOpenDayMenu={openDayMenu}
              onTaskClick={handleTaskClick}
              onChipPointerDown={handleChipPointerDown}
              onChipPointerMove={handleChipPointerMove}
              onChipPointerUp={handleChipPointerUp}
              onChipPointerCancel={handleChipPointerCancel}
              isDropTarget={dragTarget === ds}
              isDragging={dragging}
              dragTaskIds={dragIds}
            />
          );
        })}
      </div>

      <Modal
        isOpen={showTaskForm && !!formDefaultDate}
        onClose={() => {
          setShowTaskForm(false);
          setFormDefaultDate(null);
        }}
        title="Create Task"
      >
        <TaskForm
          onSubmit={handleCreateTask}
          onCancel={() => {
            setShowTaskForm(false);
            setFormDefaultDate(null);
          }}
          defaultDate={
            formDefaultDate ? toLocalDateString(formDefaultDate) : undefined
          }
        />
      </Modal>

      <ContextMenu
        open={!!menu}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        onClose={() => setMenu(null)}
      >
        <TaskContextMenu
          menu={menu?.state ?? null}
          onClose={() => setMenu(null)}
          onNewTask={handleEmptyNewTask}
        />
      </ContextMenu>
    </div>
  );
}
