"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { useTasks } from "@/hooks/useTasks";
import { useToast } from "@/lib/toast-context";
import { formatDate } from "@/lib/dates";
import type { Task } from "@/types/task";

interface TrashViewProps {
  open: boolean;
  onClose: () => void;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.floor(ms / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

export function TrashView({ open, onClose }: TrashViewProps) {
  const { listTrashed, restoreTasksBatch, permanentDelete, emptyTrash } = useTasks();
  const { showToast } = useToast();
  const [trashed, setTrashed] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [confirmForever, setConfirmForever] = useState<Set<string>>(new Set());
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTrashed(await listTrashed());
    } catch {
      setError("Could not load Trash. Try again.");
    } finally {
      setLoading(false);
    }
  }, [listTrashed]);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  const run = useCallback(
    async (id: string, op: () => Promise<unknown>) => {
      setBusyIds((prev) => new Set(prev).add(id));
      try {
        await op();
        await reload();
        return true;
      } catch {
        showToast("That operation failed. Try again.", "error");
        return false;
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [reload, showToast]
  );

  const handleRestore = (id: string) => {
    void run(id, () => restoreTasksBatch([id])).then((ok) => {
      if (ok) showToast("Task restored", "success");
    });
  };

  const handlePermanentDelete = (id: string) => {
    if (!confirmForever.has(id)) {
      setConfirmForever((prev) => new Set(prev).add(id));
      return;
    }
    setConfirmForever(new Set());
    void run(id, () => permanentDelete(id)).then((ok) => {
      if (ok) showToast("Task deleted forever", "success");
    });
  };

  const handleEmptyTrash = () => {
    if (!confirmEmpty) {
      setConfirmEmpty(true);
      return;
    }
    setConfirmEmpty(false);
    void run("__empty__", emptyTrash).then((ok) => {
      if (ok) showToast("Trash emptied", "success");
    });
  };

  return (
    <Modal isOpen={open} onClose={onClose} title="Trash">
      <div className="space-y-3">
        {error && <p className="text-xs text-danger">{error}</p>}

        {trashed.length > 0 && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-secondary">
              {trashed.length} task{trashed.length === 1 ? "" : "s"} (kept 14 days)
            </span>
            <button
              onClick={handleEmptyTrash}
              disabled={busyIds.has("__empty__")}
              className={`btn px-3 py-1 text-[11px] rounded-lg border border-danger/40 ${
                confirmEmpty ? "bg-danger/20 text-danger" : "text-danger hover:bg-danger/10"
              } disabled:opacity-50`}
            >
              {confirmEmpty ? "Confirm empty" : "Empty Trash"}
            </button>
          </div>
        )}

        {loading ? (
          <p className="py-6 text-center text-sm text-secondary">Loading Trash...</p>
        ) : trashed.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm font-semibold text-primary">All clear</p>
            <p className="mt-1 text-xs text-secondary">Deleted tasks appear here for 14 days, then are removed for good.</p>
          </div>
        ) : (
          <div className="max-h-[50dvh] space-y-1.5 overflow-y-auto pr-1">
            {trashed.map((task) => {
              const deleting = busyIds.has(task.id);
              const confirm = confirmForever.has(task.id);
              const date = task.due_date || task.start_date;
              return (
                <div
                  key={task.id}
                  className={`flex items-center gap-2 rounded-xl border border-border bg-base/60 px-3 py-2 ${
                    confirm ? "border-danger/40" : ""
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-primary">{task.title}</span>
                    <span className="block text-[10px] text-muted">
                      {date ? `Due ${formatDate(date, { includeYear: false })}` : "No date"}
                      {task.deleted_at ? ` · deleted ${timeAgo(task.deleted_at)}` : ""}
                    </span>
                  </span>
                  <button
                    onClick={() => handleRestore(task.id)}
                    disabled={deleting}
                    className="btn shrink-0 rounded-lg border border-border bg-elevated px-2.5 py-1 text-[11px] text-secondary transition-colors hover:text-primary disabled:opacity-50"
                  >
                    Restore
                  </button>
                  <button
                    onClick={() => handlePermanentDelete(task.id)}
                    disabled={deleting}
                    onBlur={() => setConfirmForever((prev) => {
                      const next = new Set(prev);
                      next.delete(task.id);
                      return next;
                    })}
                    className={`btn shrink-0 rounded-lg border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-50 ${
                      confirm
                        ? "border-danger/40 bg-danger/20 text-danger"
                        : "border-border bg-elevated text-danger hover:bg-danger/10"
                    }`}
                  >
                    {confirm ? "Delete forever?" : "Delete forever"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}