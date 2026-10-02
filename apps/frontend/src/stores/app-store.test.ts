import { describe, it, expect } from "vitest";
import { useAppStore } from "@/stores/app-store";

describe("app-store", () => {
  it("starts with empty tasks", () => {
    const { tasks } = useAppStore.getState();
    expect(tasks).toEqual([]);
  });

  it("starts with empty chat messages", () => {
    const { chatMessages } = useAppStore.getState();
    expect(chatMessages).toEqual([]);
  });

  it("starts with no selection", () => {
    const state = useAppStore.getState();
    expect(state.selectedTaskId).toBeNull();
    expect(state.searchQuery).toBe("");
    expect(state.navFilter).toBeNull();
  });

  it("setTasks updates tasks", () => {
    const tasks = [{ id: "1", title: "Test", status: "todo" }] as any;
    useAppStore.getState().setTasks(tasks);
    expect(useAppStore.getState().tasks).toEqual(tasks);
    // Reset
    useAppStore.getState().setTasks([]);
  });

  it("mergeTasks unions by id with the newest copy winning", () => {
    const a = { id: "1", title: "A", status: "todo" } as any;
    const b = { id: "2", title: "B", status: "todo" } as any;
    const a2 = { id: "1", title: "A updated", status: "done" } as any;
    useAppStore.getState().setTasks([a]);
    useAppStore.getState().mergeTasks([b, a2]);
    const { tasks } = useAppStore.getState();
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.id === "1")).toEqual(a2);
    expect(tasks.find((t) => t.id === "2")).toEqual(b);
    useAppStore.getState().setTasks([]);
  });

  it("mergeTasks preserves far-window tasks not in the new batch", () => {
    const far = { id: "far", title: "Far", status: "todo" } as any;
    const near = { id: "near", title: "Near", status: "todo" } as any;
    useAppStore.getState().setTasks([far]);
    useAppStore.getState().mergeTasks([near]);
    const ids = useAppStore.getState().tasks.map((t) => t.id);
    expect(ids).toContain("far");
    expect(ids).toContain("near");
    useAppStore.getState().setTasks([]);
  });

  it("mergeTasks is idempotent (re-applying a change never duplicates a row)", () => {
    const task = { id: "dup", title: "Once", status: "todo", updated_at: "2026-01-01T00:00:00Z" } as any;
    useAppStore.getState().setTasks([]);
    useAppStore.getState().mergeTasks([task]);
    useAppStore.getState().mergeTasks([task]);
    useAppStore.getState().mergeTasks([task]);
    expect(useAppStore.getState().tasks.filter((t) => t.id === "dup")).toHaveLength(1);
    useAppStore.getState().setTasks([]);
  });

  it("mergeTasks reconciles an optimistic write with the newer server copy", () => {
    const optimistic = { id: "opt", title: "Draft", status: "todo" } as any;
    const server = { id: "opt", title: "Draft", status: "done", updated_at: "2026-02-02T00:00:00Z" } as any;
    useAppStore.getState().setTasks([optimistic]);
    useAppStore.getState().mergeTasks([server]);
    const rows = useAppStore.getState().tasks.filter((t) => t.id === "opt");
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("done");
    useAppStore.getState().setTasks([]);
  });

  it("setTags updates tags", () => {
    const tags = [{ id: "1", name: "urgent", color: "#ff0000" }];
    useAppStore.getState().setTags(tags);
    expect(useAppStore.getState().tags).toEqual(tags);
    useAppStore.getState().setTags([]);
  });

  it("addTag appends a tag", () => {
    const tag = { id: "2", name: "bug", color: null };
    useAppStore.getState().addTag(tag);
    const { tags } = useAppStore.getState();
    expect(tags).toContainEqual(tag);
    useAppStore.getState().removeTag("2");
  });

  it("removeTag removes a tag", () => {
    useAppStore.getState().setTags([{ id: "3", name: "test", color: null }]);
    useAppStore.getState().removeTag("3");
    expect(useAppStore.getState().tags).toEqual([]);
  });

  it("addChatMessage appends to chat", () => {
    const msg = { role: "user", content: "hello" } as any;
    useAppStore.getState().addChatMessage(msg);
    const { chatMessages } = useAppStore.getState();
    expect(chatMessages).toContainEqual(msg);
    useAppStore.getState().setChatMessages([]);
  });

  it("setChatMessages replaces messages", () => {
    const msgs = [{ role: "assistant", content: "hi" }] as any;
    useAppStore.getState().setChatMessages(msgs);
    expect(useAppStore.getState().chatMessages).toEqual(msgs);
    useAppStore.getState().setChatMessages([]);
  });

  it("setSelectedTaskId updates selection", () => {
    useAppStore.getState().setSelectedTaskId("task-1");
    expect(useAppStore.getState().selectedTaskId).toBe("task-1");
    useAppStore.getState().setSelectedTaskId(null);
  });

  it("toggles multi-selection without opening the drawer selection", () => {
    const store = useAppStore.getState();
    store.toggleTaskSelected("task-1");
    store.toggleTaskSelected("task-2");
    store.toggleTaskSelected("task-1");
    expect(useAppStore.getState().selectedTaskIds).toEqual(["task-2"]);
    expect(useAppStore.getState().selectedTaskId).toBeNull();
    useAppStore.getState().clearTaskSelection();
    expect(useAppStore.getState().selectedTaskIds).toEqual([]);
  });

  it("setSelectedTaskIds replaces the selection", () => {
    useAppStore.getState().setSelectedTaskIds(["a", "b", "c"]);
    expect(useAppStore.getState().selectedTaskIds).toEqual(["a", "b", "c"]);
    useAppStore.getState().clearTaskSelection();
  });

  it("setSearchQuery updates query", () => {
    useAppStore.getState().setSearchQuery("groceries");
    expect(useAppStore.getState().searchQuery).toBe("groceries");
    useAppStore.getState().setSearchQuery("");
  });

  it("setNavFilter updates filter", () => {
    useAppStore.getState().setNavFilter("today");
    expect(useAppStore.getState().navFilter).toBe("today");
    useAppStore.getState().setNavFilter(null);
  });

  it("reset restores every field to its initial value", () => {
    useAppStore.getState().setTasks([{ id: "1", title: "T", status: "todo" } as any]);
    useAppStore.getState().setTags([{ id: "1", name: "urgent", color: null }]);
    useAppStore.getState().setChatMessages([{ role: "user", content: "hi" } as any]);
    useAppStore.getState().setChatSessions([{ id: "s1", title: "Chat", messages: [], timestamp: "" }]);
    useAppStore.getState().setSelectedTaskId("task-1");
    useAppStore.getState().toggleTaskSelected("task-2");
    useAppStore.getState().setSelectedTagId("tag-1");
    useAppStore.getState().setSearchQuery("groceries");
    useAppStore.getState().setNavFilter("today");

    useAppStore.getState().reset();

    const state = useAppStore.getState();
    expect(state.tasks).toEqual([]);
    expect(state.tags).toEqual([]);
    expect(state.chatMessages).toEqual([]);
    expect(state.chatSessions).toEqual([]);
    expect(state.selectedTaskId).toBeNull();
    expect(state.selectedTaskIds).toEqual([]);
    expect(state.selectedTagId).toBeNull();
    expect(state.searchQuery).toBe("");
    expect(state.navFilter).toBeNull();
  });
});
