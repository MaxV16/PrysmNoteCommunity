import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { api } from "@/lib/api";
import { useHabits } from "./useHabits";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

const mockHabit = {
  id: "h1",
  title: "Read",
  frequency: "daily",
  target_count: 1,
  color: null,
  streak: 2,
  created_at: "2026-09-01T00:00:00Z",
};

describe("useHabits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it("loads habits on mount", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue([mockHabit]);
    const { result } = renderHook(() => useHabits());
    await waitFor(() => expect(result.current.habits).toHaveLength(1));
    expect(api.get).toHaveBeenCalledWith("/habits");
  });

  it("createHabit posts and appends to the list", async () => {
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue(mockHabit);
    const { result } = renderHook(() => useHabits());
    await act(async () => {
      await result.current.createHabit({ title: "Read", frequency: "daily" });
    });
    expect(api.post).toHaveBeenCalledWith("/habits", { title: "Read", frequency: "daily" });
    expect(result.current.habits).toHaveLength(1);
    expect(result.current.habits[0].title).toBe("Read");
  });

  it("toggleLog posts the log and updates the streak in place", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue([mockHabit]);
    (api.post as ReturnType<typeof vi.fn>).mockResolvedValue({ streak: 3 });
    const { result } = renderHook(() => useHabits());
    await waitFor(() => expect(result.current.habits).toHaveLength(1));
    await act(async () => {
      await result.current.toggleLog("h1");
    });
    expect(api.post).toHaveBeenCalledWith("/habits/h1/log");
    expect(result.current.habits[0].streak).toBe(3);
  });

  it("deleteHabit removes the habit from the list", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue([mockHabit]);
    (api.delete as ReturnType<typeof vi.fn>).mockResolvedValue({});
    const { result } = renderHook(() => useHabits());
    await waitFor(() => expect(result.current.habits).toHaveLength(1));
    await act(async () => {
      await result.current.deleteHabit("h1");
    });
    expect(api.delete).toHaveBeenCalledWith("/habits/h1");
    expect(result.current.habits).toHaveLength(0);
  });

  it("getLogs fetches the log range for a habit", async () => {
    (api.get as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "l1", habit_id: "h1", completed_at: "2026-09-10T00:00:00Z", created_at: "2026-09-10T00:00:00Z" },
    ]);
    const { result } = renderHook(() => useHabits());
    await act(async () => {
      const logs = await result.current.getLogs("h1", "2026-09-01", "2026-09-10");
      expect(logs).toHaveLength(1);
    });
    expect(api.get).toHaveBeenCalledWith("/habits/h1/logs?from=2026-09-01&to=2026-09-10");
  });
});