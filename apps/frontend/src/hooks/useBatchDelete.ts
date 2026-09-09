"use client";

import { useCallback, useState } from "react";
import { useTasks } from "@/hooks/useTasks";
import { useToast } from "@/lib/toast-context";

/**
 * Shared soft-delete-with-undo flow used by every multi-select surface (the
 * timeline floating bar, ListView toolbar, the mobile select bar, and the
 * Delete/Backspace global shortcut). Moves tasks to Trash via the batch
 * endpoint, toasts the server-reported count, and offers Undo which restores
 * them with a success toast.
 *
 * Returns true when at least one task was deleted (callers then clear the
 * selection); false when nothing was deleted or the request failed (callers
 * keep the selection so the user can retry).
 */
export function useBatchDelete() {
  const { deleteTasksBatch, restoreTasksBatch } = useTasks();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  const softDeleteWithUndo = useCallback(
    async (ids: string[]): Promise<boolean> => {
      if (ids.length === 0) return false;
      setBusy(true);
      try {
        const { deleted } = await deleteTasksBatch(ids);
        if (deleted === 0) {
          showToast("Nothing moved to Trash", "info");
          return false;
        }
        const label = deleted === 1 ? "Task moved to Trash" : `${deleted} tasks moved to Trash`;
        showToast(label, "info", {
          label: "Undo",
          onClick: () => {
            void restoreTasksBatch(ids)
              .then(({ restored }) => {
                const restoredLabel =
                  restored === 1 ? "Task restored" : restored === 0 ? "Nothing was restored" : `${restored} tasks restored`;
                showToast(restoredLabel, "success");
              })
              .catch(() => {
                showToast("Could not restore tasks", "error");
              });
          },
        });
        return true;
      } catch {
        return false;
      } finally {
        setBusy(false);
      }
    },
    [deleteTasksBatch, restoreTasksBatch, showToast]
  );

  return { busy, softDeleteWithUndo };
}