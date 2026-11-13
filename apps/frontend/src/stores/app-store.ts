import { create } from "zustand";
import type { Task, TaskList } from "@/types/task";
import type { ChatMessage } from "@/types/ai";

interface Tag {
  id: string;
  name: string;
  color: string | null;
}

export type NavFilter = "inbox" | "today" | "next7" | "all" | "completed" | null;

interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  timestamp: string;
}

interface AppState {
  tasks: Task[];
  lists: TaskList[];
  activeListId: string | null;
  tags: Tag[];
  chatMessages: ChatMessage[];
  chatSessions: ChatSession[];
  selectedTaskId: string | null;
  selectedTaskIds: string[];
  selectedTagId: string | null;
  /** Task whose touch long-press action bar is open (mobile/coarse pointers). */
  mobileActionTaskId: string | null;
  searchQuery: string;
  navFilter: NavFilter;
  setTasks: (tasks: Task[]) => void;
  mergeTasks: (tasks: Task[]) => void;
  setLists: (lists: TaskList[]) => void;
  setActiveListId: (id: string | null) => void;
  setTags: (tags: Tag[]) => void;
  addTag: (tag: Tag) => void;
  removeTag: (id: string) => void;
  setChatMessages: (msgs: ChatMessage[]) => void;
  addChatMessage: (msg: ChatMessage) => void;
  setChatSessions: (sessions: ChatSession[]) => void;
  setSelectedTaskId: (id: string | null) => void;
  setSelectedTaskIds: (ids: string[]) => void;
  toggleTaskSelected: (id: string) => void;
  clearTaskSelection: () => void;
  setMobileActionTaskId: (id: string | null) => void;
  setSelectedTagId: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  setNavFilter: (filter: NavFilter) => void;
  reset: () => void;
}

const initialState = {
  tasks: [],
  lists: [],
  activeListId: null,
  tags: [],
  chatMessages: [],
  chatSessions: [],
  selectedTaskId: null,
  selectedTaskIds: [],
  selectedTagId: null,
  mobileActionTaskId: null,
  searchQuery: "",
  navFilter: null,
};

export const useAppStore = create<AppState>((set, get) => ({
  ...initialState,
  setTasks: (tasks) => set({ tasks }),
  mergeTasks: (tasks) =>
    set((state) => {
      // Union by id, newest copy wins. Far-window tasks from a previous lazy
      // range fetch survive a later near-window refresh (no data loss).
      if (tasks.length === 0) return state;
      const byId = new Map(state.tasks.map((t) => [t.id, t]));
      let changed = false;
      for (const t of tasks) {
        // Identity comparison: a PATCH response or a sync page that carries
        // objects the store already holds must not allocate a new tasks array.
        // Allocating one re-renders every lane and bar for no visible change,
        // which is what made unchanged refreshes feel heavy.
        if (byId.get(t.id) !== t) {
          byId.set(t.id, t);
          changed = true;
        }
      }
      if (!changed) return state;
      return { tasks: Array.from(byId.values()) };
    }),
  setLists: (lists) => set({ lists }),
  setActiveListId: (id) => set({ activeListId: id }),
  setTags: (tags) => set({ tags }),
  addTag: (tag) => set((state) => ({ tags: [...state.tags, tag] })),
  removeTag: (id) => set((state) => ({ tags: state.tags.filter((t) => t.id !== id) })),
  setChatMessages: (msgs) => set({ chatMessages: msgs }),
  addChatMessage: (msg) =>
    set((state) => ({ chatMessages: [...state.chatMessages, msg] })),
  setChatSessions: (sessions) => set({ chatSessions: sessions }),
  setSelectedTaskId: (id) => set({ selectedTaskId: id }),
  setSelectedTaskIds: (ids) =>
    set((state) => (state.selectedTaskIds === ids ? state : { selectedTaskIds: ids })),
  toggleTaskSelected: (id) =>
    set((state) => ({
      selectedTaskIds: state.selectedTaskIds.includes(id)
        ? state.selectedTaskIds.filter((sid) => sid !== id)
        : [...state.selectedTaskIds, id],
    })),
  // No-op when nothing is selected. Every canvas press and bar click calls this,
  // and allocating a fresh `[]` made every lane that subscribes to the array
  // re-render on each click, which read as input lag.
  clearTaskSelection: () =>
    set((state) => (state.selectedTaskIds.length === 0 ? state : { selectedTaskIds: [] })),

  setMobileActionTaskId: (id) => set({ mobileActionTaskId: id }),
  setSelectedTagId: (id) => set({ selectedTagId: id }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setNavFilter: (filter) => set({ navFilter: filter }),
  reset: () => set({ ...initialState }),
}));
