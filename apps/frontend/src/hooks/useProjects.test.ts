import { describe, it, expect, vi, beforeEach } from "vitest";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import { renderHook, act } from "@testing-library/react";
import { useProjects } from "./useProjects";

vi.mock("@/lib/api", () => ({
  api: {
    delete: vi.fn(),
  },
}));

describe("useProjects", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.getState().setProjects([]);
  });

  it("deleteProject calls DELETE /projects/{id}", async () => {
    vi.mocked(api.delete).mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useProjects());
    await act(async () => {
      await result.current.deleteProject("proj-1");
    });

    expect(vi.mocked(api.delete)).toHaveBeenCalledWith("/projects/proj-1");
  });

  it("deleteProject removes from store before API call and keeps removed on success", async () => {
    vi.mocked(api.delete).mockResolvedValueOnce(undefined);
    useAppStore.getState().setProjects([
      { id: "proj-1", name: "Work" } as any,
      { id: "proj-2", name: "Personal" } as any,
    ]);

    const { result } = renderHook(() => useProjects());
    await act(async () => {
      await result.current.deleteProject("proj-1");
    });

    expect(useAppStore.getState().projects).toHaveLength(1);
    expect(useAppStore.getState().projects[0].id).toBe("proj-2");
  });

  it("deleteProject keeps item removed even when API call fails", async () => {
    vi.mocked(api.delete).mockRejectedValueOnce(new Error("Network error"));
    useAppStore.getState().setProjects([
      { id: "proj-1", name: "Work" } as any,
    ]);

    const { result } = renderHook(() => useProjects());
    await act(async () => {
      await result.current.deleteProject("proj-1");
    });

    const remaining = useAppStore.getState().projects;
    expect(remaining).toHaveLength(0);
    expect(vi.mocked(api.delete)).toHaveBeenCalledWith("/projects/proj-1");
  });
});
