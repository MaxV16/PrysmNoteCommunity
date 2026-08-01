export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Return `date` as a `YYYY-MM-DD` string in the user's local timezone.
 * Date-only strings parsed with `new Date("YYYY-MM-DD")` are treated as UTC
 * midnight by the JS runtime, which shifts the calendar day in timezones away
 * from UTC. Formatting from local date fields keeps the task anchored to the
 * same local day the timeline renders.
 */
export function toLocalDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Parse a `YYYY-MM-DD` value as a local-midnight Date (not UTC), so it lines up
 * with the timeline's local day columns regardless of the user's timezone.
 */
export function parseLocalDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? new Date(NaN) : d;
  }
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

export function getStatusColor(status: string): string {
  switch (status) {
    case "backlog": return "var(--text-muted)";
    case "todo": return "var(--accent)";
    case "in_progress": return "var(--warning)";
    case "done": return "var(--success)";
    case "cancelled": return "var(--danger)";
    default: return "var(--text-secondary)";
  }
}
