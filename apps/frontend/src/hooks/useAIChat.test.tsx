import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAIChat } from "./useAIChat";
import { useAppStore } from "@/stores/app-store";

// Mock the API client so refreshTasksFromServer can be observed without hitting
// a real server. vi.hoisted keeps the reference accessible in the hoisted mock.
const { apiGet } = vi.hoisted(() => ({
  apiGet: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/api", () => ({
  api: { get: apiGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

function streamResponse(errorOnRead: boolean) {
  const encoder = new TextEncoder();
  const chunks = [encoder.encode('event: token\ndata: "hi"\n\n')];
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(chunks[i++]);
      if (errorOnRead) {
        // Simulate an aborted/errored stream after first data.
        controller.error(new Error("boom"));
      }
    },
  });
  return new Response(body, { status: 200 });
}

describe("useAIChat refresh-on-abort", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.getState().reset();
    // A stored session id would make the hook resume that conversation on
    // mount (extra fetch against the shared stream mock) - start each test
    // with a clean local session, like a fresh visitor.
    localStorage.clear();
  });

  it("refreshes tasks from the server even when the stream errors", async () => {
    global.fetch = vi.fn().mockResolvedValue(streamResponse(true));
    apiGet.mockResolvedValue([{ id: "1", title: "T1", status: "todo" }]);

    const { result } = renderHook(() => useAIChat());
    await act(async () => {
      await result.current.sendMessage("create a task");
    });

    // Even though the reader errored mid-stream, the timeline refresh must run.
    expect(apiGet).toHaveBeenCalledWith("/tasks/");
  });

  it("removes the empty assistant placeholder when the stream is aborted", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new DOMException("aborted", "AbortError"));
      },
    });
    global.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));

    const { result } = renderHook(() => useAIChat());
    await act(async () => {
      await result.current.sendMessage("hello");
    });

    const store = useAppStore.getState();
    expect(
      store.chatMessages.some((m) => m.role === "assistant" && !m.content)
    ).toBe(false);
  });

  it("preserves far-window tasks loaded by a range fetch across a chat refresh", async () => {
    const { useTasks } = await import("@/hooks/useTasks");
    global.fetch = vi.fn().mockResolvedValue(streamResponse(true));
    apiGet.mockImplementation(async (path: string) => {
      if (String(path).includes("date_from")) {
        return [{ id: "far", title: "Far", status: "todo", start_date: "2026-01-01", due_date: "2026-01-01" }];
      }
      return [{ id: "near", title: "Near", status: "todo" }];
    });

    // Load the lazy far window through the tasks hook so the module-level
    // loadedRangeRef is set for the later chat refresh.
    const { result: tasksHook } = renderHook(() => useTasks());
    await act(async () => {
      await tasksHook.current.fetchRange("2026-01-01", "2026-01-07");
    });

    const { result } = renderHook(() => useAIChat());
    // The refresh's /tasks/ snapshot has NO far task; a merge must keep it.
    await act(async () => {
      await result.current.sendMessage("create a task");
    });

    const ids = useAppStore.getState().tasks.map((t) => t.id);
    expect(ids).toContain("far");
    expect(ids).toContain("near");
  });
});
