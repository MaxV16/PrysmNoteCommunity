export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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
