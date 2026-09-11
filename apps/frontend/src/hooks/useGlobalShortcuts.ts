"use client";

import { useCallback, useEffect } from "react";
import { useAppStore } from "@/stores/app-store";
import { useBatchDelete } from "@/hooks/useBatchDelete";

interface ShortcutHandlers {
  onToggleSidebar?: () => void;
  onToggleAiPanel?: () => void;
  onToggleTheme?: () => void;
  onNewTask?: () => void;
}

function isModifier(e: KeyboardEvent): boolean {
  return e.ctrlKey || e.metaKey;
}

/**
 * Global keyboard shortcuts for the app. Wired inside the three-pane layout so
 * they can toggle sidebar / AI panel, focus search, create a task, etc. Delete
 * / Backspace with a multi-selection soft-deletes the selected tasks (moves
 * them to Trash) and offers an Undo via the toast.
 */
export function useGlobalShortcuts({
  onToggleSidebar,
  onToggleAiPanel,
  onToggleTheme,
  onNewTask,
}: ShortcutHandlers) {
  const { softDeleteWithUndo } = useBatchDelete();

  const deleteSelectedWithUndo = useCallback(() => {
    const store = useAppStore.getState();
    const ids = store.selectedTaskIds;
    if (ids.length === 0) return;

    void (async () => {
      const ok = await softDeleteWithUndo(ids);
      if (ok) {
        useAppStore.getState().clearTaskSelection();
      }
    })();
  }, [softDeleteWithUndo]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inEditable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable;

      // Intercept Ctrl/Cmd+F for in-app search (override browser find unless
      // typing). Only when this view actually has the global search input -
      // otherwise let the native browser find open (quadrant, finance, ...).
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        if (!inEditable && document.getElementById("global-search")) {
          e.preventDefault();
          // Switch to the current view's search input / focus the global search.
          requestAnimationFrame(() => {
            const el = document.getElementById("global-search") as HTMLInputElement | null;
            el?.focus();
            el?.select();
          });
        }
        return;
      }

      // In editable fields only allow Ctrl/Cmd+S (save); ignore the rest to avoid
      // hijacking normal typing shortcuts.
      if (inEditable) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
        }
        return;
      }

      // Delete / Backspace with an active multi-selection soft-deletes it (with
      // Undo). Never fires when typing or when nothing is selected.
      if ((e.key === "Delete" || e.key === "Backspace") && !isModifier(e)) {
        const selected = useAppStore.getState().selectedTaskIds;
        if (selected.length > 0) {
          e.preventDefault();
          deleteSelectedWithUndo();
          return;
        }
      }

      if (isModifier(e)) {
        const key = e.key.toLowerCase();

        if (key === "n") {
          e.preventDefault();
          onNewTask?.();
        } else if (key === "b") {
          e.preventDefault();
          onToggleSidebar?.();
        } else if (key === "j" && e.shiftKey) {
          e.preventDefault();
          onToggleAiPanel?.();
        } else if (key === "e") {
          e.preventDefault();
          requestAnimationFrame(() => {
            document.getElementById("ai-input")?.focus();
          });
        } else if (key === "s") {
          e.preventDefault();
        } else if (key === "t" && e.shiftKey) {
          e.preventDefault();
          onToggleTheme?.();
        }
      } else if (e.key === "Escape") {
        // Deselect the focused task / close the detail panel / clear multi-selection.
        const store = useAppStore.getState();
        if (store.selectedTaskIds.length > 0) store.clearTaskSelection();
        if (store.selectedTaskId) store.setSelectedTaskId(null);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onToggleSidebar, onToggleAiPanel, onToggleTheme, onNewTask, deleteSelectedWithUndo]);
}