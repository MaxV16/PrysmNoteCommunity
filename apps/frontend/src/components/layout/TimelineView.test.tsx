import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
    days: Array.from({ length: 20 }, (_, i) => {
      const d = new Date(h.start);
      d.setDate(d.getDate() + i);
      return d;
    }),
    sliceStart: 0,
    moveSlice: vi.fn(),
    today: new Date(h.start),
  }),
}));

vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({
    createTask: vi.fn(),
    updateTask: vi.fn(),
    fetchRange: vi.fn().mockResolvedValue(undefined),
    fetchTasks: vi.fn().mockResolvedValue(undefined),
    deleteTasksBatch: vi.fn(),
    restoreTasksBatch: vi.fn(),
  }),
  refreshTasksPreservingWindow: vi.fn(),
}));

vi.mock("@/hooks/useBoardSections", () => ({
  useBoardSections: () => ({
    sections: [],
    loading: false,
    addSection: vi.fn(),
    renameSection: vi.fn(),
    removeSection: vi.fn(),
    moveSection: vi.fn(),  }),
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

function renderTimeline(mode: TimelineViewMode = "timeline") {
  return render(
    <ToastProvider>
      <TimelineView viewMode={mode} onViewModeChange={h.onViewModeChange} />
    </ToastProvider>
  );
}

// Capturing ResizeObserver so a test can simulate a width-only change (the AI
// dock/sidebar toggling) without a window resize or a scroll.
const resizeObservers: { targets: Element[]; trigger: () => void }[] = [];

function installResizeObserverMock() {
  resizeObservers.length = 0;
  (globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    private cb: ResizeObserverCallback;
    targets: Element[] = [];
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      resizeObservers.push(this);
    }
    observe(target: Element) {
      this.targets.push(target);
    }
    unobserve() {}
    disconnect() {}
    trigger() {
      this.cb([], this as unknown as ResizeObserver);
    }
  };
}

let mockClientWidth = 0;
let mockScrollWidth = 0;
function installLayoutMetrics() {
  mockClientWidth = 0;
  mockScrollWidth = 0;
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return mockClientWidth;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return mockScrollWidth;
    },
  });
}

describe("TimelineView selection action bar", () => {
  beforeEach(() => {
    h.selectedTaskIds = [];
    h.clearTaskSelection.mockClear();
    h.softDeleteWithUndo.mockClear();    window.localStorage.clear();
    // jsdom has no ResizeObserver; the timeline's canvas-fill effect needs it.
    installResizeObserverMock();
    installLayoutMetrics();
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

  it("suppresses the native browser menu on blank-canvas right-click", async () => {
    renderTimeline("timeline");
    const body = document.querySelector("[data-timeline-body]") as HTMLElement;
    expect(body).not.toBeNull();
    const native = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 50, clientY: 50 });
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
    const target = button ?? (screen.getByRole("button", { name: /New/i }) as HTMLElement);
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

  it("keeps the month label on a width-only resize (AI dock toggle)", () => {
    // Center today (Sep 15) so a 1000px viewport covers Sep 11 to Sep 19 and the
    // label reads September 2026. A width-only resize must not rewrite that
    // label, even though the wider viewport's trailing edge would reach October.
    h.start = new Date(2026, 8, 15);
    mockClientWidth = 1000;
    mockScrollWidth = 5_000_000;
    renderTimeline("timeline");

    expect(screen.getByText("September 2026")).toBeInTheDocument();

    // Grow the canvas width only (the dock closing). No scroll happens.
    mockClientWidth = 3000;
    resizeObservers.forEach((ro) => ro.trigger());

    expect(screen.getByText("September 2026")).toBeInTheDocument();
    expect(screen.queryByText("October 2026")).not.toBeInTheDocument();
  });
});