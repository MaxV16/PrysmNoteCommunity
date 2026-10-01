"use client";

import { REMINDER_CAP, type InAppReminder } from "@/hooks/useInAppReminders";

interface ReminderStackProps {
  reminders: InAppReminder[];
  /** Total pending reminders (>= reminders.length); drives the "+N more" line. */
  total?: number;
  /** Lift the stack above the mobile task action bar when it is open. */
  raised?: boolean;
  /**
   * The task detail drawer is open. Its panel covers the bottom-right corner
   * (and the whole screen on phones), so the cards move to the bottom-left on
   * desktop and hide on phones instead of covering the drawer's footer actions.
   */
  drawerOpen?: boolean;
  /** Briefly ring the stack when it is surfaced from the header's More menu. */
  highlight?: boolean;
  onDone: (taskId: string) => void;
  onSnooze: (taskId: string) => void;
  onOpen: (taskId: string) => void;
  onDismiss: (taskId: string) => void;
}

function formatDue(dateStr: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(`${dateStr}T00:00:00`);
  const diff = Math.round((due.getTime() - today.getTime()) / 86_400_000);
  if (diff < 0) return diff === -1 ? "Overdue since yesterday" : `Overdue by ${Math.abs(diff)} days`;
  if (diff === 0) return "Due today";
  if (diff === 1) return "Due tomorrow";
  return `Due in ${diff} days`;
}

/**
 * Persistent bottom-right reminder cards. Unlike toasts these stay until the
 * user acts, so a reminder is never missed just because it flashed for 4s. The
 * stack is capped at REMINDER_CAP cards (oldest first) with a compact overflow
 * line, and lifts above the mobile action bar while it is open.
 */
export function ReminderStack({
  reminders,
  total,
  raised = false,
  drawerOpen = false,
  highlight = false,
  onDone,
  onSnooze,
  onOpen,
  onDismiss,
}: ReminderStackProps) {
  if (reminders.length === 0) return null;

  const visible = reminders.slice(0, REMINDER_CAP);
  const overflow = Math.max(0, (total ?? reminders.length) - visible.length);

  return (
    <div
      data-testid="reminder-stack"
      className={`pointer-events-none fixed z-[9998] w-[min(20rem,calc(100vw-2rem))] flex-col gap-2 transition-shadow ${
          drawerOpen ? "bottom-4 left-4 hidden sm:flex" : `right-4 flex ${raised ? "bottom-24" : "bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] sm:bottom-4"}`
      } ${highlight ? "rounded-2xl ring-2 ring-accent" : ""}`}
    >
      {visible.map((reminder) => (
        <div
          key={reminder.taskId}
          className="pointer-events-auto rounded-xl border border-border bg-surface p-3 shadow-lg slide-up"
        >
          <div className="flex items-start gap-2">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.7 21a2 2 0 0 1-3.4 0" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-primary" title={reminder.title}>
                {reminder.title}
              </p>
              <p className="text-[11px] text-secondary">{formatDue(reminder.dueDate)}</p>
            </div>
            <button
              onClick={() => onDismiss(reminder.taskId)}
              className="shrink-0 rounded-md p-1 text-muted transition-colors hover:bg-hover hover:text-primary"
              title="Dismiss"
              aria-label="Dismiss reminder"
            >
              ✖
            </button>
          </div>
          <div className="mt-2.5 flex items-center gap-1.5">
            <button
              onClick={() => onDone(reminder.taskId)}
              className="btn btn-primary px-2.5 py-1 text-[11px]"
            >
              Done
            </button>
            <button
              onClick={() => onSnooze(reminder.taskId)}
              className="btn bg-elevated border border-border px-2.5 py-1 text-[11px] text-secondary hover:text-primary"
            >
              Snooze 1h
            </button>
            <button
              onClick={() => onOpen(reminder.taskId)}
              className="btn bg-elevated border border-border px-2.5 py-1 text-[11px] text-secondary hover:text-primary"
            >
              Open
            </button>
          </div>
        </div>
      ))}
      {overflow > 0 && (
        <div className="pointer-events-auto rounded-xl border border-border bg-surface px-3 py-2 text-center text-[11px] font-medium text-secondary shadow-lg">
          +{overflow} more reminder{overflow === 1 ? "" : "s"}
        </div>
      )}
    </div>
  );
}
