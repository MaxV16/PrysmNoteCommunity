"use client";

import { useCallback, useMemo, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCorners,
} from "@dnd-kit/core";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import { useTasks } from "@/hooks/useTasks";
import { useBoardSections } from "@/hooks/useBoardSections";
import { usePreferencesStore } from "@/stores/preferences-store";
import {
  PREF_BOARD_KANBAN_LAYOUT,
  PREF_BOARD_KANBAN_SCROLL,
  type CardLayout,
  type ScrollDirection,
} from "@/lib/preferences";
import {
  applyBoardDrop,
  applyBoardGroupDrop,
  byBoardOrder,
  computeBoardDrop,
  sectionTasks,
} from "@/lib/board-dnd";
import type { Task } from "@/types/task";
import type { BoardSection } from "@/lib/board-sections";
import { KanbanColumn } from "./KanbanColumn";
import { KanbanCard } from "./KanbanCard";
import { KanbanToolbar } from "./KanbanToolbar";
import { KanbanAddCard } from "./KanbanAddCard";
import { Modal } from "@/components/ui/Modal";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { TaskContextMenu, type ContextMenuState } from "@/components/tasks/TaskContextMenu";

export function KanbanBoard() {
  const tasks = useAppStore((s) => s.tasks);
  const setTasks = useAppStore((s) => s.setTasks);
  const { fetchTasks } = useTasks();
  const { sections, addSection, renameSection, removeSection } =
    useBoardSections("kanban");

  const scrollDirection = usePreferencesStore(
    (s) => (s.prefs[PREF_BOARD_KANBAN_SCROLL] as ScrollDirection) || "horizontal"
  );
  const cardLayout = usePreferencesStore(
    (s) => (s.prefs[PREF_BOARD_KANBAN_LAYOUT] as CardLayout) || "stacked"
  );
  const setPreference = usePreferencesStore((s) => s.setPreference);

  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [menu, setMenu] = useState<{ state: ContextMenuState; x: number; y: number } | null>(null);
  const [scopedCreate, setScopedCreate] = useState<BoardSection | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const tasksBySection = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const section of sections) {
      map.set(
        section.id,
        sectionTasks(tasks, section)
          .filter((t) => !t.is_archived)
          .sort(byBoardOrder)
      );
    }
    return map;
  }, [tasks, sections]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const task = tasks.find((t) => t.id === event.active.id);
      if (task) setActiveTask(task);
    },
    [tasks]
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveTask(null);

      const { active, over } = event;
      if (!over) return;

      const taskId = active.id as string;
      const task = tasks.find((t) => t.id === taskId);
      if (!task) return;

      const drop = computeBoardDrop(tasks, sections, taskId, over.id as string);
      if (!drop) return;

      const store = useAppStore.getState();
      const selectedIds = store.selectedTaskIds;
      const isGroupDrag = selectedIds.length > 1 && selectedIds.includes(taskId);

      if (isGroupDrag) {
        // Group drag: the dragged card's drop index is the group's splice point.
        // The group keeps current board order so the batch lands predictably.
        const groupOrder = selectedIds
          .map((id) => tasks.find((t) => t.id === id))
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

      // Optimistic store update; the refetch reconciles shortly after.
      setTasks(applyBoardDrop(tasks, taskId, drop, sections));

      try {
        await api.post("/tasks/board-move", {
          task_id: taskId,
          section_id: drop.sectionId,
          index: drop.index,
        });
        await fetchTasks();
      } catch {
        setTasks(tasks);
      }
    },
    [tasks, sections, setTasks, fetchTasks]
  );

  const handleRemoveColumn = useCallback(
    (section: BoardSection) => {
      if (sections.length <= 1) return; // keep at least one section
      void removeSection(section.id);
    },
    [sections.length, removeSection]
  );

  const refetchTasks = useCallback(() => {
    void fetchTasks();
  }, [fetchTasks]);

  const openCardMenu = useCallback((e: React.MouseEvent, task: Task) => {
    setMenu({ state: { kind: "task", task }, x: e.clientX, y: e.clientY });
  }, []);

  const openEmptyMenu = useCallback((e: React.MouseEvent, section: BoardSection) => {
    setMenu({
      state: { kind: "empty", section: { id: section.id, title: section.title } },
      x: e.clientX,
      y: e.clientY,
    });
  }, []);

  // "New task in {section}" reuses the KanbanAddCard quick-create flow inside a
  // modal, pre-scoped to the section's status / board_section_id.
  const handleEmptyNewTask = useCallback(
    (ctx: { day?: string; section?: { id: string | null; title: string } }) => {
      if (ctx.section?.id) {
        const section = sections.find((s) => s.id === ctx.section!.id);
        if (section) {
          setScopedCreate(section);
          return;
        }
      }
      window.dispatchEvent(new CustomEvent("prysm-new-task"));
    },
    [sections]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <KanbanToolbar
        scrollDirection={scrollDirection}
        cardLayout={cardLayout}
        onScrollDirectionChange={(d) => setPreference(PREF_BOARD_KANBAN_SCROLL, d)}
        onCardLayoutChange={(l) => setPreference(PREF_BOARD_KANBAN_LAYOUT, l)}
        onAddSection={(title) => void addSection({ title, color: "#9E9E9E" })}
      />

      <div
        className={`min-h-0 flex-1 ${
          scrollDirection === "horizontal"
            ? "flex flex-row items-start gap-4 overflow-x-auto px-4 py-4"
            : "flex flex-col items-start gap-4 overflow-y-auto px-4 py-4"
        }`}
        style={{ overscrollBehaviorX: "contain", WebkitOverflowScrolling: "touch" }}
        onPointerDown={(e) => {
          const target = e.target as HTMLElement;
          if (target.closest("[data-kanban-card], button, input, select, textarea, a, [data-task-bar]")) return;
          useAppStore.getState().clearTaskSelection();
        }}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          {sections.map((section) => (
            <KanbanColumn
              key={section.id}
              section={section}
              tasks={tasksBySection.get(section.id) ?? []}
              cardLayout={cardLayout}
              onRefetch={refetchTasks}
              onRename={(title) => void renameSection(section.id, title)}
              onRemove={() => handleRemoveColumn(section)}
              onEmptyContextMenu={openEmptyMenu}
              onCardContextMenu={openCardMenu}
            />
          ))}

          <DragOverlay>
            {activeTask ? (
              <div className="opacity-90">
                <KanbanCard task={activeTask} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>

      <Modal
        isOpen={!!scopedCreate}
        onClose={() => setScopedCreate(null)}
        title={scopedCreate ? `New task in ${scopedCreate.title}` : "New Task"}
      >
        <KanbanAddCard
          key={scopedCreate?.id ?? "none"}
          autoExpand
          status={scopedCreate?.status || "backlog"}
          boardSectionId={scopedCreate?.status ? null : scopedCreate?.id}
          onAdd={() => {
            setScopedCreate(null);
            refetchTasks();
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
