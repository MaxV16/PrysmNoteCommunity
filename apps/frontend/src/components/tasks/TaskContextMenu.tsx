"use client";

import { api } from "@/lib/api";
import type { Task } from "@/types/task";
import { useTasks } from "@/hooks/useTasks";
import { useToast } from "@/lib/toast-context";
import { useAppStore } from "@/stores/app-store";
import { useStickyBoard } from "@/components/sticky/StickyNoteBoard";
import { useIsMobileOS } from "@/lib/use-is-mobile-os";
import { useUiModule } from "@/lib/ui-module-registry";
import { useLocalBool } from "@/lib/use-local-bool";
import { formatDate } from "@/lib/dates";
import { ContextMenuItem, ContextMenuDivider } from "@/components/ui/ContextMenu";
import { buildDuplicatePayload } from "./task-duplicate";



export type ContextMenuState =
  | { kind: "task"; task: Task }
  | { kind: "empty"; day?: string; section?: { id: string | null; title: string } };

interface TaskContextMenuProps {
  menu: ContextMenuState | null;
  onClose: () => void;
  onNewTask: (ctx: { day?: string; section?: { id: string | null; title: string } }) => void;
}

export function TaskContextMenu({ menu, onClose, onNewTask }: TaskContextMenuProps) {
  if (!menu) return null;
  if (menu.kind === "empty") {
    return <EmptyMenu day={menu.day} section={menu.section} onNewTask={onNewTask} onClose={onClose} />;
  }
  return <TaskMenu task={menu.task} onClose={onClose} />;
}

function TaskMenu({ task, onClose }: { task: Task; onClose: () => void }) {
  const { updateTask, deleteTask, restoreTask, createTask, fetchTasks } = useTasks();
  const setSelectedTaskId = useAppStore((s) => s.setSelectedTaskId);
  const { addNoteWithContent } = useStickyBoard();
  const isMobileOS = useIsMobileOS();
  const stickyOn = useUiModule("stickyNotes") && !isMobileOS;
  const soundOn = useLocalBool("prysm_notif_sound", true);
  const rewardsOn = useLocalBool("prysm_rewards", true);
  const { showToast } = useToast();

  const handleEdit = () => {
    setSelectedTaskId(task.id);
    onClose();
  };

  // Every action below dismisses the menu FIRST and then runs. Closing only
  // after the request resolved left the menu hanging over the timeline for the
  // whole round trip, which is exactly what made these actions feel slow: the
  // store is optimistic now, so there is nothing left to wait for.
  const handleToggleStatus = () => {
    const next = task.status === "done" ? "todo" : "done";
    onClose();
    void (async () => {
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
      try {
        await updateTask(task.id, { status: next });
      } catch {
        showToast("Could not update the task", "error");
      }
    })();
  };

  const handleDuplicate = () => {
    onClose();
    void createTask(buildDuplicatePayload(task)).catch(() => {
      showToast("Could not duplicate the task", "error");
    });
  };

  const handleSticky = () => {
    addNoteWithContent(task.title, task.description || "");
    onClose();
  };

  const handleBreakDown = () => {
    onClose();
    void (async () => {
      try {
        await api.post(`/tasks/${task.id}/breakdown`, {});
        await fetchTasks();
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("prysm-open-ai"));
          window.dispatchEvent(
            new CustomEvent("prysm-ai-suggest", {
              detail: { taskId: task.id, title: task.title },
            })
          );
        }
      } catch {
        showToast("Could not break down this task", "error");
      }
    })();
  };

  // Deletion is a soft delete (moves the task to Trash) so it is instantly
  // reversible: the toast offers an Undo that restores the task in place.
  const handleDelete = () => {
    if (useAppStore.getState().selectedTaskId === task.id) setSelectedTaskId(null);
    onClose();
    void deleteTask(task.id)
      .then(() => {
        showToast("Task moved to Trash", "info", {
          label: "Undo",
          onClick: () => {
            void restoreTask(task.id).catch(() => {
              showToast("Could not restore task", "error");
            });
          },
        });
      })
      .catch(() => {
        showToast("Could not delete the task", "error");
      });
  };

  return (
    <>
      <ContextMenuItem onClick={handleEdit}>Edit task</ContextMenuItem>
      <ContextMenuItem onClick={handleToggleStatus}>
        {task.status === "done" ? "Mark as to-do" : "Mark complete"}
      </ContextMenuItem>
      <ContextMenuItem onClick={handleDuplicate}>Duplicate</ContextMenuItem>
      {stickyOn && (
        <ContextMenuItem onClick={handleSticky}>Add as sticky note</ContextMenuItem>
      )}
      <ContextMenuItem onClick={handleBreakDown}>
        Break down into subtasks (AI)
      </ContextMenuItem>
      <ContextMenuDivider />
      <ContextMenuItem danger onClick={handleDelete}>
        Delete task
      </ContextMenuItem>
    </>
  );
}

function EmptyMenu({
  day,
  section,
  onNewTask,
  onClose,
}: {
  day?: string;
  section?: { id: string | null; title: string };
  onNewTask: (ctx: { day?: string; section?: { id: string | null; title: string } }) => void;
  onClose: () => void;
}) {
  const { open } = useStickyBoard();
  const label = day
    ? `New task on ${formatDate(day, { includeYear: false })}`
    : section
      ? `New task in ${section.title}`
      : "New task";

  return (
    <>
      <ContextMenuItem
        onClick={() => {
          onNewTask({ day, section });
          onClose();
        }}
      >
        {label}
      </ContextMenuItem>
      <ContextMenuItem
        onClick={() => {
          open();
          onClose();
        }}
      >
        New note
      </ContextMenuItem>
    </>
  );
}
