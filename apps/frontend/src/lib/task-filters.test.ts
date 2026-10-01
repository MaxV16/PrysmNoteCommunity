import { describe, it, expect, vi } from "vitest";

const TODAY = "2026-09-28";
vi.mock("@/lib/dates", () => ({
  todayISO: () => TODAY,
}));

import {
  applyNavFilter,
  isToday,
  isVisibleTask,
  isWithinNext7Days,
  NAV_FILTER_LABELS,
  navFilterLabel,
  smartListCounts,
} from "@/lib/task-filters";
import { filterVisibleTasks } from "@/hooks/useVisibleTasks";
import type { Task, TaskTag } from "@/types/task";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    user_id: "u1",
    parent_task_id: null,
    board_section_id: null,
    board_order: null,
    title: "Task",
    description: null,
    status: "todo",
    priority: 2,
    start_date: null,
    due_date: null,
    start_time: null,
    end_time: null,
    is_all_day: true,
    estimated_minutes: null,
    recurrence_rule: null,
    recurrence_end_date: null,
    sort_order: 0,
    is_archived: false,
    list_id: null,
    deleted_at: null,
    completed_at: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

const tag: TaskTag = { id: "tag-1", name: "work", color: null };

describe("isToday", () => {
  it("is true only for the current day", () => {
    expect(isToday(TODAY)).toBe(true);
    expect(isToday("2026-09-29")).toBe(false);
    expect(isToday(null)).toBe(false);
  });
});

describe("isWithinNext7Days", () => {
  it("covers tomorrow through today+7 and excludes today", () => {
    expect(isWithinNext7Days(TODAY)).toBe(false);
    expect(isWithinNext7Days("2026-09-29")).toBe(true);
    expect(isWithinNext7Days("2026-10-05")).toBe(true);
    expect(isWithinNext7Days("2026-10-06")).toBe(false);
    expect(isWithinNext7Days(null)).toBe(false);
  });
});

describe("isVisibleTask", () => {
  it("hides cancelled, archived and subtask rows", () => {
    expect(isVisibleTask(makeTask())).toBe(true);
    expect(isVisibleTask(makeTask({ status: "cancelled" }))).toBe(false);
    expect(isVisibleTask(makeTask({ is_archived: true }))).toBe(false);
    expect(isVisibleTask(makeTask({ parent_task_id: "parent" }))).toBe(false);
  });
});

describe("applyNavFilter", () => {
  const tasks = [
    makeTask({ id: "today", start_date: TODAY }),
    makeTask({ id: "tomorrow", due_date: "2026-09-29" }),
    makeTask({ id: "far", due_date: "2026-12-01" }),
    makeTask({ id: "undated" }),
    makeTask({ id: "done", status: "done", due_date: TODAY }),
  ];

  it("returns the same set for null and 'all'", () => {
    expect(applyNavFilter(tasks, null)).toEqual(tasks);
    expect(applyNavFilter(tasks, "all")).toEqual(tasks);
  });

  it("filters inbox, today, next7 and completed", () => {
    expect(applyNavFilter(tasks, "inbox").map((t) => t.id)).toEqual(["undated"]);
    expect(applyNavFilter(tasks, "today").map((t) => t.id).sort()).toEqual(["done", "today"]);
    expect(applyNavFilter(tasks, "next7").map((t) => t.id)).toEqual(["tomorrow"]);
    expect(applyNavFilter(tasks, "completed").map((t) => t.id)).toEqual(["done"]);
  });
});

describe("smartListCounts", () => {
  it("counts from the same base predicate as the views", () => {
    const tasks = [
      makeTask({ id: "today" }),
      makeTask({ id: "tomorrow", due_date: "2026-09-29" }),
      makeTask({ id: "done", status: "done" }),
      makeTask({ id: "archived", is_archived: true }),
      makeTask({ id: "cancelled", status: "cancelled" }),
      makeTask({ id: "subtask", parent_task_id: "p" }),
    ];
    // today/next7: dates not set on the base tasks above, so add explicit dates.
    tasks[0].due_date = TODAY;
    expect(smartListCounts(tasks)).toEqual({
      today: 1,
      next7: 1,
      all: 3,
      completed: 1,
    });
  });
});

describe("navFilterLabel", () => {
  it("maps every filter to a distinct, correct label", () => {
    expect(navFilterLabel(null)).toBeNull();
    expect(navFilterLabel("inbox")).toBe("Inbox");
    expect(navFilterLabel("today")).toBe("Today");
    expect(navFilterLabel("next7")).toBe("Next 7 Days");
    // Regression: 'all' and 'completed' must never render as "Next 7 Days".
    expect(navFilterLabel("all")).toBe("All Tasks");
    expect(navFilterLabel("completed")).toBe("Completed");
    expect(new Set(Object.values(NAV_FILTER_LABELS)).size).toBe(5);
  });
});

describe("filterVisibleTasks", () => {
  const tasks = [
    makeTask({ id: "today", due_date: TODAY, list_id: "l1", tags: [tag] }),
    makeTask({ id: "tomorrow", due_date: "2026-09-29", title: "Meeting", list_id: "l1" }),
    makeTask({ id: "other-list", due_date: TODAY, list_id: "l2" }),
    makeTask({ id: "archived", is_archived: true }),
  ];

  it("applies navFilter + list + tag + search consistently for every view", () => {
    const all = filterVisibleTasks(tasks, {
      navFilter: "all",
      activeListId: null,
      selectedTagId: null,
      searchQuery: "",
    });
    expect(all.map((t) => t.id).sort()).toEqual(["other-list", "today", "tomorrow"]);

    const today = filterVisibleTasks(tasks, {
      navFilter: "today",
      activeListId: null,
      selectedTagId: null,
      searchQuery: "",
    });
    expect(today.map((t) => t.id).sort()).toEqual(["other-list", "today"]);

    const byList = filterVisibleTasks(tasks, {
      navFilter: "all",
      activeListId: "l1",
      selectedTagId: null,
      searchQuery: "",
    });
    expect(byList.map((t) => t.id).sort()).toEqual(["today", "tomorrow"]);

    const byTag = filterVisibleTasks(tasks, {
      navFilter: "all",
      activeListId: null,
      selectedTagId: "tag-1",
      searchQuery: "",
    });
    expect(byTag.map((t) => t.id)).toEqual(["today"]);

    const bySearch = filterVisibleTasks(tasks, {
      navFilter: "all",
      activeListId: null,
      selectedTagId: null,
      searchQuery: "meeting",
    });
    expect(bySearch.map((t) => t.id)).toEqual(["tomorrow"]);
  });
});
