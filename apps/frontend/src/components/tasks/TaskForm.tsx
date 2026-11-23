"use client";

import { useState, useRef, useEffect } from "react";
import { useAppStore } from "@/stores/app-store";
import type { Task, TaskStatus } from "@/types/task";
import { toLocalDateString } from "@/lib/utils";
import { normalizePriority, type PriorityTier } from "@/lib/priority";
import { applyEnd, parseEnd, type RecurrenceEnd } from "@/lib/recurrence";
import { TASK_TITLE_MAX, TASK_DESCRIPTION_MAX } from "@/lib/char-limits";
import { CharLimitHint } from "@/components/ui/CharLimitHint";
import { ChipSelect } from "@/components/ui/ChipSelect";
import { MarkdownEditor } from "@/components/ui/MarkdownEditor";
import {
  TaskReminderFields,
  defaultReminderAt,
  taskReminderDraft,
  type ReminderChannel,
  type TaskReminderDraft,
} from "./TaskReminderFields";
import { PriorityPicker } from "./PriorityPicker";
import {
  requestNotificationPermission,
  useNotificationPrefs,
} from "@/lib/notifications";
import {
  nativeNotificationsSupported,
  requestNativeNotificationPermission,
} from "@/lib/capbridge";

interface TaskFormProps {
  onSubmit: (data: {
    title: string;
    description?: string;
    start_date?: string;
    due_date?: string;
    start_time?: string;
    end_time?: string;
    status?: string;
    priority?: number;
    tag_ids?: string[];
    list_id?: string;
    recurrence_rule?: string;
    recurrence_end_date?: string;
    estimated_minutes?: number;
    reminder_enabled?: boolean;
    reminder_at?: string | null;
    reminder_inapp?: boolean;
    reminder_push?: boolean;
    reminder_email?: boolean;
    board_section_id?: string | null;
  }) => void;
  onCancel: () => void;
  initial?: Task | null;
  defaultDate?: string;
  /** Status pre-selected for a new task (e.g. a board column's status). */
  defaultStatus?: TaskStatus;
  /** Board section a new task is filed into (free board columns). */
  boardSectionId?: string | null;
}

const STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "To Do" },
  { value: "in_progress", label: "In Progress" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const RECURRENCE_PRESETS: { label: string; value: string; rrule?: string }[] = [
  { label: "None", value: "none" },
  { label: "Daily", value: "daily", rrule: "FREQ=DAILY" },
  { label: "Every weekday", value: "weekdays", rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
  { label: "Every weekend", value: "weekends", rrule: "FREQ=WEEKLY;BYDAY=SA,SU" },
  { label: "Weekly", value: "weekly", rrule: "FREQ=WEEKLY" },
  { label: "Biweekly", value: "biweekly", rrule: "FREQ=WEEKLY;INTERVAL=2" },
  { label: "Monthly", value: "monthly", rrule: "FREQ=MONTHLY" },
  { label: "Yearly", value: "yearly", rrule: "FREQ=YEARLY" },
  { label: "Custom", value: "custom" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_HEADERS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function formatDateInput(dateStr: string): string {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-");
  if (!y || !m || !d) return dateStr;
  return `${MONTHS[parseInt(m) - 1]} ${parseInt(d)}, ${y}`;
}

function CalendarPicker({
  value,
  onChange,
  placeholder,
  bare = false,
}: {
  value: string;
  onChange: (d: string) => void;
  placeholder: string;
  /** Renders as plain text for use inside a chip instead of a bordered field. */
  bare?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(() => {
    if (value) {
      const [y, m] = value.split("-");
      return new Date(parseInt(y), parseInt(m) - 1, 1);
    }
    return new Date();
  });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startOffset = (firstDay.getDay() + 6) % 7;

  const prevMonth = () => setViewDate(new Date(year, month - 1, 1));
  const nextMonth = () => setViewDate(new Date(year, month + 1, 1));

  const selectDate = (d: number) => {
    const m = String(month + 1).padStart(2, "0");
    const dd = String(d).padStart(2, "0");
    onChange(`${year}-${m}-${dd}`);
    setOpen(false);
  };

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  return (
    <div className="relative flex-1" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={
          bare
            ? "flex h-8 items-center text-left text-xs text-primary"
            : "input-field text-left text-xs h-10 flex items-center"
        }
      >
        {value ? formatDateInput(value) : <span className="text-muted">{placeholder}</span>}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 rounded-xl border border-border bg-surface p-3 shadow-lg w-56">
          <div className="flex items-center justify-between mb-2">
            <button type="button" onClick={prevMonth} className="text-xs text-muted hover:text-primary p-0.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6"/>
              </svg>
            </button>
            <span className="text-xs font-semibold text-primary">{MONTHS[month]} {year}</span>
            <button type="button" onClick={nextMonth} className="text-xs text-muted hover:text-primary p-0.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          </div>
          <div className="grid grid-cols-7 gap-0.5 text-center">
            {DAY_HEADERS.map((h) => (
              <span key={h} className="text-[10px] text-muted font-medium py-0.5">{h}</span>
            ))}
            {Array.from({ length: startOffset }).map((_, i) => (
              <div key={`empty-${i}`} />
            ))}
            {Array.from({ length: lastDay.getDate() }, (_, i) => i + 1).map((d) => {
              const ds = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
              const isSelected = ds === value;
              const isToday = ds === todayStr;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => selectDate(d)}
                  className={`text-xs py-1 rounded-md transition-colors ${
                    isSelected
                      ? "gradient-bg text-[var(--on-gradient)] font-semibold"
                      : isToday
                      ? "bg-accent/15 text-accent font-medium"
                      : "text-secondary hover:bg-hover hover:text-primary"
                  }`}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function TaskForm({ onSubmit, onCancel, initial, defaultDate, defaultStatus, boardSectionId }: TaskFormProps) {
  const tags = useAppStore((s) => s.tags);
  const lists = useAppStore((s) => s.lists);
  const activeListId = useAppStore((s) => s.activeListId);
  const [title, setTitle] = useState(initial?.title || "");
  const [description, setDescription] = useState(initial?.description || "");
  const descriptionRef = useRef<HTMLTextAreaElement | null>(null);
  const [descriptionUploading, setDescriptionUploading] = useState(false);
  const [startDate, setStartDate] = useState(initial?.start_date || defaultDate || "");
  const [dueDate, setDueDate] = useState(initial?.due_date || defaultDate || "");
  const [startTime, setStartTime] = useState(initial?.start_time || "");
  const [endTime, setEndTime] = useState(initial?.end_time || "");
  const [status, setStatus] = useState<TaskStatus>(initial?.status || defaultStatus || "todo");
  const [priority, setPriority] = useState<PriorityTier>(initial?.priority ? normalizePriority(initial.priority) : 2);
  const [selectedTags, setSelectedTags] = useState<string[]>(() => initial?.tags?.map((t) => t.id) ?? []);
  const [listId, setListId] = useState<string>(initial?.list_id || activeListId || "");
  const [estimatedMinutes, setEstimatedMinutes] = useState(
    initial?.estimated_minutes?.toString() || (initial ? "" : "30")
  );
  const [reminder, setReminder] = useState<TaskReminderDraft>(() =>
    taskReminderDraft(initial)
  );
  const { prefs: notifPrefs, update: updateNotifPrefs } = useNotificationPrefs();
  const [showAdvanced, setShowAdvanced] = useState(() => !!initial);

  const handleChannelChange = (channel: ReminderChannel, enabled: boolean) => {
    if (!enabled) return;
    if (channel === "push") {
      const request = nativeNotificationsSupported()
        ? requestNativeNotificationPermission()
        : requestNotificationPermission();
      void request.then((granted) => {
        if (granted && !notifPrefs.push_enabled) {
          void updateNotifPrefs({ push_enabled: true });
        }
      });
    }
    if (channel === "email" && !notifPrefs.email_reminders) {
      void updateNotifPrefs({ email_reminders: true });
    }
  };

  const initRecurrence = initial?.recurrence_rule || "";
  const [recurrencePreset, setRecurrencePreset] = useState(() => {
    if (!initRecurrence) return "none";
    const preset = RECURRENCE_PRESETS.find((p) => p.rrule === initRecurrence);
    return preset ? preset.value : "custom";
  });
  const [recurrenceRule, setRecurrenceRule] = useState(initRecurrence);
  const [recurrenceEnd, setRecurrenceEnd] = useState<RecurrenceEnd>(() =>
    parseEnd(initial?.recurrence_rule, initial?.recurrence_end_date)
  );

  const isEdit = !!initial;

  const handlePresetChange = (preset: string) => {
    setRecurrencePreset(preset);
    const found = RECURRENCE_PRESETS.find((p) => p.value === preset);
    if (found && found.rrule) {
      setRecurrenceRule(found.rrule);
    } else if (preset === "none") {
      setRecurrenceRule("");
      setRecurrenceEnd({ kind: "never" });
    }
  };

  // Client-side scheduling sanity checks (the server 422 remains the backstop).
  // Same-day end time must follow the start time; the due date cannot precede
  // the start date. Both are ISO strings, so plain string comparison works.
  // New tasks without explicit dates land on today (the same treatment
  // handleSubmit applies), so inverted times still warn before submit.
  const today = toLocalDateString();
  const effStartDate = startDate || (isEdit ? "" : today);
  const effDueDate = dueDate || (isEdit ? "" : today);
  const dateError =
    effStartDate && effDueDate && effDueDate < effStartDate
      ? "Due date cannot be before the start date"
      : null;
  // Mirrors the backend rule: inverted times only matter on a single-day span
  // (no dates, one date, or equal dates).
  const sameDay = effStartDate && effDueDate ? effStartDate === effDueDate : true;
  const timeError =
    startTime && endTime && startTime >= endTime && sameDay
      ? "End time must be after the start time"
      : null;
  const titleError =
    title.length > TASK_TITLE_MAX
      ? `Title is ${title.length - TASK_TITLE_MAX} characters over the limit`
      : null;
  const descriptionError =
    description.length > TASK_DESCRIPTION_MAX
      ? `Description is ${description.length - TASK_DESCRIPTION_MAX} characters over the limit`
      : null;
  const validationError = dateError ?? timeError ?? titleError ?? descriptionError;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    // An image upload that is still resolving must land before the form saves.
    if (descriptionUploading) return;
    if (validationError) return;
    // Ensure undated tasks land on the user's local date so they appear on the
    // timeline. Using the local date (not UTC) keeps the day aligned across
    // timezones.
    const start = startDate || (isEdit ? "" : today);
    const due = dueDate || (isEdit ? "" : today);
    // Single encoding point for the end condition: date ends go to the
    // recurrence_end_date column, count ends become ;COUNT=N in the RRULE.
    const recurrenceEnabled = recurrencePreset !== "none" && !!recurrenceRule.trim();
    const endApplied = recurrenceEnabled
      ? applyEnd(recurrenceRule, recurrenceEnd)
      : { recurrence_rule: "", recurrence_end_date: null };
    onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,
      start_date: start || undefined,
      due_date: due || undefined,
      start_time: startTime.trim() || undefined,
      end_time: endTime.trim() || undefined,
      // Creates preserve the backend default unless the form was opened with an
      // explicit status (a board column); edits always send the picked status.
      status: isEdit || defaultStatus !== undefined ? status : undefined,
      // Priority is always sent (create and edit): the picked tier must
      // survive a create instead of falling through to the backend default.
      priority,
      tag_ids: selectedTags.length > 0 ? selectedTags : undefined,
      list_id: listId || undefined,
      recurrence_rule: endApplied.recurrence_rule || undefined,
      recurrence_end_date: endApplied.recurrence_end_date || undefined,
      estimated_minutes: estimatedMinutes ? Number(estimatedMinutes) : undefined,
      reminder_enabled: reminder.enabled,
      reminder_at: reminder.enabled
        ? reminder.at || defaultReminderAt(due || start || today)
        : null,
      reminder_inapp: reminder.inapp,
      reminder_push: reminder.push,
      reminder_email: reminder.email,
      board_section_id: isEdit ? undefined : boardSectionId ?? undefined,
    });
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex min-h-full flex-col gap-4"
      data-testid="task-form"
    >
      {/* The title is the page: no label, no field chrome. */}
      <input
        type="text"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="What needs to be done?"
        className="w-full border-0 bg-transparent px-0 text-[22px] font-semibold leading-tight text-primary outline-none placeholder:font-normal placeholder:text-secondary sm:text-[26px]"
        autoFocus
      />
      <CharLimitHint value={title} max={TASK_TITLE_MAX} className="-mt-3" />

      {/* The description sits on the panel like notes under a heading, separated
          by a hairline rather than a second frame. */}
      <div className="border-t border-border/60 pt-1">
        <MarkdownEditor
          value={description}
          onChange={setDescription}
          textareaRef={descriptionRef}
          onUploadingChange={setDescriptionUploading}
          placeholder="Add details (markdown and images supported)..."
          ariaLabel="Description"
        />
        <CharLimitHint value={description} max={TASK_DESCRIPTION_MAX} />
      </div>

      {/* One rail for when and where the task lives. Each control carries its
          own tiny label, so the form needs no section headings. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip label="Start">
          <CalendarPicker bare value={startDate} onChange={setStartDate} placeholder="Not set" />
        </Chip>
        <Chip label="Due">
          <CalendarPicker bare value={dueDate} onChange={setDueDate} placeholder="Not set" />
        </Chip>
        {/* Times only matter once there is a day to sit on, so they stay out of
            the rail until a date is picked. */}
        <div className={startDate || dueDate ? "contents" : "hidden"}>
          <Chip label="At">
            <input
              type="time"
              value={startTime}
              onChange={(e) => setStartTime(e.target.value)}
              aria-label="Start time"
              className="h-8 w-[4.6rem] border-0 bg-transparent p-0 text-xs text-primary outline-none"
            />
          </Chip>
          <Chip label="By">
            <input
              type="time"
              value={endTime}
              onChange={(e) => setEndTime(e.target.value)}
              aria-label="End time"
              className="h-8 w-[4.6rem] border-0 bg-transparent p-0 text-xs text-primary outline-none"
            />
          </Chip>
          <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-border" />
        </div>
        <ChipSelect
          label="List"
          ariaLabel="List"
          value={listId}
          onChange={setListId}
          options={[
            { value: "", label: "My Tasks" },
            ...lists.map((l) => ({ value: l.id, label: l.name })),
          ]}
        />
        <ChipSelect
          label="Status"
          ariaLabel="Status"
          value={status}
          onChange={(next) => setStatus(next as TaskStatus)}
          options={STATUS_OPTIONS}
        />
        <PriorityPicker value={priority} onChange={setPriority} />
      </div>
      {dateError && <p className="-mt-1 text-xs text-danger">{dateError}</p>}
      {timeError && <p className="-mt-1 text-xs text-danger">{timeError}</p>}

      <div className="border-t border-border/60 pt-3">
        <TaskReminderFields
          value={reminder}
          onChange={setReminder}
          suggestedDate={dueDate || startDate || defaultDate || today}
          onChannelChange={handleChannelChange}
        />
      </div>

      <button
        type="button"
        onClick={() => setShowAdvanced(!showAdvanced)}
        aria-expanded={showAdvanced}
        className="pointer-coarse:min-h-11 flex items-center gap-1.5 self-start text-xs text-secondary hover:text-primary transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className={`transition-transform ${showAdvanced ? "rotate-90" : ""}`}
        >
          <polyline points="9 18 15 12 9 6"/>
        </svg>
        {showAdvanced ? "Less options" : "More options"}
      </button>
      {showAdvanced && (
        <div className="flex flex-col gap-3">
          <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">
            <div className="min-w-0">
              <label className="text-xs font-medium text-secondary mb-1.5 block">Recurrence</label>
              <select
                value={recurrencePreset}
                onChange={(e) => handlePresetChange(e.target.value)}
                className="input-field text-xs h-10"
              >
                {RECURRENCE_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <label className="text-xs font-medium text-secondary mb-1.5 block">Duration (mins)</label>
              <input
                type="number"
                value={estimatedMinutes}
                onChange={(e) => setEstimatedMinutes(e.target.value)}
                placeholder="30"
                className="input-field text-xs h-10"
                min={1}
              />
            </div>
            {recurrencePreset === "custom" && (
              <div className="col-span-2 min-w-0 sm:col-span-1">
                <label className="text-xs font-medium text-secondary mb-1.5 block">RRULE</label>
                <input
                  type="text"
                  value={recurrenceRule}
                  onChange={(e) => setRecurrenceRule(e.target.value)}
                  placeholder="FREQ=DAILY"
                  className="input-field text-xs h-10"
                />
              </div>
            )}
          </div>
          {recurrencePreset !== "none" && (
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <div className="min-w-0">
                <label className="text-xs font-medium text-secondary mb-1.5 block">Ends</label>
                <select
                  value={recurrenceEnd.kind}
                  onChange={(e) => {
                    const kind = e.target.value as RecurrenceEnd["kind"];
                    if (kind === "never") setRecurrenceEnd({ kind: "never" });
                    else if (kind === "date")
                      setRecurrenceEnd({ kind: "date", date: startDate || toLocalDateString() });
                    else setRecurrenceEnd({ kind: "count", count: 10 });
                  }}
                  className="input-field text-xs h-10"
                >
                  <option value="never">Never</option>
                  <option value="date">On a date</option>
                  <option value="count">After N occurrences</option>
                </select>
              </div>
              {recurrenceEnd.kind === "date" && (
                <div className="min-w-0">
                  <label className="text-xs font-medium text-secondary mb-1.5 block">End Date</label>
                  <CalendarPicker
                    value={recurrenceEnd.date}
                    onChange={(d) => setRecurrenceEnd({ kind: "date", date: d })}
                    placeholder="Select date"
                  />
                </div>
              )}
              {recurrenceEnd.kind === "count" && (
                <div className="min-w-0">
                  <label className="text-xs font-medium text-secondary mb-1.5 block">Occurrences</label>
                  <input
                    type="number"
                    min={1}
                    value={recurrenceEnd.count}
                    onChange={(e) =>
                      setRecurrenceEnd({ kind: "count", count: Math.max(1, Number(e.target.value) || 1) })
                    }
                    className="input-field text-xs h-10 w-full"
                  />
                </div>
              )}
            </div>
          )}
          {tags.length > 0 && (
            <div>
              <label className="text-xs font-medium text-secondary mb-1.5 block">Tags</label>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => {
                  const isSelected = selectedTags.includes(tag.id);
                  return (
                    <button
                      key={tag.id}
                      type="button"
                      onClick={() =>
                        setSelectedTags((prev) =>
                          prev.includes(tag.id) ? prev.filter((id) => id !== tag.id) : [...prev, tag.id]
                        )
                      }
                      className={`badge text-[10px] transition-all ${
                        isSelected
                          ? "gradient-bg text-[var(--on-gradient)]"
                          : "bg-elevated text-secondary hover:text-primary"
                      }`}
                    >
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Sticky action bar: stays reachable while the single scroll region
          moves, and clears the iOS home indicator. */}
      <div
        data-testid="task-form-actions"
        className="sticky bottom-0 z-10 -mx-4 mt-auto border-t border-border bg-surface px-4 pt-3 sm:-mx-6 sm:px-6"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)" }}
      >
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="btn pointer-coarse:min-h-11 bg-elevated border border-border px-4 py-2.5 text-sm text-secondary hover:bg-hover hover:text-primary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!!validationError || descriptionUploading}
            className="btn btn-primary pointer-coarse:min-h-11 flex-1 px-6 py-2.5 text-sm disabled:opacity-50 sm:flex-none"
          >
            {isEdit ? "Update Task" : "Create Task"}
          </button>
        </div>
      </div>
    </form>
  );
}

/**
 * A control inside the meta rail: a quiet pill that shows what the control is
 * for in a tiny label and lets the control itself carry the value. One rail of
 * these replaces the labelled two-column grids, so the form reads as a page
 * with a line of facts under it instead of a stack of boxes.
 */
function Chip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-8 items-center gap-1.5 rounded-full border border-border/70 pl-2.5 pr-1.5 transition-colors focus-within:border-accent focus-within:bg-hover/30 hover:bg-hover/30 pointer-coarse:h-10 pointer-coarse:pl-3">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted">
        {label}
      </span>
      {children}
    </div>
  );
}

