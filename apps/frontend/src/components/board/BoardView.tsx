"use client";

import { useCallback, useMemo, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  MouseSensor,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  closestCorners,
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { api } from "@/lib/api";
import type { Task, TaskStatus } from "@/types/task";
import type { BoardSection } from "@/lib/board-sections";
import { useAppStore } from "@/stores/app-store";
import { useTasks } from "@/hooks/useTasks";
import { useBoardSections } from "@/hooks/useBoardSections";
import {
  UNSORTED_ID,
  applyBoardDrop,
  applyBoardGroupDrop,
  boardComparator,
  byBoardOrder,
  computeBoardDrop,
  unsortedTasks,
  type BoardSort,
} from "@/lib/board-dnd";
import { useLocalBool } from "@/lib/use-local-bool";
import { KanbanToolbar, type BoardFilter } from "@/components/kanban/KanbanToolbar";
import { KanbanAddCard } from "@/components/kanban/KanbanAddCard";
import { TaskForm } from "@/components/tasks/TaskForm";
import { Modal } from "@/components/ui/Modal";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { TaskContextMenu, type ContextMenuState } from "@/components/tasks/TaskContextMenu";
import { BoardCard } from "./BoardCard";
import {
  cardColor,
  isWideCard,
  loadColorOverrides,
  pickDecoration,
  saveColorOverrides,
} from "./board-utils";

// Same "Film Grain" noise data-URI as design-tokens.json (backgroundPresets).
const NOISE_BACKGROUND =
  'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 256 256\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'n\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23n)\' opacity=\'0.05\'/%3E%3C/svg%3E")';

interface BoardViewProps {
  tasks: Task[];
}

interface BoardGroupProps {
  title: string;
  color: string | null;
  isOver?: boolean;
  droppableId: string;
  /** board_section_id to pin a created task to (null for status/Unsorted columns). */
  boardSectionId: string | null;
  /** Status a created task starts in. */
  status: string;
  listId: string | null;
  tasks: Task[];
  childrenByParent: Map<string, Task[]>;
  overrides: Record<string, string>;
  selectedTaskIds: Set<string>;
  onOpen: (id: string) => void;
  onToggleSubtask: (sub: Task) => void;
  onToggleTask: (task: Task) => void;
  onSetColor: (taskId: string, color: string) => void;
  onAdd: () => void;
  onEmptyContextMenu?: (e: React.MouseEvent, droppableId: string, title: string) => void;
  onCardContextMenu?: (e: React.MouseEvent, task: Task) => void;
}

function BoardGroup({
  title,
  color,
  isOver,
  droppableId,
  boardSectionId,
  status,
  listId,
  tasks,
  childrenByParent,
  onOpen,
  onToggleSubtask,
  onToggleTask,
  onSetColor,
  overrides,
  selectedTaskIds,
  onAdd,
  onEmptyContextMenu,
  onCardContextMenu,
}: BoardGroupProps) {
  const { setNodeRef } = useDroppable({ id: droppableId });
  const strategy = rectSortingStrategy;

  return (
    <div
      ref={setNodeRef}
      data-testid="board-group"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onEmptyContextMenu?.(e, droppableId, title);
      }}
      className={`flex w-full flex-col rounded-2xl border bg-surface/60 p-4 transition-colors ${
        isOver ? "border-accent/60 ring-2 ring-accent/30" : "border-border"
      }`}
    >
      <div className="mb-3 flex items-center gap-2">
        <span
          className="block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: color || "var(--text-muted)" }}
        />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">{title}</h3>
        <span className="rounded-full bg-elevated px-2 py-0.5 text-xs text-muted">{tasks.length}</span>
      </div>

      <div>
        <SortableContext items={tasks.map((t) => t.id)} strategy={strategy}>
          <div
            data-testid="board-masonry"
            className="grid grid-flow-dense gap-3 sm:gap-4 grid-cols-[repeat(auto-fill,minmax(230px,1fr))]"
          >
            {tasks.map((task) => (
              <BoardCard
                key={task.id}
                task={task}
                subtasks={childrenByParent.get(task.id) ?? []}
                color={cardColor(task.id, overrides)}
                decoration={pickDecoration(task.id)}
                spanClass={isWideCard(task.id) ? "sm:col-span-2" : ""}
                selected={selectedTaskIds.has(task.id)}
                onOpen={onOpen}
                onToggleSubtask={(sub) => onToggleSubtask(sub)}
                onToggleTask={(t) => onToggleTask(t)}
                onSetColor={onSetColor}
                onContextMenu={onCardContextMenu}
              />
            ))}
          </div>
        </SortableContext>
      </div>

      <div className="mt-3">
        <KanbanAddCard
          status={status}
          boardSectionId={boardSectionId}
          listId={listId}
          onAdd={onAdd}
        />
      </div>
    </div>
  );
}

export function BoardView({ tasks }: BoardViewProps) {
  const allTasks = useAppStore((s) => s.tasks);
  const setSelectedTaskId = useAppStore((s) => s.setSelectedTaskId);
  const setTasks = useAppStore((s) => s.setTasks);
  const activeListId = useAppStore((s) => s.activeListId);
  const { fetchTasks, updateTask, createTask } = useTasks();
  const { sections, addSection } = useBoardSections("board");

  const [filter, setFilter] = useState<BoardFilter>("all");
  const [sort, setSort] = useState<BoardSort>("manual");
  const comparator = useMemo(() => boardComparator(sort), [sort]);

  const soundOn = useLocalBool("prysm_notif_sound", true);
  const rewardsOn = useLocalBool("prysm_rewards", true);
  const [overrides, setOverrides] = useState<Record<string, string>>(() => loadColorOverrides());
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [menu, setMenu] = useState<{ state: ContextMenuState; x: number; y: number } | null>(null);
  const [scopedCreate, setScopedCreate] = useState<{
    id: string | null;
    title: string;
    status: TaskStatus;
    full: boolean;
  } | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } })
  );

  // Full-store grouping (not the filtered list) so a filtered-out parent still
  // shows its complete checklist when the card is opened.
  const childrenByParent = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of allTasks) {
      if (t.parent_task_id) {
        const list = map.get(t.parent_task_id) ?? [];
        list.push(t);
        map.set(t.parent_task_id, list);
      }
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.created_at.localeCompare(b.created_at));
    }
    return map;
  }, [allTasks]);

  const cards = useMemo(
    () =>
      tasks.filter((t) => {
        if (t.parent_task_id) return false;
        if (filter === "active") return t.status !== "done" && t.status !== "cancelled";
        if (filter === "completed") return t.status === "done";
        return true;
      }),
    [tasks, filter]
  );

  const cardsBySection = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const section of sections) {
      map.set(
        section.id,
        cards.filter((t) => t.board_section_id === section.id).sort(comparator)
      );
    }
    return map;
  }, [cards, sections, comparator]);

  const unsorted = useMemo(
    () => unsortedTasks(cards).sort(comparator),
    [cards, comparator]
  );

  const setOverride = useCallback((taskId: string, color: string) => {
    setOverrides((prev) => {
      const next = { ...prev, [taskId]: color };
      saveColorOverrides(next);
      return next;
    });
  }, []);

  const handleToggleSubtask = useCallback(
    async (sub: Task) => {
      const next = sub.status === "done" ? "todo" : "done";
      // Optimistic store write; updateTask's refetch reconciles shortly after.
      setTasks(allTasks.map((t) => (t.id === sub.id ? { ...t, status: next } : t)));
      await updateTask(sub.id, { status: next });
    },
    [allTasks, setTasks, updateTask]
  );

  const handleToggleTask = useCallback(
    async (task: Task) => {
      const next = task.status === "done" ? "todo" : "done";
      if (next === "done") {
        if (soundOn) {
          const { playCompletionSound } = await import("@/lib/sounds");
          playCompletionSound();
        }
        if (rewardsOn) {
          const { celebrate } = await import("@/lib/celebrate");
          celebrate();
        }
      }
      setTasks(allTasks.map((t) => (t.id === task.id ? { ...t, status: next } : t)));
      await updateTask(task.id, { status: next });
    },
    [allTasks, setTasks, soundOn, rewardsOn, updateTask]
  );

  // Open the board creation modal, scoped to a column. `full` hosts the rich
  // TaskForm; otherwise the modal shows the quick inline add with an "Add
  // details" path into the form.
  const openCreateModal = useCallback(
    (target: { id: string | null; title: string; status: TaskStatus; full?: boolean }) => {
      setScopedCreate({
        id: target.id,
        title: target.title,
        status: target.status,
        full: !!target.full,
      });
    },
    []
  );

  // Empty-state CTA and the toolbar "+ New" open the rich form scoped to the
  // first column (or Unsorted when the board has no sections yet).
  const handleCreate = useCallback(() => {
    const first = sections[0];
    openCreateModal({
      id: first ? (first.status ? null : first.id) : null,
      title: first?.title ?? "Unsorted",
      status: (first?.status as TaskStatus) || "backlog",
      full: true,
    });
  }, [sections, openCreateModal]);

  const handleScopedFormSubmit = useCallback(
    async (data: Record<string, unknown>) => {
      try {
        await createTask({
          ...data,
          list_id: (data.list_id as string | undefined) ?? activeListId ?? undefined,
        });
        setScopedCreate(null);
      } catch {
        // Keep the modal open so the user can retry.
      }
    },
    [createTask, activeListId]
  );

  const openCardMenu = useCallback((e: React.MouseEvent, task: Task) => {
    setMenu({ state: { kind: "task", task }, x: e.clientX, y: e.clientY });
  }, []);

  const openEmptyMenu = useCallback((e: React.MouseEvent, droppableId: string, title: string) => {
    setMenu({
      state: { kind: "empty", section: { id: droppableId, title } },
      x: e.clientX,
      y: e.clientY,
    });
  }, []);

  // "New task in {section}" opens the quick-create modal scoped to that section
  // (the Unsorted group creates an un-filed backlog task).
  const handleEmptyNewTask = useCallback(
    (ctx: { day?: string; section?: { id: string | null; title: string } }) => {
      if (ctx.section) {
        const section = sections.find((s) => s.id === ctx.section!.id);
        openCreateModal({
          id: ctx.section.id,
          title: ctx.section.title,
          status: (section?.status as TaskStatus) || "backlog",
        });
        return;
      }
      window.dispatchEvent(new CustomEvent("prysm-new-task"));
    },
    [sections, openCreateModal]
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const task = cards.find((t) => t.id === event.active.id);
      if (task) setActiveTask(task);
    },
    [cards]
  );

  const selectedTaskIds = useAppStore((s) => s.selectedTaskIds);

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveTask(null);
      const { active, over } = event;
      if (!over) return;

      const taskId = active.id as string;
      const task = cards.find((t) => t.id === taskId);
      if (!task) return;

      const drop = computeBoardDrop(cards, sections, taskId, over.id as string);
      if (!drop) return;

      const store = useAppStore.getState();
      const selectedIds = store.selectedTaskIds;
      const isGroupDrag = selectedIds.length > 1 && selectedIds.includes(taskId);

      if (isGroupDrag) {
        const groupOrder = selectedIds
          .map((id) => cards.find((t) => t.id === id))
          .filter((t): t is Task => !!t)
          .sort(byBoardOrder)
          .map((t) => t.id);
        const previous = store.tasks;
        setTasks(applyBoardGroupDrop(store.tasks, groupOrder, drop, sections));
        try {
          await api.post("/tasks/batch-board-move", {
            task_ids: groupOrder,
            section_id: drop.sectionId,
            index: drop.index,
          });
          await fetchTasks();
          store.clearTaskSelection();
        } catch {
          setTasks(previous);
          store.clearTaskSelection();
        }
        return;
      }

      setTasks(applyBoardDrop(allTasks, taskId, drop, sections));

      try {
        await api.post("/tasks/board-move", {
          task_id: taskId,
          section_id: drop.sectionId,
          index: drop.index,
        });
        await fetchTasks();
      } catch {
        setTasks(allTasks);
      }
    },
    [cards, sections, allTasks, setTasks, fetchTasks]
  );

  return (
    <div className="relative flex h-full min-w-0 flex-col bg-base">
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{ backgroundImage: NOISE_BACKGROUND, backgroundSize: "256px 256px", opacity: 0.35 }}
      />

      <KanbanToolbar
        onAddSection={(title) => void addSection({ title, color: "var(--text-muted)" })}
        onAddTask={handleCreate}
        filter={filter}
        onFilterChange={setFilter}
        sort={sort}
        onSortChange={setSort}
      />

      <div
        className="relative z-10 min-h-0 flex-1 overflow-auto px-6 py-6"
        style={{ scrollBehavior: "smooth", overscrollBehaviorX: "contain", WebkitOverflowScrolling: "touch" }}
        onPointerDown={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest("[data-board-card], button, input, select, textarea, a, [data-task-bar]")) return;
          useAppStore.getState().clearTaskSelection();
        }}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div className="flex flex-col gap-8">
            {sections.map((section) => (
              <BoardGroup
                key={section.id}
                title={section.title}
                color={section.color}
                droppableId={section.id}
                boardSectionId={section.status ? null : section.id}
                status={section.status || "backlog"}
                listId={activeListId}
                tasks={cardsBySection.get(section.id) ?? []}
                childrenByParent={childrenByParent}
                overrides={overrides}
                selectedTaskIds={new Set(selectedTaskIds)}
                onOpen={setSelectedTaskId}
                onToggleSubtask={(sub) => void handleToggleSubtask(sub)}
                onToggleTask={(t) => void handleToggleTask(t)}
                onSetColor={setOverride}
                onAdd={() => void fetchTasks()}
                onEmptyContextMenu={openEmptyMenu}
                onCardContextMenu={openCardMenu}
              />
            ))}

            <BoardGroup
              title="Unsorted"
              color={null}
              droppableId={UNSORTED_ID}
              boardSectionId={null}
              status="backlog"
              listId={activeListId}
              tasks={unsorted}
              childrenByParent={childrenByParent}
              overrides={overrides}
              selectedTaskIds={new Set(selectedTaskIds)}
              onOpen={setSelectedTaskId}
              onToggleSubtask={(sub) => void handleToggleSubtask(sub)}
              onToggleTask={(t) => void handleToggleTask(t)}
              onSetColor={setOverride}
              onAdd={() => void fetchTasks()}
              onEmptyContextMenu={openEmptyMenu}
              onCardContextMenu={openCardMenu}
            />
          </div>

          <DragOverlay>
            {activeTask ? (
              <div className="opacity-90">
                <BoardCard
                  task={activeTask}
                  subtasks={childrenByParent.get(activeTask.id) ?? []}
                  color={cardColor(activeTask.id, overrides)}
                  width={300}
                  decoration={pickDecoration(activeTask.id)}
                  onOpen={() => {}}
                  onToggleSubtask={() => {}}
                  onToggleTask={() => {}}
                  onSetColor={() => {}}
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>

        {cards.length === 0 && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4">
            <div className="pointer-events-auto max-w-sm rounded-2xl border border-border bg-surface/90 p-6 text-center backdrop-blur-sm">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              </div>
              <p className="mt-3 text-sm font-semibold text-primary">A quiet board - for now</p>
              <p className="mt-1 text-xs leading-relaxed text-secondary">
                No tasks match this view yet. Create a task and drop it into a section.
              </p>
              <button
                onClick={handleCreate}
                className="btn-gradient mt-4 rounded-lg px-4 py-2 text-xs font-semibold"
              >
                Create a task
              </button>
            </div>
          </div>
        )}
      </div>

      <Modal
        isOpen={!!scopedCreate}
        onClose={() => setScopedCreate(null)}
        title={scopedCreate ? `New task in ${scopedCreate.title}` : "New Task"}
      >
        {scopedCreate &&
          (scopedCreate.full ? (
            <TaskForm
              key={scopedCreate.id ?? "unsorted"}
              onSubmit={handleScopedFormSubmit}
              onCancel={() => setScopedCreate(null)}
              defaultStatus={scopedCreate.status}
              boardSectionId={
                scopedCreate.id && scopedCreate.id !== UNSORTED_ID ? scopedCreate.id : null
              }
            />
          ) : (
            <div className="flex flex-col gap-2">
              <KanbanAddCard
                key={scopedCreate.id ?? "none"}
                autoExpand
                status={scopedCreate.status}
                boardSectionId={
                  scopedCreate.id && scopedCreate.id !== UNSORTED_ID ? scopedCreate.id : null
                }
                listId={activeListId}
                onAdd={() => {
                  setScopedCreate(null);
                  void fetchTasks();
                }}
              />
              <button
                type="button"
                onClick={() => setScopedCreate((prev) => (prev ? { ...prev, full: true } : prev))}
                className="self-start text-xs text-secondary transition-colors hover:text-primary"
              >
                Add details
              </button>
            </div>
          ))}
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
