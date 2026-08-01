"use client";

import { useEffect } from "react";
import { useAppStore } from "@/stores/app-store";

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
 * they can toggle sidebar / AI panel, focus search, create a task, etc.
 */
export function useGlobalShortcuts({
  onToggleSidebar,
  onToggleAiPanel,
  onToggleTheme,
  onNewTask,
}: ShortcutHandlers) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inEditable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable;

      // Intercept Ctrl/Cmd+F for in-app search (override browser find unless typing).
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        if (!inEditable) {
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
        // Deselect the focused task / close the detail panel.
        const store = useAppStore.getState();
        if (store.selectedTaskId) store.setSelectedTaskId(null);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onToggleSidebar, onToggleAiPanel, onToggleTheme, onNewTask]);
}
