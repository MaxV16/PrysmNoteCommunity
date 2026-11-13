import { describe, it, expect } from "vitest";
import { moveSubtaskById } from "./subtask-order";

const rows = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "done" }];

describe("moveSubtaskById", () => {
  it("moves a row down onto a later target (after it)", () => {
    expect(moveSubtaskById(rows, "a", "c")?.map((r) => r.id)).toEqual([
      "b",
      "c",
      "a",
      "done",
    ]);
  });

  it("moves a row up onto an earlier target (before it), including the very top", () => {
    expect(moveSubtaskById(rows, "c", "a")?.map((r) => r.id)).toEqual([
      "c",
      "a",
      "b",
      "done",
    ]);
    expect(moveSubtaskById(rows, "b", "a")?.map((r) => r.id)).toEqual([
      "b",
      "a",
      "c",
      "done",
    ]);
  });

  it("keeps completed rows where they are when open rows are reordered", () => {
    const next = moveSubtaskById(rows, "a", "b");
    expect(next?.map((r) => r.id)).toEqual(["b", "a", "c", "done"]);
    expect(next?.[3].id).toBe("done");
  });

  it("returns null for a no-op or unknown ids", () => {
    expect(moveSubtaskById(rows, "a", "a")).toBeNull();
    expect(moveSubtaskById(rows, "missing", "a")).toBeNull();
    expect(moveSubtaskById(rows, "a", "missing")).toBeNull();
  });

  it("does not mutate the input", () => {
    moveSubtaskById(rows, "a", "b");
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "done"]);
  });
});
