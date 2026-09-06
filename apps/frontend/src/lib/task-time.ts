import type { Task } from "@/types/task";

// Format an "HH:MM" (or "HH:MM:SS") string as a 12-hour clock label.
export function formatTime12(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2];
  if (hour < 0 || hour > 23) return null;
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${minute} ${suffix}`;
}

// Human label for a task's time slot: "9:00 AM" for a single start time,
// "9:00 AM – 5:00 PM" when an end time is present, or null for all-day/inbox.
export function taskTimeLabel(task: Pick<Task, "start_time" | "end_time" | "is_all_day">): string | null {
  if (task.is_all_day) return null;
  const start = formatTime12(task.start_time);
  if (!start) return null;
  const end = formatTime12(task.end_time);
  return end ? `${start} - ${end}` : start;
}