import { describe, it, expect } from "vitest";
import type { Task } from "@/types/task";
import type { BoardSection } from "@/lib/board-sections";
import {
  applyBoardDrop,
  byBoardOrder,
  computeBoardDrop,
  sectionTasks,
  taskInSection,
  unsortedTasks,
  UNSORTED_ID,
} from "./board-dnd";

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    user_id: "u1",
    parent_task_id: null,
    board_section_id: null,
    board_order: null,
    title: id,
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

const kanbanSections: BoardSection[] = [
  { id: "s-backlog", kind: "kanban", title: "Backlog", color: "#9E9E9E", status: "backlog", position: 0 },
  { id: "s-done", kind: "kanban", title: "Done", color: "#66BB6A", status: "done", position: 3 },
];

const freeSections: BoardSection[] = [
  { id: "free-1", kind: "board", title: "Ideas", color: "#000000", status: null, position: 0 },
];

describe("taskInSection", () => {
  it("status sections match by status only when the task is not pinned", () => {
    expect(taskInSection(makeTask("t1", { status: "backlog" }), kanbanSections[0])).toBe(true);
    expect(taskInSection(makeTask("t1", { status: "backlog", board_section_id: "free-1" }), kanbanSections[0])).toBe(false);
    expect(taskInSection(makeTask("t1", { status: "done" }), kanbanSections[0])).toBe(false);
  });

  it("free sections match by board_section_id regardless of status", () => {
    expect(taskInSection(makeTask("t1", { status: "done", board_section_id: "free-1" }), freeSections[0])).toBe(true);
    expect(taskInSection(makeTask("t1", { board_section_id: null }), freeSections[0])).toBe(false);
  });
});

describe("computeBoardDrop", () => {
  it("drops onto a section header append to that section", () => {
    const tasks = [makeTask("t1", { status: "backlog" }), makeTask("t2", { status: "backlog" })];
    expect(computeBoardDrop(tasks, kanbanSections, "t1", "s-backlog")).toEqual({
      sectionId: "s-backlog",
      index: 1,
    });
  });

  it("cross-section drop onto a card uses the card's section", () => {
    const tasks = [makeTask("t1", { status: "backlog" }), makeTask("t2", { status: "done" })];
    expect(computeBoardDrop(tasks, kanbanSections, "t1", "t2")).toEqual({
      sectionId: "s-done",
      index: 0,
    });
  });

  it("same-section reorder computes the index in the sibling set without the dragged card", () => {
    const tasks = [
      makeTask("t1", { status: "backlog", board_order: 0 }),
      makeTask("t2", { status: "backlog", board_order: 1 }),
      makeTask("t3", { status: "backlog", board_order: 2 }),
    ];
    // siblings without t1 = [t2, t3]; t3 is at index 1
    expect(computeBoardDrop(tasks, kanbanSections, "t1", "t3")).toEqual({
      sectionId: "s-backlog",
      index: 1,
    });
    // move t3 onto t1 → siblings without t3 = [t1, t2]; t1 at index 0
    expect(computeBoardDrop(tasks, kanbanSections, "t3", "t1")).toEqual({
      sectionId: "s-backlog",
      index: 0,
    });
  });

  it("a task pinned to a free section is not treated as a status-column card", () => {
    const tasks = [
      makeTask("t1", { status: "backlog", board_section_id: "free-1" }),
      makeTask("t2", { status: "backlog" }),
    ];
    // t1 pinned → not part of the backlog status column; the column has only t2,
    // so dropping onto t2 lands at index 0 of the backlog section.
    expect(computeBoardDrop(tasks, kanbanSections, "t1", "t2")).toEqual({
      sectionId: "s-backlog",
      index: 0,
    });
  });

  it("free-section drops resolve by board_section_id", () => {
    const tasks = [makeTask("t1", { status: "done", board_section_id: "free-1" })];
    expect(computeBoardDrop(tasks, freeSections, "t1", "free-1")).toEqual({
      sectionId: "free-1",
      index: 0,
    });
  });

  it("drops onto the Unsorted area append to the unsorted set", () => {
    const tasks = [makeTask("t1"), makeTask("t2", { board_section_id: "free-1" })];
    // unsorted (board_section_id null) = [t1]; excluding the dragged t1 → index 0
    expect(computeBoardDrop(tasks, freeSections, "t1", UNSORTED_ID)).toEqual({
      sectionId: null,
      index: 0,
    });
  });

  it("returns null for an unknown over target", () => {
    const tasks = [makeTask("t1")];
    expect(computeBoardDrop(tasks, kanbanSections, "t1", "ghost")).toBeNull();
  });
});

describe("applyBoardDrop", () => {
  it("status-section move sets status and clears the pin", () => {
    const tasks = [makeTask("t1", { status: "backlog" })];
    const next = applyBoardDrop(tasks, "t1", { sectionId: "s-done", index: 0 }, kanbanSections);
    expect(next[0].status).toBe("done");
    expect(next[0].board_section_id).toBeNull();
    expect(next[0].board_order).toBe(0);
  });

  it("free-section move keeps status and sets board_section_id", () => {
    const tasks = [makeTask("t1", { status: "todo" })];
    const next = applyBoardDrop(tasks, "t1", { sectionId: "free-1", index: 0 }, freeSections);
    expect(next[0].status).toBe("todo");
    expect(next[0].board_section_id).toBe("free-1");
    expect(next[0].board_order).toBe(0);
  });

  it("unsorted move clears board_section_id and keeps status", () => {
    const tasks = [makeTask("t1", { status: "in_progress", board_section_id: "free-1" })];
    const next = applyBoardDrop(tasks, "t1", { sectionId: null, index: 0 }, freeSections);
    expect(next[0].board_section_id).toBeNull();
    expect(next[0].status).toBe("in_progress");
  });

  it("renumbers board_order across the destination sibling set", () => {
    const tasks = [
      makeTask("t1", { status: "backlog", board_order: 0 }),
      makeTask("t2", { status: "backlog", board_order: 1 }),
      makeTask("t3", { status: "backlog", board_order: 2 }),
    ];
    const next = applyBoardDrop(tasks, "t3", { sectionId: "s-backlog", index: 0 }, kanbanSections);
    const ordered = [...next].sort(byBoardOrder);
    expect(ordered.map((t) => t.id)).toEqual(["t3", "t1", "t2"]);
    expect(ordered.map((t) => t.board_order)).toEqual([0, 1, 2]);
  });
});

describe("selectors", () => {
  it("sectionTasks filters by status membership and free pins", () => {
    const tasks = [
      makeTask("a", { status: "backlog" }),
      makeTask("b", { status: "backlog", board_section_id: "free-1" }),
      makeTask("c", { status: "done" }),
    ];
    expect(sectionTasks(tasks, kanbanSections[0]).map((t) => t.id)).toEqual(["a"]);
    expect(sectionTasks(tasks, freeSections[0]).map((t) => t.id)).toEqual(["b"]);
  });

  it("unsortedTasks returns tasks without a free-section pin", () => {
    const tasks = [
      makeTask("a"),
      makeTask("b", { board_section_id: "free-1" }),
    ];
    expect(unsortedTasks(tasks).map((t) => t.id)).toEqual(["a"]);
  });
});
