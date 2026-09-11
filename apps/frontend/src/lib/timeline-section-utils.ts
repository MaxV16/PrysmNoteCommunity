"use client";

import type { Task, TaskList } from "@/types/task";
import type { TimelineSection } from "@/hooks/useSections";

const SECTION_PALETTE = ["#4FC3F7", "#FFA726", "#66BB6A", "#BA68C8", "#EF5350", "#FFCA28"];

export function sectionColor(section: TimelineSection, idx: number): string {
  return section.color ?? SECTION_PALETTE[idx % SECTION_PALETTE.length];
}

export function matchesRule(
  task: Task,
  section: TimelineSection,
  lists: TaskList[],
  tags: { id: string; name: string; color: string | null }[]
): boolean {
  const kind = section.rule_kind;
  const value = section.rule_value;
  if (!kind || kind === "all" || !value) return true;
  switch (kind) {
    case "priority":
      return value.split(",").map((p) => parseInt(p, 10)).includes(task.priority);
    case "status":
      return task.status === value;
    case "list":
      return task.list_id === value;
    case "tag":
      return (task.tags ?? []).some((t) => t.id === value);
    default:
      return false;
  }
}

export function ruleSummary(
  section: TimelineSection,
  lists: TaskList[],
  tags: { id: string; name: string; color: string | null }[]
): string | null {
  const kind = section.rule_kind;
  const value = section.rule_value;
  if (!kind || kind === "all" || !value) return null;
  switch (kind) {
    case "priority":
      if (value === "1") return "High";
      if (value === "2") return "Medium";
      if (value === "3") return "Low";
      return `Priority ${value}`;
    case "status":
      return `Status: ${value.replace(/_/g, " ")}`;
    case "list":
      return lists.find((l) => l.id === value)?.name ?? "List";
    case "tag":
      return `#${tags.find((t) => t.id === value)?.name ?? "tag"}`;
    default:
      return null;
  }
}