"use client";

import { useState, useRef, useEffect } from "react";
import { useAppStore } from "@/stores/app-store";
import type { Task, TaskStatus } from "@/types/task";
import { toLocalDateString } from "@/lib/utils";

interface TaskFormProps {
  onSubmit: (data: {
    title: string;
    description?: string;
    start_date?: string;
    due_date?: string;
    status?: string;
    priority?: number;
    project_id?: string | null;
    tag_ids?: string[];
    recurrence_rule?: string;
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
                      ? "bg-accent text-base font-semibold"
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
  const { projects, tags } = useAppStore();
  const [title, setTitle] = useState(initial?.title || "");
  const [description, setDescription] = useState(initial?.description || "");
  const [startDate, setStartDate] = useState(initial?.start_date || defaultDate || "");
  const [dueDate, setDueDate] = useState(initial?.due_date || defaultDate || "");
  const [status, setStatus] = useState<TaskStatus>(initial?.status || "todo");
  const [priority, setPriority] = useState(initial?.priority || 3);
  const [projectId, setProjectId] = useState(initial?.project_id || "");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
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

  const isEdit = !!initial;

  const handlePresetChange = (preset: string) => {
    setRecurrencePreset(preset);
    const found = RECURRENCE_PRESETS.find((p) => p.value === preset);
    if (found && found.rrule) {
      setRecurrenceRule(found.rrule);
    } else if (preset === "none") {
      setRecurrenceRule("");
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    // Ensure undated tasks land on the user's local date so they appear on the
    // timeline. Using the local date (not UTC) keeps the day aligned across
    // timezones.
    const today = toLocalDateString();
    const start = startDate || (isEdit ? "" : today);
    const due = dueDate || (isEdit ? "" : today);
    onSubmit({
      title: title.trim(),
      description: description.trim() || undefined,
      start_date: start || undefined,
      due_date: due || undefined,
      status: isEdit ? status : undefined,
      priority: isEdit ? priority : undefined,
      project_id: projectId || null,
      tag_ids: selectedTags.length > 0 ? selectedTags : undefined,
      recurrence_rule: recurrenceRule || undefined,
      estimated_minutes: estimatedMinutes ? Number(estimatedMinutes) : undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 overflow-y-auto max-h-[60vh]" style={{ minHeight: 0 }}>
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
      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-xs font-medium text-secondary mb-1.5 block">Start Date</label>
          <CalendarPicker value={startDate} onChange={setStartDate} placeholder="Not set" />
        </div>
        <div className="flex-1">
          <label className="text-xs font-medium text-secondary mb-1.5 block">Due Date</label>
          <CalendarPicker value={dueDate} onChange={setDueDate} placeholder="Not set" />
        </div>
      </div>
      <div className="flex gap-2">
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
            onChange={(e) => setPriority(Number(e.target.value))}
            className="input-field text-xs h-10"
          >
            {[1, 2, 3, 4, 5].map((p) => (
              <option key={p} value={p}>P{p}</option>
            ))}
          </select>
        </div>
      </div>
      <div>
        <label className="text-xs font-medium text-secondary mb-1.5 block">Project</label>
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="input-field text-xs h-10"
        >
          <option value="">No Project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      <div className="flex gap-2">
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
        <div>
          <label className="text-xs font-medium text-secondary mb-1.5 block">Duration (mins)</label>
          <input
            type="number"
            value={estimatedMinutes}
            onChange={(e) => setEstimatedMinutes(e.target.value)}
            placeholder="30"
            className="input-field text-xs h-10 w-24 shrink-0"
            min={1}
          />
        </div>
      </div>
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
                    ? "bg-accent text-base"
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
        <button type="submit" className="btn btn-primary px-6 py-2 text-sm">
          {isEdit ? "Update Task" : "Create Task"}
        </button>
      </div>
    </form>
  );
}
