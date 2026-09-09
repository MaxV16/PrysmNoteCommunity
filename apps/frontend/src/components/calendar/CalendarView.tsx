"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { useAppStore } from "@/stores/app-store";
import type { Task } from "@/types/task";
import { Modal } from "@/components/ui/Modal";
import { TaskForm } from "@/components/tasks/TaskForm";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { TaskContextMenu, type ContextMenuState } from "@/components/tasks/TaskContextMenu";
import { useTasks } from "@/hooks/useTasks";
import { useLongPress } from "@/lib/use-long-press";
import { api } from "@/lib/api";
import { TIER_COLORS, normalizePriority } from "@/lib/priority";
import { taskTimeLabel } from "@/lib/task-time";
import { calendarOffset, weekdayHeaders } from "@/lib/dates";

const PRIORITY_COLORS = TIER_COLORS;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

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
  onToggleSelect: (id: string) => void;
  onOpenTask: (id: string) => void;
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
  onToggleSelect,
  onOpenTask,
}: CalendarDayCellProps) {
  const maxShown = 3;
  const cardLongPress = useLongPress(
    (p) => {
      const el = (p.target as HTMLElement | null)?.closest?.("[data-cal-task]");
      const id = el?.getAttribute("data-task-id");
      const task = dayTasks.find((t) => t.id === id);
      if (task) onOpenCardMenu(p, task);
    },
    {}
  );
  const dayLongPress = useLongPress(
    (p) => onOpenDayMenu(p, ds),
    {}
  );

  return (
    <div
      className="group relative border-r border-b border-border/20 p-1 overflow-hidden hover:bg-hover/20 transition-colors cursor-pointer"
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
      <span
        className={`inline-flex items-center justify-center text-xs font-medium w-6 h-6 rounded-full mb-0.5 ${
          isToday ? "gradient-bg text-[var(--on-gradient)] shadow-glow" : "text-secondary"
        }`}
      >
        {d}
      </span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDayNewTask(d);
        }}
        aria-label={`Add task on ${ds}`}
        className="pointer-coarse:opacity-100 absolute right-1 top-1 z-10 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-elevated text-secondary opacity-0 transition-opacity hover:bg-hover hover:text-primary group-hover:opacity-100"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <div className="space-y-0.5">
        {dayTasks.slice(0, maxShown).map((task) => (
          <div
            key={task.id}
            data-cal-task
            data-task-id={task.id}
            onClick={(e) => {
              e.stopPropagation();
              if (e.metaKey || e.ctrlKey) {
                e.preventDefault();
                onToggleSelect(task.id);
                return;
              }
              onOpenTask(task.id);
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              // Keep the chip's own drag-free pointer semantics for long-press.
              if (e.target === e.currentTarget) cardLongPress.onPointerDown(e);
            }}
            onPointerMove={cardLongPress.onPointerMove}
            onPointerUp={cardLongPress.onPointerUp}
            onPointerCancel={cardLongPress.onPointerCancel}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onOpenCardMenu(e, task);
            }}
            className={`truncate text-[10px] rounded px-1 py-0.5 leading-tight cursor-pointer hover:brightness-110 ${
              selectedTaskIds.includes(task.id) ? "ring-1 ring-accent" : ""
            }`}
            style={{
              backgroundColor: (PRIORITY_COLORS[normalizePriority(task.priority)] || "#9E9E9E") + "22",
              borderLeft: `2px solid ${PRIORITY_COLORS[normalizePriority(task.priority)] || "#9E9E9E"}`,
              color: "var(--text-primary)",
            }}
          >
            {task.start_time ? (
              <span className="font-semibold text-[var(--text-muted)] mr-0.5">
                {taskTimeLabel(task)?.split(" - ")[0]} ·
              </span>
            ) : null}
            {task.title}
          </div>
        ))}
        {dayTasks.length > maxShown && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpenDayMenu(e, ds);
            }}
            className="pointer-coarse:min-h-0 block max-w-full truncate rounded px-1 text-left text-[9px] text-muted hover:text-primary"
            aria-label={`${dayTasks.length} tasks on ${ds}`}
          >
            +{dayTasks.length - maxShown} more
          </button>
        )}
      </div>
    </div>
  );
}

export function CalendarView() {
  const tasks = useAppStore((s) => s.tasks);
  const activeListId = useAppStore((s) => s.activeListId);
  const setSelectedTaskId = useAppStore((s) => s.setSelectedTaskId);
  const selectedTaskIds = useAppStore((s) => s.selectedTaskIds);
  const toggleTaskSelected = useAppStore((s) => s.toggleTaskSelected);
  const clearTaskSelection = useAppStore((s) => s.clearTaskSelection);
  const { createTask, fetchTasks } = useTasks();
  const [viewDate, setViewDate] = useState(() => new Date());
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [formDefaultDate, setFormDefaultDate] = useState<Date | null>(null);
  const [menu, setMenu] = useState<{ state: ContextMenuState; x: number; y: number } | null>(null);
  const [calConnected, setCalConnected] = useState<boolean | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [moveDays, setMoveDays] = useState(1);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get<{ connected: boolean; last_synced_at: string | null }>("/calendar/status")
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
      if (task.is_archived || task.status === "done" || task.status === "cancelled") continue;
      if (activeListId && task.list_id !== activeListId) continue;
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
  }, [tasks, activeListId]);

  const prevMonth = () => setViewDate(new Date(year, month - 1, 1));
  const nextMonth = () => setViewDate(new Date(year, month + 1, 1));

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const handleDayDoubleClick = (day: number) => {
    setFormDefaultDate(new Date(year, month, day));
    setShowTaskForm(true);
  };

  const handleCreateTask = async (data: Record<string, unknown>) => {
    await createTask({
      ...data,
      list_id: (data.list_id as string | undefined) ?? activeListId ?? undefined,
    });
    setShowTaskForm(false);
    setFormDefaultDate(null);
  };

  const openCardMenu = useCallback((e: MenuPoint, task: Task) => {
    setMenu({ state: { kind: "task", task }, x: e.clientX, y: e.clientY });
  }, []);

  const openDayMenu = useCallback((e: MenuPoint, ds: string) => {
    setMenu({ state: { kind: "empty", day: ds }, x: e.clientX, y: e.clientY });
  }, []);

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
    []
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
    <div className="flex flex-col h-full bg-base">
      <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2 shrink-0">
        <div className="flex items-center gap-2">
          <button onClick={prevMonth} className="btn bg-elevated px-3 py-1.5 text-xs text-secondary hover:bg-hover">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <span className="text-sm font-semibold text-primary">{MONTHS[month]} {year}</span>
          <button onClick={nextMonth} className="btn bg-elevated px-3 py-1.5 text-xs text-secondary hover:bg-hover">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
        </div>
        <div className="flex items-center gap-2">
          {selectedTaskIds.length > 0 && (
            <div className="flex items-center gap-1.5 rounded-full bg-elevated border border-border px-2 py-1">
              <span className="text-[10px] font-medium text-secondary">{selectedTaskIds.length} selected</span>
              <input
                type="number"
                value={moveDays}
                onChange={(e) => setMoveDays(Number(e.target.value))}
                aria-label="Move selected tasks by days"
                className="w-14 rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-primary outline-none focus:border-accent"
              />
              <span className="text-[10px] text-muted">days</span>
              <button
                onClick={() => void handleBatchMove()}
                disabled={moving || moveDays === 0}
                className="btn btn-gradient px-2.5 py-0.5 text-[10px] rounded-full disabled:opacity-50"
              >
                {moving ? "Moving…" : "Move"}
              </button>
            </div>
          )}
          {syncMessage && <span className="text-[10px] text-muted">{syncMessage}</span>}
          <button
            onClick={handleCalendarSync}
            disabled={calConnected === false || syncing}
            title={calConnected === false ? "Connect Google Calendar in Settings to sync" : "Pull new events from Google Calendar"}
            className="btn bg-elevated px-3 py-1.5 text-xs text-secondary hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {syncing ? (
              <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 1 1-9-9"/>
                <polyline points="21 3 21 9 15 9"/>
              </svg>
            )}
            Sync
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 border-b border-border bg-surface shrink-0">
        {dayHeaders.map((h) => (
          <div key={h} className="text-center text-[10px] font-semibold uppercase text-muted py-2 border-r border-border/30 last:border-r-0">
            {h}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 flex-1" style={{ gridTemplateRows: `repeat(${Math.ceil((lastDay.getDate() + startOffset) / 7)}, minmax(0, 1fr))` }} onPointerDown={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest("[data-cal-task], button, input, select, textarea, a")) return;
          clearTaskSelection();
        }}>
        {Array.from({ length: startOffset }).map((_, i) => (
          <div key={`empty-${i}`} className="border-r border-b border-border/20" />
        ))}
        {Array.from({ length: lastDay.getDate() }, (_, i) => i + 1).map((d) => {
          const ds = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const isToday = ds === todayStr;
          const dayTasks = tasksByDate[ds] || [];

          return (
            <CalendarDayCell
              key={d}
              d={d}
              ds={ds}
              isToday={isToday}
              dayTasks={dayTasks}
              selectedTaskIds={selectedTaskIds}
              onDayNewTask={handleDayDoubleClick}
              onOpenCardMenu={openCardMenu}
              onOpenDayMenu={openDayMenu}
              onToggleSelect={toggleTaskSelected}
              onOpenTask={(id) => {
                clearTaskSelection();
                setSelectedTaskId(id);
              }}
            />
          );
        })}
      </div>

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
