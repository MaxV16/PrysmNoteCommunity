import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReminderStack } from "./ReminderStack";

function tomorrowISO(): string {
  // Build a LOCAL date string: the component compares against local midnight, so
  // a UTC (`toISOString`) value is off by a day in UTC+X timezones after ~22:00.
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

describe("ReminderStack", () => {
  it("renders nothing when there are no reminders", () => {
    const { container } = render(
      <ReminderStack reminders={[]} onDone={vi.fn()} onSnooze={vi.fn()} onOpen={vi.fn()} onDismiss={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a reminder card and wires its actions", () => {
    const onDone = vi.fn();
    const onSnooze = vi.fn();
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ReminderStack
        reminders={[{ taskId: "t1", title: "Buy milk", dueDate: tomorrowISO() }]}
        onDone={onDone}
        onSnooze={onSnooze}
        onOpen={onOpen}
        onDismiss={onDismiss}
      />
    );

    expect(screen.getByText("Buy milk")).toBeInTheDocument();
    expect(screen.getByText("Due tomorrow")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledWith("t1");

    fireEvent.click(screen.getByRole("button", { name: "Snooze 1h" }));
    expect(onSnooze).toHaveBeenCalledWith("t1");

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledWith("t1");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss reminder" }));
    expect(onDismiss).toHaveBeenCalledWith("t1");
  });

  it("caps visible cards and reports the overflow", () => {
    const many = Array.from({ length: 7 }, (_, i) => ({
      taskId: `t${i}`,
      title: `Task ${i}`,
      dueDate: tomorrowISO(),
    }));
    render(
      <ReminderStack
        reminders={many}
        total={many.length}
        onDone={vi.fn()}
        onSnooze={vi.fn()}
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByText("Task 0")).toBeInTheDocument();
    expect(screen.getByText("Task 4")).toBeInTheDocument();
    expect(screen.queryByText("Task 5")).not.toBeInTheDocument();
    expect(screen.getByText("+2 more reminders")).toBeInTheDocument();
  });

  it("lifts above the mobile action bar when raised", () => {
    const { getByTestId } = render(
      <ReminderStack
        reminders={[{ taskId: "t1", title: "Buy milk", dueDate: tomorrowISO() }]}
        raised
        onDone={vi.fn()}
        onSnooze={vi.fn()}
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    expect(getByTestId("reminder-stack").className).toContain("bottom-24");
  });

  it("moves clear of the open task drawer instead of covering its footer", () => {
    const { getByTestId } = render(
      <ReminderStack
        reminders={[{ taskId: "t1", title: "Buy milk", dueDate: tomorrowISO() }]}
        drawerOpen
        onDone={vi.fn()}
        onSnooze={vi.fn()}
        onOpen={vi.fn()}
        onDismiss={vi.fn()}
      />
    );
    const cls = getByTestId("reminder-stack").className;
    // Bottom-left on desktop, hidden on phones where the drawer fills the screen.
    expect(cls).toContain("left-4");
    expect(cls).not.toContain("right-4");
    expect(cls).toContain("hidden");
    expect(cls).toContain("sm:flex");
  });
});
