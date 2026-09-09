"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { Task } from "@/types/task";
import { useTasks } from "@/hooks/useTasks";
import { useToast } from "@/lib/toast-context";
import { useAppStore } from "@/stores/app-store";
import { useStickyBoard } from "@/components/sticky/StickyNoteBoard";
import { useUiModule } from "@/lib/ui-module-registry";
import { useLocalBool } from "@/lib/use-local-bool";
import { formatDate } from "@/lib/dates";
import { openNotesWindow } from "@/lib/notes";
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
  const stickyOn = useUiModule("stickyNotes");
  const soundOn = useLocalBool("prysm_notif_sound", true);
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  const handleEdit = () => {
    setSelectedTaskId(task.id);
    onClose();
  };

  const handleToggleStatus = async () => {
    const next = task.status === "done" ? "todo" : "done";
    if (next === "done" && soundOn) {
      const { playCompletionSound } = await import("@/lib/sounds");
      playCompletionSound();
    }
    await updateTask(task.id, { status: next });
    onClose();
  };

  const handleDuplicate = async () => {
    await createTask(buildDuplicatePayload(task));
    onClose();
  };

  const handleSticky = () => {
    addNoteWithContent(task.title, task.description || "");
    onClose();
  };

  const handleBreakDown = async () => {
    setBusy(true);
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
    } finally {
      setBusy(false);
      onClose();
    }
  };

  // Deletion is a soft delete (moves the task to Trash) so it is instantly
  // reversible: the toast offers an Undo that restores the task in place.
  const handleDelete = async () => {
    if (useAppStore.getState().selectedTaskId === task.id) setSelectedTaskId(null);
    await deleteTask(task.id);
    onClose();
    showToast("Task moved to Trash", "info", {
      label: "Undo",
      onClick: () => {
        void restoreTask(task.id).catch(() => {
          showToast("Could not restore task", "error");
        });
      },
    });
  };

  return (
    <>
      <ContextMenuItem onClick={handleEdit}>Edit task</ContextMenuItem>
      <ContextMenuItem onClick={() => void handleToggleStatus()}>
        {task.status === "done" ? "Mark as to-do" : "Mark complete"}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void handleDuplicate()}>Duplicate</ContextMenuItem>
      {stickyOn && (
        <ContextMenuItem onClick={handleSticky}>Add as sticky note</ContextMenuItem>
      )}
      <ContextMenuItem onClick={() => void handleBreakDown()} disabled={busy}>
        {busy ? "Breaking down…" : "Break down into subtasks (AI)"}
      </ContextMenuItem>
      <ContextMenuDivider />
      <ContextMenuItem danger onClick={() => void handleDelete()}>
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
  const label = day
    ? `New task on ${formatDate(new Date(day + "T00:00:00"), { includeYear: false })}`
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
          openNotesWindow();
          onClose();
        }}
      >
        New note
      </ContextMenuItem>
    </>
  );
}
