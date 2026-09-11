import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TimelineView, type TimelineViewMode } from "./TimelineView";
import { ToastProvider } from "@/lib/toast-context";

const h = vi.hoisted(() => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 20);
  return {
    start,
    end,
    tasks: [] as unknown[],
    selectedTaskIds: [] as string[],
    selectedTaskId: null as string | null,
    softDeleteWithUndo: vi.fn().mockResolvedValue(true),
    clearTaskSelection: vi.fn(),
    onViewModeChange: vi.fn(),
  };
});

vi.mock("@/stores/app-store", () => {
  const useAppStore = (selector?: (s: unknown) => unknown) => {
    const state = {
      tasks: h.tasks,
      lists: [] as unknown[],
      activeListId: null,
      tags: [] as unknown[],
      chatMessages: [] as unknown[],
      chatSessions: [] as unknown[],
      selectedTaskId: h.selectedTaskId,
      setSelectedTaskId: vi.fn(),
      selectedTaskIds: h.selectedTaskIds,
      setSelectedTaskIds: vi.fn(),
      toggleTaskSelected: vi.fn(),
      clearTaskSelection: h.clearTaskSelection,
      selectedTagId: null,
      searchQuery: "",
      setSearchQuery: vi.fn(),
      navFilter: null,
      setNavFilter: vi.fn(),
    };
    return selector ? selector(state) : state;
  };
  useAppStore.getState = () => ({
    tasks: h.tasks,
    lists: [] as unknown[],
    activeListId: null,
    tags: [] as unknown[],
    chatMessages: [] as unknown[],
    chatSessions: [] as unknown[],
    selectedTaskId: h.selectedTaskId,
    setSelectedTaskId: vi.fn(),
    selectedTaskIds: h.selectedTaskIds,
    setSelectedTaskIds: vi.fn(),
    toggleTaskSelected: vi.fn(),
    clearTaskSelection: h.clearTaskSelection,
    selectedTagId: null,
    searchQuery: "",
    setSearchQuery: vi.fn(),
    navFilter: null,
    setNavFilter: vi.fn(),
  });
  return { useAppStore };
});

vi.mock("@/hooks/useTimeline", () => ({
  useTimeline: () => ({
    visibleRange: { start: h.start, end: h.end },
    viewDays: 20,
    scrollOffset: -10,
    setScrollOffset: vi.fn(),
    expandBackward: vi.fn(),
    expandForward: vi.fn(),
  }),
}));

vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({
    createTask: vi.fn(),
    updateTask: vi.fn(),
    fetchRange: vi.fn().mockResolvedValue(undefined),
    deleteTasksBatch: vi.fn(),
    restoreTasksBatch: vi.fn(),
  }),
  refreshTasksPreservingWindow: vi.fn(),
}));

vi.mock("@/hooks/useBatchDelete", () => ({
  useBatchDelete: () => ({ busy: false, softDeleteWithUndo: h.softDeleteWithUndo }),
}));

vi.mock("@/lib/ui-module-registry", () => ({
  useUiModule: () => true,
}));

vi.mock("@/lib/use-media-query", () => ({
  useMediaQuery: () => false,
}));

vi.mock("@/lib/use-local-bool", () => ({
  useLocalBool: () => true,
}));

vi.mock("@/lib/preferences", () => ({
  PREF_DEFAULT_VIEW: "prysm_default_view",
}));

vi.mock("@/stores/preferences-store", () => ({
  usePreferencesStore: (selector?: (s: { prefs: Record<string, unknown> }) => unknown) => {
    const state = { prefs: {} as Record<string, unknown> };
    return selector ? selector(state) : state;
  },
  setPreference: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/timeline/TimelineHeader", () => ({
  TimelineHeader: () => <div />,
}));
vi.mock("@/components/timeline/TimelineGrid", () => ({
  TimelineGrid: () => <div />,
}));
vi.mock("@/components/timeline/TimelineLane", () => ({
  TimelineLane: () => <div />,
}));
vi.mock("@/components/timeline/SectionsPanel", () => ({
  SectionsPanel: () => <div data-testid="sections-panel" />,
}));

vi.mock("@/hooks/useSections", () => ({
  useSections: () => ({
    sections: [],
    loading: false,
    addSection: vi.fn().mockResolvedValue({ id: "s1" }),
    renameSection: vi.fn(),
    removeSection: vi.fn(),
  }),
}));

function renderTimeline(mode: TimelineViewMode = "timeline") {
  return render(
    <ToastProvider>
      <TimelineView viewMode={mode} onViewModeChange={h.onViewModeChange} />
    </ToastProvider>
  );
}

describe("TimelineView selection action bar", () => {
  beforeEach(() => {
    h.selectedTaskIds = [];
    h.clearTaskSelection.mockClear();
    h.softDeleteWithUndo.mockClear();
    // jsdom has no ResizeObserver; the timeline's canvas-fill effect needs it.
    (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it("shows the floating selection bar when tasks are selected on the timeline", () => {
    h.selectedTaskIds = ["t1", "t2"];
    renderTimeline("timeline");
    const bar = screen.getByTestId("selection-action-bar");
    expect(bar).toBeInTheDocument();
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Delete$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Clear$/ })).toBeInTheDocument();
  });

  it("does not render the floating bar when nothing is selected", () => {
    renderTimeline("timeline");
    expect(screen.queryByTestId("selection-action-bar")).not.toBeInTheDocument();
  });
});

describe("TimelineView sections toggle", () => {
  beforeEach(() => {
    h.selectedTaskIds = [];
    (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it("renders the sections panel when the toolbar toggle is on", async () => {
    const user = userEvent.setup();
    renderTimeline("timeline");
    expect(screen.queryByTestId("sections-panel")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("sections-toggle"));
    const panel = screen.getByTestId("sections-panel");
    expect(panel).toBeInTheDocument();
    // Turn the toggle off again -> the panel hides.
    await user.click(screen.getByTestId("sections-toggle"));
    expect(screen.queryByTestId("sections-panel")).not.toBeInTheDocument();
  });

  it("suppresses the native browser menu on blank-canvas right-click", async () => {
    renderTimeline("timeline");
    const body = document.querySelector("[data-timeline-body]") as HTMLElement;
    expect(body).not.toBeNull();
    // Attach a native listener so we can observe whether React's handler called
    // preventDefault() on the underlying event.
    const native = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 });
    // jsdom patched: React 18 uses the native event; observe defaultPrevented
    // by dispatching a manual event through the DOM path the handler registers.
    let defaultPrevented = false;
    const watcher = (e: Event) => {
      if (e.defaultPrevented) defaultPrevented = true;
    };
    document.addEventListener("contextmenu", watcher);
    body.dispatchEvent(native);
    document.removeEventListener("contextmenu", watcher);
    // Blank canvas (no interactive target) must be intercepted by the app.
    expect(defaultPrevented).toBe(true);
  });

  it("keeps the native context menu on interactive elements in the body", async () => {
    renderTimeline("timeline");
    const body = document.querySelector("[data-timeline-body]") as HTMLElement;
    const button = body.querySelector("button") as HTMLElement;
    // If there's no button inside the body (timeline canvas empty), fall back
    // to the Refresh button elsewhere; the filter applies to buttons anywhere.
    const target = button ?? (screen.getByRole("button", { name: /Refresh|sections/i }) as HTMLElement);
    let defaultPrevented = false;
    const watcher = (e: Event) => {
      if (e.defaultPrevented) defaultPrevented = true;
    };
    document.addEventListener("contextmenu", watcher);
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    document.removeEventListener("contextmenu", watcher);
    // Interactive elements return before preventDefault; the native menu stays.
    expect(defaultPrevented).toBe(false);
  });
});