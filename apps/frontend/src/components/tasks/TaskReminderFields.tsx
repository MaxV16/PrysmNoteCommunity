"use client";

import { useEffect, useState } from "react";
import { nativeNotificationsSupported } from "@/lib/capbridge";
import { getDefaultReminderTime } from "@/lib/notifications";
import { toLocalDateString } from "@/lib/utils";

export type ReminderChannel = "inapp" | "push" | "email";

export interface TaskReminderDraft {
  enabled: boolean;
  /** ISO 8601 timestamp, or null when no time is scheduled yet. */
  at: string | null;
  inapp: boolean;
  push: boolean;
  email: boolean;
}

interface TaskLike {
  reminder_enabled?: boolean;
  reminder_at?: string | null;
  reminder_inapp?: boolean;
  reminder_push?: boolean;
  reminder_email?: boolean;
}

/** Build the editable draft from a task, preserving every existing channel. */
export function taskReminderDraft(task?: TaskLike | null): TaskReminderDraft {
  return {
    enabled: Boolean(task?.reminder_enabled || task?.reminder_at),
    at: task?.reminder_at ?? null,
    inapp: task?.reminder_inapp ?? true,
    push: task?.reminder_push ?? false,
    email: task?.reminder_email ?? false,
  };
}

function localParts(at: string | null, suggestedDate: string | null) {
  if (at) {
    const date = new Date(at);
    if (!Number.isNaN(date.getTime())) {
      return {
        date: toLocalDateString(date),
        time: `${String(date.getHours()).padStart(2, "0")}:${String(
          date.getMinutes()
        ).padStart(2, "0")}`,
      };
    }
  }
  return {
    date: suggestedDate || toLocalDateString(new Date()),
    time: getDefaultReminderTime(),
  };
}

function combine(date: string, time: string): string | null {
  if (!date || !time) return null;
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  if ([year, month, day, hour, minute].some((value) => Number.isNaN(value))) {
    return null;
  }
  const local = new Date(year, month - 1, day, hour, minute, 0, 0);
  return local.toISOString();
}

/** Suggested instant for a reminder that is being switched on for the first time. */
export function defaultReminderAt(suggestedDate?: string | null): string | null {
  const parts = localParts(null, suggestedDate ?? null);
  return combine(parts.date, parts.time);
}

/** Human summary used by the task drawer (local date + time). */
export function describeReminder(at: string | null): string {
  if (!at) return "No time set";
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "No time set";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const CHANNELS: { key: ReminderChannel; label: string }[] = [
  { key: "inapp", label: "In-app" },
  { key: "push", label: "Browser" },
  { key: "email", label: "Email" },
];

/**
 * "Browser" becomes "Device" inside the Android/iOS shell, where the push
 * channel schedules an OS-local notification instead of a Web Notification.
 * Resolved after mount so server-rendered markup and the native WebView agree.
 */
function useNativeNotifications(): boolean {
  const [native, setNative] = useState(false);
  useEffect(() => {
    setNative(nativeNotificationsSupported());
  }, []);
  return native;
}

interface TaskReminderFieldsProps {
  value: TaskReminderDraft;
  onChange: (next: TaskReminderDraft) => void;
  /** Date used when the reminder is switched on without an existing time. */
  suggestedDate?: string | null;
  /** Permission / preference side effects when a channel is selected. */
  onChannelChange?: (channel: ReminderChannel, enabled: boolean) => void;
  /** Prefix for stable test ids in the two host forms. */
  idPrefix?: string;
}

/**
 * The shared "Remind me" control used by the task drawer and the task form.
 * It only edits the draft; the host decides when to persist it.
 */
export function TaskReminderFields({
  value,
  onChange,
  suggestedDate = null,
  onChannelChange,
  idPrefix = "task",
}: TaskReminderFieldsProps) {
  const parts = localParts(value.at, suggestedDate);
  const native = useNativeNotifications();
  const channels = CHANNELS.map((channel) =>
    channel.key === "push" && native ? { ...channel, label: "Device" } : channel
  );
  const dateId = `${idPrefix}-reminder-date`;
  const timeId = `${idPrefix}-reminder-time`;

  const setEnabled = (enabled: boolean) => {
    if (enabled && !value.at) {
      onChange({ ...value, enabled, at: combine(parts.date, parts.time) });
      return;
    }
    onChange({ ...value, enabled });
  };

  const setPart = (date: string, time: string) => {
    onChange({ ...value, at: combine(date, time) });
  };

  const toggleChannel = (channel: ReminderChannel, enabled: boolean) => {
    const next: TaskReminderDraft = {
      ...value,
      inapp: channel === "inapp" ? enabled : value.inapp,
      push: channel === "push" ? enabled : value.push,
      email: channel === "email" ? enabled : value.email,
    };
    onChannelChange?.(channel, enabled);
    onChange(next);
  };

  return (
    <div className="rounded-xl border border-border bg-elevated">
      <label className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.7 21a2 2 0 0 1-3.4 0" />
            </svg>
          </span>
          <span className="min-w-0">
            <span className="block text-sm text-secondary">Remind me</span>
            <span className="block text-[11px] text-muted">
              {value.enabled
                ? describeReminder(value.at)
                : "Off by default; only tasks you mark are reminded."}
            </span>
          </span>
        </span>
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          className="h-4 w-4 shrink-0"
          style={{ accentColor: "var(--accent)" }}
          data-testid={`${idPrefix}-reminder-toggle`}
        />
      </label>

      {value.enabled && (
        <div className="border-t border-border/60 px-3 py-2.5">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex-1">
              <label htmlFor={dateId} className="mb-1 block text-[11px] text-muted">
                Date
              </label>
              <input
                id={dateId}
                type="date"
                value={parts.date}
                onChange={(event) => setPart(event.target.value, parts.time)}
                className="input-field h-9 text-xs"
                data-testid={`${idPrefix}-reminder-date`}
              />
            </div>
            <div className="flex-1">
              <label htmlFor={timeId} className="mb-1 block text-[11px] text-muted">
                Time
              </label>
              <input
                id={timeId}
                type="time"
                value={parts.time}
                onChange={(event) => setPart(parts.date, event.target.value)}
                className="input-field h-9 text-xs"
                data-testid={`${idPrefix}-reminder-time`}
              />
            </div>
          </div>

          <div className="mt-2">
            <span className="mb-1 block text-[11px] text-muted">How</span>
            <div className="inline-flex flex-wrap items-center gap-1 rounded-full bg-surface p-0.5">
              {channels.map((channel) => {
                const active = value[channel.key];
                return (
                  <button
                    key={channel.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleChannel(channel.key, !active)}
                    className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
                      active
                        ? "bg-accent font-semibold text-[var(--on-gradient)]"
                        : "text-secondary hover:text-primary"
                    }`}
                    data-testid={`${idPrefix}-reminder-channel-${channel.key}`}
                  >
                    {channel.label}
                  </button>
                );
              })}
            </div>
            {value.email && (
              <p className="mt-1.5 text-[11px] text-muted">
                Email reminders are sent to your account address.
              </p>
            )}
            {value.push && (
              <p className="mt-1.5 text-[11px] text-muted">
                {native
                  ? "Device reminders ask for system permission once and still fire when the app is closed."
                  : "Browser notifications need permission from this device."}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
