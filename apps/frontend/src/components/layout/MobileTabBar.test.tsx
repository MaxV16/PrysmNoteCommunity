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
      {...props}
    />
  );
}

describe("MobileTabBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("always shows Today, Chat and Capture tabs", () => {
    renderBar();
    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.getByText("Chat")).toBeTruthy();
    expect(screen.getByText("Capture")).toBeTruthy();
    expect(screen.queryByText("Finance")).toBeNull();
    expect(screen.queryByText("Watchlist")).toBeNull();
  });

  it("shows Finance and Watchlist only when their modules are enabled", () => {
    renderBar({ showFinance: true, showWatchlist: true });
    expect(screen.getByText("Finance")).toBeTruthy();
    expect(screen.getByText("Watchlist")).toBeTruthy();
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
