import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HabitsWorkspace } from "./HabitsWorkspace";

vi.mock("@/hooks/useHabits", () => {
  const mockCreate = vi.fn();
  const mockDelete = vi.fn();
  const mockToggle = vi.fn();
  const mockFetch = vi.fn();
  return {
    useHabits: () => ({
      habits: [
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
      ],
      loading: false,
      fetchHabits: mockFetch,
      createHabit: mockCreate,
      toggleLog: mockToggle,
      deleteHabit: mockDelete,
    }),
  };
});

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
});