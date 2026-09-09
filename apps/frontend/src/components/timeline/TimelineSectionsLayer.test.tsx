import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DndContext } from "@dnd-kit/core";
import { TimelineSectionsLayer } from "./TimelineSectionsLayer";
import type { TimelineSection } from "@/hooks/useTimelineSections";
import type { Task } from "@/types/task";

const baseSection: TimelineSection = {
  id: "sec1",
  name: "Focus",
  color: "#4FC3F7",
  start_pct: 50,
  end_pct: 100,
  rule_kind: "priority",
  rule_value: "4,5",
  position: 0,
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    user_id: "u1",
    parent_task_id: null,
    board_section_id: null,
    board_order: null,
    title: "Task A",
    description: null,
    status: "todo",
    priority: 4,
    // Day index 5 in the 7-day window falls inside the 50..100% band when the
    // virtual viewport is 1000px wide (band covers days 4..6).
    start_date: "2026-09-14",
    due_date: "2026-09-14",
    start_time: null,
    end_time: null,
    is_all_day: false,
    estimated_minutes: null,
    recurrence_rule: null,
    recurrence_end_date: null,
    sort_order: 0,
    is_archived: false,
    list_id: null,
    deleted_at: null,
    completed_at: null,
    created_at: "2026-09-09T00:00:00Z",
    updated_at: "2026-09-09T00:00:00Z",
    ...overrides,
  };
}

const day = new Date(2026, 8, 9);
const days = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(day);
  d.setDate(d.getDate() + i);
  return d;
});

const bodyRef = { current: null } as React.RefObject<HTMLDivElement | null>;

function renderLayer(props: Partial<React.ComponentProps<typeof TimelineSectionsLayer>> = {}) {
  const defaults = {
    sections: [baseSection],
    tasks: [makeTask()],
    days,
    dayWidth: 120,
    bodyRef,
    lists: [],
    tags: [],
    onSplit: vi.fn(),
    onRename: vi.fn(),
    onSetRule: vi.fn(),
    onDelete: vi.fn(),
  };
  return render(
    <DndContext>
      <div className="relative" style={{ width: 800, height: 300, overflow: "auto" }}>
        <TimelineSectionsLayer {...defaults} {...props} />
      </div>
    </DndContext>
  );
}

describe("TimelineSectionsLayer", () => {
  beforeEach(() => {
    (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it("renders a band per section with its name", () => {
    renderLayer();
    expect(screen.getByTestId("timeline-section-sec1")).toBeInTheDocument();
    expect(screen.getByText("Focus")).toBeInTheDocument();
  });

  it("shows matching tasks inside the band", () => {
    renderLayer({ tasks: [makeTask(), makeTask({ id: "t2", title: "Other", priority: 1 })] });
    expect(screen.getByText("Task A")).toBeInTheDocument();
    expect(screen.queryByText("Other")).not.toBeInTheDocument();
  });

  it("renders the split handle when no band spans 50..100", () => {
    renderLayer({ sections: [{ ...baseSection, start_pct: 0, end_pct: 40 }] });
    expect(screen.getByTestId("timeline-section-split")).toBeInTheDocument();
    expect(screen.getByLabelText("Split timeline band")).toBeInTheDocument();
  });

  it("hides the split handle once a 50..100 band exists", () => {
    renderLayer();
    expect(screen.queryByTestId("timeline-section-split")).not.toBeInTheDocument();
  });

  it("calls onRename with the new name on blur", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    renderLayer({ onRename });
    await user.click(screen.getByText("Focus"));
    const input = screen.getByLabelText("Rename section Focus");
    await user.clear(input);
    await user.type(input, "Deep Work");
    await user.tab();
    expect(onRename).toHaveBeenCalledWith("sec1", "Deep Work");
  });

  it("applies a rule pick from the dropdown", async () => {
    const user = userEvent.setup();
    const onSetRule = vi.fn();
    renderLayer({ onSetRule });
    await user.click(screen.getByLabelText("Section rule"));
    const done = await screen.findByText("Status: done");
    await user.click(done);
    expect(onSetRule).toHaveBeenCalledWith("sec1", "status", "done");
  });

  it("calls onDelete from the band's delete button", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    renderLayer({ onDelete });
    await user.click(screen.getByLabelText("Delete section Focus"));
    expect(onDelete).toHaveBeenCalledWith("sec1");
  });

  it("calls onSplit from the split handle", async () => {
    const user = userEvent.setup();
    const onSplit = vi.fn();
    renderLayer({ sections: [], onSplit });
    await user.click(screen.getByLabelText("Split timeline band"));
    expect(onSplit).toHaveBeenCalled();
  });
});