import { describe, it, expect, afterEach, vi, type Mock } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { DesktopTitlebar } from "./DesktopTitlebar";
import * as bridge from "@/lib/desktop-bridge";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

vi.mock("@/lib/desktop-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/desktop-bridge")>();
  return { ...actual, hasWindowControlsOverlay: vi.fn(() => false) };
});

function installBridge(platform: string) {
  (window as unknown as { prysmDesktop?: unknown }).prysmDesktop = {
    platform,
    isDesktop: true,
    minimize: vi.fn(),
    maximizeToggle: vi.fn(),
    close: vi.fn(),
    isMaximized: async () => false,
    onMaximizedChanged: vi.fn(),
    setTitleBarOverlay: vi.fn(),
  };
}

// The desktop chrome only appears when the in-app shell is mounted, so render
// the same `[data-app-shell]` element the real AppShell provides.
function renderWithShell() {
  return render(
    <>
      <div data-app-shell />
      <DesktopTitlebar />
    </>
  );
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { prysmDesktop?: unknown }).prysmDesktop;
  document.body.className = "";
  vi.clearAllMocks();
});

describe("DesktopTitlebar window controls", () => {
  it("draws in-app minimize/maximize/close when Windows has no native overlay", async () => {
    // Regression: the live renderer used to draw no buttons for Windows while
    // an older desktop build was frameless, leaving the window with none.
    (bridge.hasWindowControlsOverlay as Mock).mockReturnValue(false);
    installBridge("win32");
    renderWithShell();
    await waitFor(() => expect(screen.getByLabelText("Minimize")).toBeInTheDocument());
    expect(screen.getByLabelText("Maximize")).toBeInTheDocument();
    expect(screen.getByLabelText("Close")).toBeInTheDocument();
  });

  it("leaves the buttons to the OS when the native overlay is present", async () => {
    (bridge.hasWindowControlsOverlay as Mock).mockReturnValue(true);
    installBridge("win32");
    renderWithShell();
    await waitFor(() => expect(screen.getByText("Prysm Note")).toBeInTheDocument());
    expect(screen.queryByLabelText("Minimize")).toBeNull();
    expect(screen.queryByLabelText("Close")).toBeNull();
  });

  it("keeps macOS native (traffic lights, no in-app controls)", async () => {
    (bridge.hasWindowControlsOverlay as Mock).mockReturnValue(false);
    installBridge("darwin");
    renderWithShell();
    await waitFor(() => expect(document.body.classList.contains("desktop-shell")).toBe(true));
    expect(screen.queryByLabelText("Minimize")).toBeNull();
    expect(screen.queryByText("Prysm Note")).toBeNull();
  });

  it("adds no shell chrome on the public landing without the app shell", async () => {
    // Regression: the marketing landing lives at "/" without [data-app-shell],
    // so the fixed-height shell layout used to apply there and froze scrolling
    // and clicks in the desktop app.
    (bridge.hasWindowControlsOverlay as Mock).mockReturnValue(false);
    installBridge("darwin");
    render(<DesktopTitlebar />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.body.classList.contains("desktop-shell")).toBe(false);
    expect(screen.queryByText("Prysm Note")).toBeNull();
  });
});
