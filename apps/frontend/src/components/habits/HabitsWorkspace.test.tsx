import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HabitsWorkspace } from "./HabitsWorkspace";

const h = vi.hoisted(() => {
  let habits = [
    {
      id: "h1",
      title: "Read daily",
      frequency: "daily",
      target_count: 1,
      color: "#4FC3F7",
      streak: 3,
      created_at: "2026-09-01T00:00:00Z",
    },
    {
      id: "h2",
      title: "Exercise",
      frequency: "weekly",
      target_count: 1,
      color: "#66BB6A",
      streak: 7,
      created_at: "2026-08-15T00:00:00Z",
    },
  ];
  const createHabit = vi.fn(async (payload: { title: string }) => {
    const next = {
      id: "h-new",
      title: payload.title,
      frequency: "daily",
      target_count: 1,
      color: null,
      streak: 0,
      created_at: "2026-09-10T00:00:00Z",
    };
    habits = [...habits, next];
    return next;
  });
  return {
    habits: () => habits,
    createHabit,
    deleteHabit: vi.fn(),
    toggleLog: vi.fn(),
    fetchHabits: vi.fn(),
  };
});

vi.mock("@/hooks/useHabits", () => ({
  useHabits: () => ({
    habits: h.habits(),
    loading: false,
    fetchHabits: h.fetchHabits,
    createHabit: h.createHabit,
    toggleLog: h.toggleLog,
    deleteHabit: h.deleteHabit,
  }),
}));

describe("HabitsWorkspace", () => {
  it("renders the habits view with header and habit items", () => {
    render(<HabitsWorkspace />);
    // The header bar has a "Habits" heading; the card inside also says "Habits"
    // so use getAllByText.
    expect(screen.getAllByText("Habits").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Read daily")).toBeInTheDocument();
    expect(screen.getByText("Exercise")).toBeInTheDocument();
    // The streak spans show "3d" and "7d".
    expect(screen.getAllByText(/3d/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/7d/).length).toBeGreaterThanOrEqual(1);
  });

  it("toggles the new-habit form when clicking + New Habit", async () => {
    const user = userEvent.setup();
    render(<HabitsWorkspace />);
    const btn = screen.getByRole("button", { name: /New Habit/ });
    await user.click(btn);
    expect(screen.getByText("New Habit")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Habit name...")).toBeInTheDocument();
    await user.click(screen.getByText("Cancel"));
    expect(screen.queryByText("New Habit")).not.toBeInTheDocument();
  });

  it("shows a created habit in the tracker immediately, without a refresh", async () => {
    const user = userEvent.setup();
    render(<HabitsWorkspace />);
    await user.click(screen.getByRole("button", { name: /New Habit/ }));
    await user.type(screen.getByPlaceholderText("Habit name..."), "Drink water");
    await user.click(screen.getByRole("button", { name: /Add|Save|Create/i }));
    // The lifted useHabits instance appends to state on create, so the tracker
    // renders the new habit on the same render pass (historically it needed a
    // page refresh because HabitForm and HabitTracker held separate instances).
    expect(screen.getByText("Drink water")).toBeInTheDocument();
  });
});