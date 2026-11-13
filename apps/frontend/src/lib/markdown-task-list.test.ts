import { describe, it, expect } from "vitest";
import {
  isTaskListLine,
  taskListLineIndexes,
  toggleTaskListCheckbox,
  toggleTaskListCheckboxAtLine,
} from "./markdown-task-list";

const DOC = ["Intro line", "- [ ] first", "- [x] second", "  - [ ] nested", "Tail"].join("\n");

describe("task list markdown helpers", () => {
  it("finds every task list line in document order", () => {
    expect(taskListLineIndexes(DOC)).toEqual([1, 2, 3]);
    expect(isTaskListLine("- [ ] plain")).toBe(true);
    expect(isTaskListLine("- plain bullet")).toBe(false);
    expect(isTaskListLine("> - [x] quoted")).toBe(true);
  });

  it("ticks a line by its rendered checkbox ordinal", () => {
    const next = toggleTaskListCheckbox(DOC, 0, true);
    const lines = next.split("\n");
    expect(lines[1]).toBe("- [x] first");
    // Only the addressed line changes.
    expect(lines[2]).toBe("- [x] second");
    expect(lines[0]).toBe("Intro line");
  });

  it("unticks a checked line", () => {
    expect(toggleTaskListCheckbox(DOC, 1, false).split("\n")[2]).toBe("- [ ] second");
  });

  it("supports an explicit line index and keeps other formatting", () => {
    const text = "- [ ] **bold** item with ![pic](/api/uploads/a.png)";
    expect(toggleTaskListCheckboxAtLine(text, 0, true)).toBe(
      "- [x] **bold** item with ![pic](/api/uploads/a.png)"
    );
  });

  it("is a no-op for a stale index or a non-checklist line", () => {
    expect(toggleTaskListCheckbox(DOC, 9, true)).toBe(DOC);
    expect(toggleTaskListCheckboxAtLine(DOC, 0, true)).toBe(DOC);
    expect(toggleTaskListCheckboxAtLine("plain", 0, true)).toBe("plain");
  });
});
