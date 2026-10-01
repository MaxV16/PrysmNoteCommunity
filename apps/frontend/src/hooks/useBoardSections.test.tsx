import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useBoardSections } from "./useBoardSections";
import { FOREGROUND_REFRESH_EVENT } from "./useForegroundRefresh";
import type { BoardSection } from "@/lib/board-sections";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api }));

const lib = vi.hoisted(() => ({
  fetchSections: vi.fn(),
  createSection: vi.fn(),
  updateSection: vi.fn(),
  deleteSection: vi.fn(),
}));

vi.mock("@/lib/board-sections", () => ({
  fetchSections: lib.fetchSections,
  createSection: lib.createSection,
  updateSection: lib.updateSection,
  deleteSection: lib.deleteSection,
}));

function wrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function makeSection(id: string, overrides: Partial<BoardSection> = {}): BoardSection {
  return {
    id,
    kind: "board",
    list_id: null,
    title: id,
    color: "#000000",
    status: null,
    position: 0,
    ...overrides,
  };
}

describe("useBoardSections", () => {
  beforeEach(() => {
    localStorage.clear();
    lib.fetchSections.mockReset();
    lib.createSection.mockReset();
    lib.updateSection.mockReset();
    lib.deleteSection.mockReset();
    lib.fetchSections.mockResolvedValue([]);
  });

  it("loads sections on mount", async () => {
    lib.fetchSections.mockResolvedValue([makeSection("s1"), makeSection("s2")]);
    const { result } = renderHook(() => useBoardSections("board"), { wrapper });
    await waitFor(() => expect(result.current.sections).toHaveLength(2));
    expect(lib.fetchSections).toHaveBeenCalledWith("board", null);
  });

  it("addSection appends and sorts by position", async () => {
    lib.fetchSections.mockResolvedValue([makeSection("s1", { position: 0 })]);
    lib.createSection.mockResolvedValue(makeSection("s2", { position: 1 }));
    const { result } = renderHook(() => useBoardSections("board"), { wrapper });
    await waitFor(() => expect(result.current.sections).toHaveLength(1));
    await result.current.addSection({ title: "New" });
    expect(lib.createSection).toHaveBeenCalledWith({ kind: "board", list_id: null, title: "New" });
    await waitFor(() => expect(result.current.sections.map((s) => s.id)).toEqual(["s1", "s2"]));
  });

  it("renameSection and removeSection reconcile with the server", async () => {
    let server: BoardSection[] = [makeSection("s1", { title: "Old" })];
    lib.fetchSections.mockImplementation(async () => server);
    lib.updateSection.mockImplementation(async (id: string, patch: Partial<BoardSection>) => {
      server = server.map((s) => (s.id === id ? { ...s, ...patch } : s));
      return server.find((s) => s.id === id)!;
    });
    lib.deleteSection.mockImplementation(async (id: string) => {
      server = server.filter((s) => s.id !== id);
    });

    const { result } = renderHook(() => useBoardSections("board"), { wrapper });
    await waitFor(() => expect(result.current.sections).toHaveLength(1));

    await result.current.renameSection("s1", "New");
    await waitFor(() => expect(result.current.sections[0].title).toBe("New"));

    await result.current.removeSection("s1");
    // The hook re-reads the server list, so a second device's stale order can
    // never resurrect the deleted section.
    await waitFor(() => expect(result.current.sections).toHaveLength(0));
  });

  it("reloads sections on the foreground refresh event", async () => {
    lib.fetchSections.mockResolvedValue([makeSection("s1")]);
    const { result } = renderHook(() => useBoardSections("board"), { wrapper });
    await waitFor(() => expect(result.current.sections).toHaveLength(1));
    const callsAfterMount = lib.fetchSections.mock.calls.length;

    lib.fetchSections.mockResolvedValue([makeSection("s1"), makeSection("s2")]);
    act(() => {
      window.dispatchEvent(new Event(FOREGROUND_REFRESH_EVENT));
    });

    await waitFor(() => expect(result.current.sections).toHaveLength(2));
    expect(lib.fetchSections.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("migrates legacy prysm_kanban_columns into server sections once", async () => {
    localStorage.setItem(
      "prysm_kanban_columns",
      JSON.stringify([
        { id: "col_1", title: "Backlog", color: "#9E9E9E", status: "backlog" },
        { id: "col_2", title: "To Do", color: "#4FC3F7", status: "todo" },
      ])
    );
    lib.createSection.mockResolvedValue(makeSection("x", { kind: "kanban" }));
    lib.fetchSections.mockResolvedValue([]);

    renderHook(() => useBoardSections("kanban"), { wrapper });
    await waitFor(() => expect(lib.createSection).toHaveBeenCalledTimes(2));
    expect(lib.createSection).toHaveBeenCalledWith({
      kind: "kanban",
      title: "Backlog",
      color: "#9E9E9E",
      status: "backlog",
    });
    expect(localStorage.getItem("prysm_kanban_columns")).toBeNull();
    expect(localStorage.getItem("prysm_kanban_columns_migrated")).toBe("1");
  });

  it("does not re-run the migration once flagged", async () => {
    localStorage.setItem("prysm_kanban_columns_migrated", "1");
    localStorage.setItem("prysm_kanban_columns", JSON.stringify([{ id: "x", title: "T", color: "#000", status: "todo" }]));
    lib.fetchSections.mockResolvedValue([]);

    renderHook(() => useBoardSections("kanban"), { wrapper });
    await waitFor(() => expect(lib.fetchSections).toHaveBeenCalled());
    expect(lib.createSection).not.toHaveBeenCalled();
  });
});
