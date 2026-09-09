import { describe, it, expect } from "vitest";
import { buildDuplicatePayload } from "./task-duplicate";

const baseTask = {
  id: "t1",
  user_id: "u1",
  parent_task_id: "parent-1",
  board_section_id: "sec-1",
  board_order: 3,
  title: "Ship feature",
  description: "desc",
  status: "in_progress",
  priority: 1,
  start_date: "2026-08-01",
  due_date: "2026-08-05",
  is_all_day: true,
  estimated_minutes: 90,
  recurrence_rule: "FREQ=DAILY",
  recurrence_end_date: "2026-09-01",
  sort_order: 0,
  is_archived: false,
  completed_at: null,
  created_at: "2026-08-01T00:00:00",
  updated_at: "2026-08-01T00:00:00",
  tags: [{ id: "tag1", name: "work", color: "#f00" }],
  links: [],
  subtasks: [{ id: "sub1", title: "child", status: "todo" }],
  list_id: "list-1",
} as const;

describe("buildDuplicatePayload", () => {
  it("copies the user-facing fields", () => {
    expect(buildDuplicatePayload(baseTask as never)).toEqual({
      title: "Ship feature",
      description: "desc",
      start_date: "2026-08-01",
      due_date: "2026-08-05",
      priority: 1,
      estimated_minutes: 90,
      tag_ids: ["tag1"],
      list_id: "list-1",
    });
  });

  it("excludes recurrence, parent/board placement and subtasks", () => {
    const payload = buildDuplicatePayload(baseTask as never);
    expect(payload).not.toHaveProperty("recurrence_rule");
    expect(payload).not.toHaveProperty("recurrence_end_date");
    expect(payload).not.toHaveProperty("parent_task_id");
    expect(payload).not.toHaveProperty("board_section_id");
    expect(payload).not.toHaveProperty("board_order");
    expect(payload).not.toHaveProperty("subtasks");
    expect(payload).not.toHaveProperty("status");
  });

  it("handles tasks without tags", () => {
    const { tags: _tags, ...noTags } = baseTask;
    expect(buildDuplicatePayload(noTags as never)).toEqual({
      title: "Ship feature",
      description: "desc",
      start_date: "2026-08-01",
      due_date: "2026-08-05",
      priority: 1,
      estimated_minutes: 90,
      tag_ids: [],
      list_id: "list-1",
    });
  });
});
