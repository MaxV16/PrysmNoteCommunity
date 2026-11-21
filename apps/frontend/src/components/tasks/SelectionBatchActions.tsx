"use client";

import { useState, useCallback, type ReactNode } from "react";
import { useAppStore } from "@/stores/app-store";
import { useTasks } from "@/hooks/useTasks";
import { useBoardSections } from "@/hooks/useBoardSections";
import type { BoardSection } from "@/lib/board-sections";
import { api } from "@/lib/api";
import { Modal } from "@/components/ui/Modal";
import type { TaskStatus } from "@/types/task";

const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
  cancelled: "Cancelled",
};

/**
 * Shared multi-selection group actions ("Move to..." and "Set date") for every
 * view. ListView uses it inline; TimelineView (and its kanban/board/calendar
 * sub-views) uses it through the floating SelectionActionBar. The returned
 * `extra` is a pair of trigger buttons and `modals` is the move/date dialogs,
 * so the caller drops them wherever it renders its selection bar.
 */
export function useSelectionBatchActions(timelineSections: BoardSection[] = []) {
  const selectedTaskIds = useAppStore((s) => s.selectedTaskIds);
  const clearTaskSelection = useAppStore((s) => s.clearTaskSelection);
  const { fetchTasks } = useTasks();
  const { sections: boardSections } = useBoardSections("board");
  const { sections: kanbanSections } = useBoardSections("kanban");
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [showDateModal, setShowDateModal] = useState(false);
  const [moveDate, setMoveDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const runBatch = useCallback(
    async (request: () => Promise<unknown>) => {
      setBusy(true);
      setActionError(null);
      try {
        await request();
        await fetchTasks();
        clearTaskSelection();
        return true;
      } catch {
        setActionError("The batch operation failed. Try again.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [fetchTasks, clearTaskSelection]
  );

  const handleMoveTo = useCallback(
    async (sectionId: string | null) => {
      const ok = await runBatch(() =>
        api.post("/tasks/batch-board-move", {
          task_ids: selectedTaskIds,
          section_id: sectionId,
          index: 0,
        })
      );
      if (ok) setShowMoveModal(false);
    },
    [runBatch, selectedTaskIds]
  );

  const handleSetDate = useCallback(async () => {
    if (!moveDate) return;
    const ok = await runBatch(() =>
      api.post("/tasks/batch-set-date", {
        task_ids: selectedTaskIds,
        date: moveDate,
      })
    );
    if (ok) setShowDateModal(false);
  }, [runBatch, selectedTaskIds, moveDate]);

  const statusSections = kanbanSections.filter((s) => s.status);
  const count = selectedTaskIds.length;

  const extra: ReactNode = (
    <>
      <button
        onClick={() => setShowMoveModal(true)}
        disabled={busy}
        className="btn bg-elevated border border-border px-3 py-1 text-[11px] text-secondary hover:text-primary rounded-md"
      >
        Move to…
      </button>
      <button
        onClick={() => setShowDateModal(true)}
        disabled={busy}
        className="btn bg-elevated border border-border px-3 py-1 text-[11px] text-secondary hover:text-primary rounded-md"
      >
        Set date
      </button>
    </>
  );

  const sectionButton = (section: BoardSection | null, label: string, key: string) => (
    <button
      key={key}
      onClick={() => void handleMoveTo(section?.id ?? null)}
      disabled={busy}
      className="block w-full rounded-lg px-3 py-2 text-left text-xs text-secondary transition-colors hover:bg-hover hover:text-primary disabled:opacity-50"
    >
      {label}
    </button>
  );

  const modals: ReactNode = (
    <>
      <Modal
        isOpen={showMoveModal}
        onClose={() => setShowMoveModal(false)}
        title={`Move ${count} task${count === 1 ? "" : "s"}`}
      >
        <div className="space-y-3">
          {statusSections.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                By Status
              </p>
              <div className="space-y-1">
                {statusSections.map((s) =>
                  sectionButton(s, STATUS_LABELS[s.status as TaskStatus] ?? s.title, s.id)
                )}
              </div>
            </div>
          )}
          {boardSections.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                Board Sections
              </p>
              <div className="space-y-1">
                {boardSections.map((s) => sectionButton(s, s.title, s.id))}
              </div>
            </div>
          )}
          {timelineSections.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">
                Timeline Sections
              </p>
              <div className="space-y-1">
                {timelineSections.map((s) => sectionButton(s, s.title, s.id))}
              </div>
            </div>
          )}
          {sectionButton(null, "Unsorted", "__unsorted")}
          {actionError && <p className="text-xs text-danger">{actionError}</p>}
        </div>
      </Modal>

      <Modal
        isOpen={showDateModal}
        onClose={() => setShowDateModal(false)}
        title={`Set date for ${count} task${count === 1 ? "" : "s"}`}
      >
        <div className="space-y-3">
          <input
            type="date"
            value={moveDate}
            onChange={(e) => setMoveDate(e.target.value)}
            className="input-field"
            aria-label="Date to assign"
          />
          {actionError && <p className="text-xs text-danger">{actionError}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => void handleSetDate()}
              disabled={busy || !moveDate}
              className="btn btn-gradient px-5 py-2 text-sm rounded-xl disabled:opacity-50"
            >
              Apply
            </button>
            <button
              onClick={() => setShowDateModal(false)}
              className="btn bg-elevated border border-border text-secondary px-4 py-2 text-sm rounded-xl"
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </>
  );

  return { extra, modals, busy, actionError };
}
