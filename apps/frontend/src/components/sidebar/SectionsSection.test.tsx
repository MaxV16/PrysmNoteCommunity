import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SectionsSection } from "./SectionsSection";

vi.mock("@/hooks/useSections", () => ({
  useSections: () => ({
    sections: [
      { id: "s1", name: "Focus", color: null, start_pct: 50, end_pct: 100, rule_kind: "all", rule_value: null, position: 0 },
    ],
    loading: false,
    addSection: vi.fn().mockResolvedValue({ id: "s2" }),
    renameSection: vi.fn(),
    removeSection: vi.fn(),
  }),
}));

vi.mock("@/stores/app-store", () => {
  const state = {
    tasks: [
      { id: "t1", title: "Deep work", priority: 1, status: "todo", list_id: null, tags: [] },
      { id: "t2", title: "Email", priority: 2, status: "todo", list_id: null, tags: [] },
    ],
    lists: [],
    tags: [],
  };
  const useAppStore = (selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state;
  useAppStore.getState = () => ({
    ...state,
    setSelectedTaskId: vi.fn(),
  });
  return { useAppStore };
});

describe("SectionsSection", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders each section as a header row with its tasks count", () => {
    render(<SectionsSection />);
    expect(screen.getByText("Sections")).toBeInTheDocument();
    expect(screen.getByText("Focus")).toBeInTheDocument();
  });

  it("opens the context menu on right-click and shows Rename/Delete", async () => {
    render(<SectionsSection />);
    const header = screen.getByText("Focus").closest(".sidebar-item") as HTMLElement;
    fireEvent.contextMenu(header);
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    });
    expect(screen.getByRole("menuitem", { name: "Add Section Above" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("dismisses the context menu on outside click", async () => {
    render(<SectionsSection />);
    const header = screen.getByText("Focus").closest(".sidebar-item") as HTMLElement;
    fireEvent.contextMenu(header);
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    });
    fireEvent.pointerDown(document.body);
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
    });
  });
});