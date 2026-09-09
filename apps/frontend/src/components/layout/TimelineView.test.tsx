import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
vi.mock("@/components/timeline/TimelineSectionsLayer", () => ({
  TimelineSectionsLayer: () => <div data-testid="timeline-sections-layer" />,
  SECTION_DROPPABLE_PREFIX: "section:",
}));

vi.mock("@/hooks/useTimelineSections", () => ({
  useTimelineSections: () => ({
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

  it("renders the sections layer when the toolbar toggle is on", async () => {
    const user = userEvent.setup();
    renderTimeline("timeline");
    expect(screen.queryByTestId("timeline-sections-layer")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("sections-toggle"));
    // The dropdown opens; click the Show sections option.
    const show = await screen.findByText("Show sections");
    await user.click(show);
    expect(screen.getByTestId("timeline-sections-layer")).toBeInTheDocument();
  });
});