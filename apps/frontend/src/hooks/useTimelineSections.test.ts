import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { api } from "@/lib/api";
import { useTimelineSections } from "./useTimelineSections";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const mockSection = {
  id: "s1",
  name: "Focus",
  color: null,
  start_pct: 50,
  end_pct: 100,
  rule_kind: null,
  rule_value: null,
  position: 0,
};

describe("useTimelineSections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it("loads sections once on mount", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue([mockSection]);
    const { result } = renderHook(() => useTimelineSections());
    await waitFor(() => expect(result.current.sections).toHaveLength(1));
    expect(api.get).toHaveBeenCalledWith("/timeline-sections/");
  });

  it("addSection posts and appends to the store", async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue(mockSection);
    const { result } = renderHook(() => useTimelineSections());
    await act(async () => {
      await result.current.addSection({ name: "Focus" });
    });
    expect(api.post).toHaveBeenCalledWith("/timeline-sections/", { name: "Focus" });
    expect(result.current.sections).toHaveLength(1);
  });

  it("renameSection patches optimistically and rolls back on failure", async () => {
    (api.patch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("nope"));
    const { result } = renderHook(() => useTimelineSections());
    await act(async () => {
      await result.current.renameSection("s1", { name: "Deep Work" });
    });
    expect(api.patch).toHaveBeenCalledWith("/timeline-sections/s1", { name: "Deep Work" });
    expect(result.current.sections.find((s) => s.id === "s1")?.name).toBeUndefined();
  });

  it("removeSection deletes and drops it locally", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue([mockSection]);
    (api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ status: "deleted" });
    const { result } = renderHook(() => useTimelineSections());
    await waitFor(() => expect(result.current.sections).toHaveLength(1));
    await act(async () => {
      await result.current.removeSection("s1");
    });
    expect(api.delete).toHaveBeenCalledWith("/timeline-sections/s1");
    expect(result.current.sections).toHaveLength(0);
  });
});