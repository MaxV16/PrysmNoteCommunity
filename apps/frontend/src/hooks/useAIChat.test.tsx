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
});
