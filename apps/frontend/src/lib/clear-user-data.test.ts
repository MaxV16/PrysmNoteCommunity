import { describe, it, expect, vi, beforeEach } from "vitest";
import { useAppStore } from "@/stores/app-store";
import { clearUserData } from "./clear-user-data";

describe("clearUserData", () => {
  beforeEach(() => {
    useAppStore.getState().reset();
    vi.restoreAllMocks();
  });

  it("resets the in-memory store to its initial state", () => {
    useAppStore.getState().setTasks([{ id: "1", title: "T", status: "todo" } as any]);
    useAppStore.getState().setChatMessages([{ role: "user", content: "hi" } as any]);
    useAppStore.getState().setNavFilter("today");

    clearUserData();

    const state = useAppStore.getState();
    expect(state.tasks).toEqual([]);
    expect(state.chatMessages).toEqual([]);
    expect(state.navFilter).toBeNull();
  });

  it("clears every per-account localStorage key", () => {
    localStorage.setItem("ai_session_id", "abc");
    localStorage.setItem("prysm_tasks", JSON.stringify([{ id: "1" }]));
    localStorage.setItem("prysm_key_openai", "sk-123");
    localStorage.setItem("prysm_habits", "[]");
    localStorage.setItem("prysm_last_provider", "openai");
    localStorage.setItem("prysm_ai_chat_history", "[]");
    localStorage.setItem("prysm_ai_active_chat", "[]");

    clearUserData();

    expect(localStorage.getItem("ai_session_id")).toBeNull();
    expect(localStorage.getItem("prysm_tasks")).toBeNull();
    expect(localStorage.getItem("prysm_key_openai")).toBeNull();
    expect(localStorage.getItem("prysm_habits")).toBeNull();
    expect(localStorage.getItem("prysm_last_provider")).toBeNull();
    expect(localStorage.getItem("prysm_ai_chat_history")).toBeNull();
    expect(localStorage.getItem("prysm_ai_active_chat")).toBeNull();
  });
});
