import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MobileTabBar } from "./MobileTabBar";

const routerPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

function renderBar(props: Partial<React.ComponentProps<typeof MobileTabBar>> = {}) {
  return render(
    <MobileTabBar
      view="timeline"
      onSelectView={vi.fn()}
      onOpenAi={vi.fn()}
      showFinance={false}
      showWatchlist={false}
      showHabits={false}
      showQuadrant={false}
      showFocus={false}
      showCountdown={false}
      {...props}
    />
  );
}

describe("MobileTabBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows exactly the four fixed slots with no clipped workspaces", () => {
    renderBar({ showFinance: true, showWatchlist: true, showHabits: true });
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Chat")).toBeTruthy();
    expect(screen.getByText("Capture")).toBeTruthy();
    expect(screen.getByText("More")).toBeTruthy();
    // Workspaces live behind More, never in the bar itself.
    expect(screen.queryByText("Finance")).toBeNull();
    expect(screen.queryByText("Watchlist")).toBeNull();
    expect(screen.queryByText("Habits")).toBeNull();
  });

  it("lists only the enabled workspaces in the More sheet", async () => {
    const user = userEvent.setup();
    renderBar({ showFinance: true, showHabits: true });
    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Finance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Habits" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Quadrant" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Shows & Movies" })).toBeNull();
  });

  it("selects a workspace from the sheet and closes it", async () => {
    const user = userEvent.setup();
    const onSelectView = vi.fn();
    renderBar({ showHabits: true, onSelectView });
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("button", { name: "Habits" }));
    expect(onSelectView).toHaveBeenCalledWith("habits");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks More as active while a workspace view is showing", () => {
    renderBar({ view: "habits", showHabits: true });
    expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-current")).toBe("page");
  });

  it("navigates to /capture when the Capture tab is pressed", async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole("button", { name: "Capture" }));
    expect(routerPush).toHaveBeenCalledWith("/capture");
  });

  it("calls onSelectView for the Today tab", async () => {
    const user = userEvent.setup();
    const onSelectView = vi.fn();
    renderBar({ onSelectView });
    await user.click(screen.getByText("Today"));
    expect(onSelectView).toHaveBeenCalledWith("timeline");
  });

  it("calls onOpenAi for the Chat tab", async () => {
    const user = userEvent.setup();
    const onOpenAi = vi.fn();
    renderBar({ onOpenAi });
    await user.click(screen.getByText("Chat"));
    expect(onOpenAi).toHaveBeenCalled();
  });
});
