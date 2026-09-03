"use client";

import { useCallback, useMemo, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  closestCorners,
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { api } from "@/lib/api";
import type { Task } from "@/types/task";
import type { BoardSection } from "@/lib/board-sections";
import { useAppStore } from "@/stores/app-store";
import { useTasks } from "@/hooks/useTasks";
import { useBoardSections } from "@/hooks/useBoardSections";
import { usePreferencesStore } from "@/stores/preferences-store";
import {
  PREF_BOARD_BOARD_LAYOUT,
  PREF_BOARD_BOARD_SCROLL,
  type CardLayout,
  type ScrollDirection,
} from "@/lib/preferences";
import {
  UNSORTED_ID,
  applyBoardDrop,
  byBoardOrder,
  computeBoardDrop,
  unsortedTasks,
} from "@/lib/board-dnd";
import { useLocalBool } from "@/lib/use-local-bool";
import { KanbanToolbar } from "@/components/kanban/KanbanToolbar";
import { KanbanAddCard } from "@/components/kanban/KanbanAddCard";
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
  tasks: Task[];
  cardLayout: CardLayout;
  scrollDirection: ScrollDirection;
  childrenByParent: Map<string, Task[]>;
  overrides: Record<string, string>;
  onOpen: (id: string) => void;
  onToggleSubtask: (sub: Task) => void;
  onToggleTask: (task: Task) => void;
  onSetColor: (taskId: string, color: string) => void;
  onEmptyContextMenu?: (e: React.MouseEvent, droppableId: string, title: string) => void;
  onCardContextMenu?: (e: React.MouseEvent, task: Task) => void;
}

function BoardGroup({
  title,
  color,
  isOver,
  droppableId,
  tasks,
  cardLayout,
  scrollDirection,
  childrenByParent,
  onOpen,
  onToggleSubtask,
  onToggleTask,
  onSetColor,
  overrides,
  onEmptyContextMenu,
  onCardContextMenu,
}: BoardGroupProps) {
  const { setNodeRef } = useDroppable({ id: droppableId });
  const strategy = cardLayout === "side_by_side" ? rectSortingStrategy : verticalListSortingStrategy;

  return (
    <div
      ref={setNodeRef}
      data-testid="board-group"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onEmptyContextMenu?.(e, droppableId, title);
      }}
      className={`flex ${
        scrollDirection === "horizontal" ? "min-w-[480px] flex-1" : "w-full"
      } flex-col rounded-2xl border bg-white/[0.02] p-4 transition-colors ${
        isOver ? "border-accent/60 ring-2 ring-accent/30" : "border-white/5"
      }`}
    >
      <div className="mb-3 flex items-center gap-2">
        <span
          className="block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: color || "#9E9E9E" }}
        />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">{title}</h3>
        <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-muted">{tasks.length}</span>
      </div>

      <div className={cardLayout === "side_by_side" ? "" : "flex flex-col gap-3"}>
        <SortableContext items={tasks.map((t) => t.id)} strategy={strategy}>
          {cardLayout === "side_by_side" ? (
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
                  onOpen={onOpen}
                  onToggleSubtask={(sub) => onToggleSubtask(sub)}
                  onToggleTask={(t) => onToggleTask(t)}
                  onSetColor={onSetColor}
                  onContextMenu={onCardContextMenu}
                />
              ))}
            </div>
          ) : (
            tasks.map((task) => (
              <BoardCard
                key={task.id}
                task={task}
                subtasks={childrenByParent.get(task.id) ?? []}
                color={cardColor(task.id, overrides)}
                decoration={pickDecoration(task.id)}
                onOpen={onOpen}
                onToggleSubtask={(sub) => onToggleSubtask(sub)}
                onToggleTask={(t) => onToggleTask(t)}
                onSetColor={onSetColor}
                onContextMenu={onCardContextMenu}
              />
            ))
          )}
        </SortableContext>
      </div>

      {tasks.length === 0 && (
        <p className="mt-2 text-xs text-muted">No tasks here yet - drop one or create it elsewhere.</p>
      )}
    </div>
  );
}

export function BoardView({ tasks }: BoardViewProps) {
  const allTasks = useAppStore((s) => s.tasks);
  const setSelectedTaskId = useAppStore((s) => s.setSelectedTaskId);
  const setTasks = useAppStore((s) => s.setTasks);
  const { fetchTasks, updateTask } = useTasks();
  const { sections, addSection } = useBoardSections("board");

  const scrollDirection = usePreferencesStore(
    (s) => (s.prefs[PREF_BOARD_BOARD_SCROLL] as ScrollDirection) || "vertical"
  );
  const cardLayout = usePreferencesStore(
    (s) => (s.prefs[PREF_BOARD_BOARD_LAYOUT] as CardLayout) || "side_by_side"
  );
  const setPreference = usePreferencesStore((s) => s.setPreference);

  const soundOn = useLocalBool("prysm_notif_sound", true);
  const [overrides, setOverrides] = useState<Record<string, string>>(() => loadColorOverrides());
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [menu, setMenu] = useState<{ state: ContextMenuState; x: number; y: number } | null>(null);
  const [scopedCreate, setScopedCreate] = useState<{ id: string | null; title: string } | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
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

  const cards = useMemo(() => tasks.filter((t) => !t.parent_task_id), [tasks]);

  const cardsBySection = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const section of sections) {
      map.set(
        section.id,
        cards.filter((t) => t.board_section_id === section.id).sort(byBoardOrder)
      );
    }
    return map;
  }, [cards, sections]);

  const unsorted = useMemo(() => unsortedTasks(cards).sort(byBoardOrder), [cards]);

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
      if (next === "done" && soundOn) {
        const { playCompletionSound } = await import("@/lib/sounds");
        playCompletionSound();
      }
      setTasks(allTasks.map((t) => (t.id === task.id ? { ...t, status: next } : t)));
      await updateTask(task.id, { status: next });
    },
    [allTasks, setTasks, soundOn, updateTask]
  );

  const handleCreate = useCallback(() => {
    window.dispatchEvent(new CustomEvent("prysm-new-task"));
  }, []);

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
        setScopedCreate(ctx.section);
        return;
      }
      window.dispatchEvent(new CustomEvent("prysm-new-task"));
    },
    []
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const task = cards.find((t) => t.id === event.active.id);
      if (task) setActiveTask(task);
    },
    [cards]
  );

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
      {/* Fixed dark canvas treatment is intentional for this view in all themes:
          the near-black scrapbook desk is the defining visual. Do not gate it on
          the active theme. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundColor: "#08080c",
          backgroundImage: "radial-gradient(1200px 800px at 50% -10%, #15151f, transparent 70%)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{ backgroundImage: NOISE_BACKGROUND, backgroundSize: "256px 256px", opacity: 0.35 }}
      />

      <KanbanToolbar
        scrollDirection={scrollDirection}
        cardLayout={cardLayout}
        onScrollDirectionChange={(d) => setPreference(PREF_BOARD_BOARD_SCROLL, d)}
        onCardLayoutChange={(l) => setPreference(PREF_BOARD_BOARD_LAYOUT, l)}
        onAddSection={(title) => void addSection({ title, color: "#3d4a63" })}
      />

      <div
        className="relative z-10 min-h-0 flex-1 overflow-auto px-6 py-6"
        style={{ scrollBehavior: "smooth", overscrollBehaviorX: "contain", WebkitOverflowScrolling: "touch" }}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div
            className={
              scrollDirection === "horizontal"
                ? "flex items-start gap-6"
                : "flex flex-col gap-8"
            }
          >
            {sections.map((section) => (
              <BoardGroup
                key={section.id}
                title={section.title}
                color={section.color}
                droppableId={section.id}
                tasks={cardsBySection.get(section.id) ?? []}
                cardLayout={cardLayout}
                scrollDirection={scrollDirection}
                childrenByParent={childrenByParent}
                overrides={overrides}
                onOpen={setSelectedTaskId}
                onToggleSubtask={(sub) => void handleToggleSubtask(sub)}
                onToggleTask={(t) => void handleToggleTask(t)}
                onSetColor={setOverride}
                onEmptyContextMenu={openEmptyMenu}
                onCardContextMenu={openCardMenu}
              />
            ))}

            <BoardGroup
              title="Unsorted"
              color={null}
              droppableId={UNSORTED_ID}
              tasks={unsorted}
              cardLayout={cardLayout}
              scrollDirection={scrollDirection}
              childrenByParent={childrenByParent}
              overrides={overrides}
              onOpen={setSelectedTaskId}
              onToggleSubtask={(sub) => void handleToggleSubtask(sub)}
              onToggleTask={(t) => void handleToggleTask(t)}
              onSetColor={setOverride}
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
            <div className="pointer-events-auto max-w-sm rounded-2xl border border-white/10 bg-[#101016]/90 p-6 text-center backdrop-blur-sm">
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
        <KanbanAddCard
          key={scopedCreate?.id ?? "none"}
          autoExpand
          status="backlog"
          boardSectionId={scopedCreate?.id && scopedCreate.id !== UNSORTED_ID ? scopedCreate.id : null}
          onAdd={() => {
            setScopedCreate(null);
            void fetchTasks();
          }}
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
