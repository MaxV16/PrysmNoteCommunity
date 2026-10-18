import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  TaskReminderFields,
  taskReminderDraft,
  describeReminder,
  type TaskReminderDraft,
} from "./TaskReminderFields";

function draft(over: Partial<TaskReminderDraft> = {}): TaskReminderDraft {
  return { enabled: false, at: null, inapp: true, push: false, email: false, ...over };
}

beforeEach(() => {
  localStorage.clear();
});

describe("TaskReminderFields", () => {
  it("keeps the existing task channels and time in the draft", () => {
    const value = taskReminderDraft({
      reminder_enabled: true,
      reminder_at: "2026-10-18T09:00:00Z",
      reminder_inapp: false,
      reminder_push: true,
      reminder_email: true,
    });
    expect(value.enabled).toBe(true);
    expect(value.at).toBe("2026-10-18T09:00:00Z");
    expect(value.inapp).toBe(false);
    expect(value.push).toBe(true);
    expect(value.email).toBe(true);
  });

  it("fills in a date and time when the reminder is switched on", () => {
    const onChange = vi.fn();
    render(
      <TaskReminderFields
        value={draft()}
        onChange={onChange}
        suggestedDate="2026-10-20"
      />
    );

    fireEvent.click(screen.getByTestId("task-reminder-toggle"));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as TaskReminderDraft;
    expect(next.enabled).toBe(true);
    expect(next.at).toBeTruthy();
    expect(new Date(next.at as string).getFullYear()).toBe(2026);
  });

  it("persists the picked date and time as an ISO instant", () => {
    const onChange = vi.fn();
    render(
      <TaskReminderFields
        value={draft({ enabled: true, at: "2026-10-20T09:00:00Z" })}
        onChange={onChange}
      />
    );

    fireEvent.change(screen.getByTestId("task-reminder-date"), {
      target: { value: "2026-11-03" },
    });
    const next = onChange.mock.calls.at(-1)?.[0] as TaskReminderDraft;
    expect(next.at).toBeTruthy();
    expect(new Date(next.at as string).getDate()).toBe(3);
    expect(new Date(next.at as string).getMonth()).toBe(10);
  });

  it("toggles channels and reports the selection for side effects", () => {
    const onChange = vi.fn();
    const onChannelChange = vi.fn();
    render(
      <TaskReminderFields
        value={draft({ enabled: true, at: "2026-10-20T09:00:00Z" })}
        onChange={onChange}
        onChannelChange={onChannelChange}
      />
    );

    fireEvent.click(screen.getByTestId("task-reminder-channel-email"));
    expect(onChannelChange).toHaveBeenCalledWith("email", true);
    const next = onChange.mock.calls.at(-1)?.[0] as TaskReminderDraft;
    expect(next.email).toBe(true);

    fireEvent.click(screen.getByTestId("task-reminder-channel-inapp"));
    const after = onChange.mock.calls.at(-1)?.[0] as TaskReminderDraft;
    expect(after.inapp).toBe(false);
  });

  it("describes a missing and a concrete reminder", () => {
    expect(describeReminder(null)).toBe("No time set");
    expect(describeReminder("2026-10-18T09:00:00Z")).not.toBe("No time set");
  });
});
