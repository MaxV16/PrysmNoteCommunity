"use client";

import { useState, useRef, useEffect } from "react";
import { useAppStore } from "@/stores/app-store";
import type { Task, TaskStatus } from "@/types/task";
import { toLocalDateString } from "@/lib/utils";
import { TIER_LABELS, TIER_VALUES, normalizePriority, type PriorityTier } from "@/lib/priority";
import { applyEnd, parseEnd, type RecurrenceEnd } from "@/lib/recurrence";

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
  }) => void;
  onCancel: () => void;
  initial?: Task | null;
  defaultDate?: string;
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

function CalendarPicker({ value, onChange, placeholder }: { value: string; onChange: (d: string) => void; placeholder: string }) {
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
        className="input-field text-left text-xs h-10 flex items-center"
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
                      ? "gradient-bg text-[var(--on-gradient)] font-semibold shadow-glow"
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

export function TaskForm({ onSubmit, onCancel, initial, defaultDate }: TaskFormProps) {
  const { tags, lists, activeListId } = useAppStore();
  const [title, setTitle] = useState(initial?.title || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [startDate, setStartDate] = useState(initial?.start_date || defaultDate || "");
  const [dueDate, setDueDate] = useState(initial?.due_date || defaultDate || "");
  const [startTime, setStartTime] = useState(initial?.start_time || "");
  const [endTime, setEndTime] = useState(initial?.end_time || "");
  const [status, setStatus] = useState<TaskStatus>(initial?.status || "todo");
  const [priority, setPriority] = useState<PriorityTier>(initial?.priority ? normalizePriority(initial.priority) : 2);
  const [selectedTags, setSelectedTags] = useState<string[]>(() => initial?.tags?.map((t) => t.id) ?? []);
  const [listId, setListId] = useState<string>(initial?.list_id || activeListId || "");
  const [estimatedMinutes, setEstimatedMinutes] = useState(
    initial?.estimated_minutes?.toString() || (initial ? "" : "30")
  );

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
  const validationError = dateError ?? timeError;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
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
      status: isEdit ? status : undefined,
      priority: isEdit ? priority : undefined,
      tag_ids: selectedTags.length > 0 ? selectedTags : undefined,
      list_id: listId || undefined,
      recurrence_rule: endApplied.recurrence_rule || undefined,
      recurrence_end_date: endApplied.recurrence_end_date || undefined,
      estimated_minutes: estimatedMinutes ? Number(estimatedMinutes) : undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 overflow-y-auto max-h-[60dvh] pb-safe" style={{ minHeight: 0 }}>
      <div>
        <label className="text-xs font-medium text-secondary mb-1.5 block">Task Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="What needs to be done?"
          className="input-field text-sm placeholder:text-secondary"
          autoFocus
        />
      </div>
      <div>
        <label className="text-xs font-medium text-secondary mb-1.5 block">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Add details..."
          rows={2}
          className="input-field resize-none text-xs placeholder:text-secondary"
        />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-2">
        <div className="flex-1">
          <label className="text-xs font-medium text-secondary mb-1.5 block">Start Date</label>
          <CalendarPicker value={startDate} onChange={setStartDate} placeholder="Not set" />
        </div>
        <div className="flex-1">
          <label className="text-xs font-medium text-secondary mb-1.5 block">Due Date</label>
          <CalendarPicker value={dueDate} onChange={setDueDate} placeholder="Not set" />
        </div>
      </div>
      {dateError && <p className="-mt-2 text-xs text-danger">{dateError}</p>}
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-2">
        <div className="flex-1">
          <label className="text-xs font-medium text-secondary mb-1.5 block">Start Time</label>
          <input
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="input-field text-xs h-10"
          />
        </div>
        <div className="flex-1">
          <label className="text-xs font-medium text-secondary mb-1.5 block">End Time</label>
          <input
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            className="input-field text-xs h-10"
          />
        </div>
      </div>
      {timeError && <p className="-mt-2 text-xs text-danger">{timeError}</p>}
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-2">
        <div className="flex-1">
          <label className="text-xs font-medium text-secondary mb-1.5 block">List</label>
          <select
            value={listId}
            onChange={(e) => setListId(e.target.value)}
            className="input-field text-xs h-10"
          >
            <option value="">My Tasks</option>
            {lists.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className="text-xs font-medium text-secondary mb-1.5 block">Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as TaskStatus)}
            className="input-field text-xs h-10"
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className="text-xs font-medium text-secondary mb-1.5 block">Priority</label>
          <select
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value) as PriorityTier)}
            className="input-field text-xs h-10"
          >
            {TIER_VALUES.map((p) => (
              <option key={p} value={p}>{TIER_LABELS[p]}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-2">
        <div className="flex-1">
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
        {recurrencePreset === "custom" && (
          <div className="flex-1">
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
        <div className="w-full sm:w-auto">
          <label className="text-xs font-medium text-secondary mb-1.5 block">Duration (mins)</label>
          <input
            type="number"
            value={estimatedMinutes}
            onChange={(e) => setEstimatedMinutes(e.target.value)}
            placeholder="30"
            className="input-field text-xs h-10 w-full sm:w-24"
            min={1}
          />
        </div>
      </div>
      {recurrencePreset !== "none" && (
        <div className="flex flex-col gap-2 sm:flex-row sm:gap-2">
          <div className="flex-1">
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
            <div className="flex-1">
              <label className="text-xs font-medium text-secondary mb-1.5 block">End Date</label>
              <CalendarPicker
                value={recurrenceEnd.date}
                onChange={(d) => setRecurrenceEnd({ kind: "date", date: d })}
                placeholder="Select date"
              />
            </div>
          )}
          {recurrenceEnd.kind === "count" && (
            <div className="flex-1">
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
                    ? "gradient-bg text-[var(--on-gradient)] shadow-glow"
                    : "bg-elevated text-secondary hover:text-primary"
                }`}
              >
                {tag.name}
              </button>
            );
          })}
        </div>
      )}
      <div className="flex justify-end gap-2 mt-2 pt-3 border-t border-border/40">
        <button type="button" onClick={onCancel} className="btn bg-elevated border border-border px-4 py-2 text-sm text-secondary hover:bg-hover hover:text-primary">
          Cancel
        </button>
        <button type="submit" disabled={!!validationError} className="btn btn-primary px-6 py-2 text-sm disabled:opacity-50">
          {isEdit ? "Update Task" : "Create Task"}
        </button>
      </div>
    </form>
  );
}
