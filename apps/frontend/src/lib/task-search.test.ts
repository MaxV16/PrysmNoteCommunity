import { describe, it, expect } from "vitest";
import { matchesSearchQuery } from "./task-search";
import type { Task } from "@/types/task";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    user_id: "u1",
    parent_task_id: null,
    board_section_id: null,
    board_order: null,
    title: "Buy groceries",
    description: null,
    status: "todo",
    priority: 2,
    start_date: null,
    due_date: null,
    is_all_day: false,
    estimated_minutes: null,
    recurrence_rule: null,
    recurrence_end_date: null,
    sort_order: 0,
    is_archived: false,
    completed_at: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("matchesSearchQuery", () => {
  it("matches on title", () => {
    expect(matchesSearchQuery(makeTask(), "groceries")).toBe(true);
  });

  it("matches on title case-insensitively", () => {
    expect(matchesSearchQuery(makeTask(), "GROCERIES")).toBe(true);
  });

  it("matches on description", () => {
    const task = makeTask({ description: "includes a quarterly review" });
    expect(matchesSearchQuery(task, "quarterly")).toBe(true);
  });

  it("matches on tag names", () => {
    const task = makeTask({
      tags: [{ id: "tag-1", name: "Billing", color: "#ff0000" }],
    });
    expect(matchesSearchQuery(task, "billing")).toBe(true);
    expect(matchesSearchQuery(task, "BILLING")).toBe(true);
  });

  it("does not match when nothing contains the query", () => {
    const task = makeTask({
      description: "nothing relevant",
      tags: [{ id: "tag-1", name: "misc", color: "#ff0000" }],
    });
    expect(matchesSearchQuery(task, "xyz")).toBe(false);
  });

  it("returns true for an empty query", () => {
    expect(matchesSearchQuery(makeTask(), "")).toBe(true);
  });
});
