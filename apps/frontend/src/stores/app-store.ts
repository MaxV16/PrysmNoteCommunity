import { create } from "zustand";
import type { Task } from "@/types/task";
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
  tags: Tag[];
  chatMessages: ChatMessage[];
  chatSessions: ChatSession[];
  selectedTaskId: string | null;
  selectedTaskIds: string[];
  selectedTagId: string | null;
  searchQuery: string;
  navFilter: NavFilter;
  setTasks: (tasks: Task[]) => void;
  mergeTasks: (tasks: Task[]) => void;
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
  setSelectedTagId: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  setNavFilter: (filter: NavFilter) => void;
  reset: () => void;
}

const initialState = {
  tasks: [],
  tags: [],
  chatMessages: [],
  chatSessions: [],
  selectedTaskId: null,
  selectedTaskIds: [],
  selectedTagId: null,
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
      const byId = new Map(state.tasks.map((t) => [t.id, t]));
      for (const t of tasks) byId.set(t.id, t);
      return { tasks: Array.from(byId.values()) };
    }),
  setTags: (tags) => set({ tags }),
  addTag: (tag) => set((state) => ({ tags: [...state.tags, tag] })),
  removeTag: (id) => set((state) => ({ tags: state.tags.filter((t) => t.id !== id) })),
  setChatMessages: (msgs) => set({ chatMessages: msgs }),
  addChatMessage: (msg) =>
    set((state) => ({ chatMessages: [...state.chatMessages, msg] })),
  setChatSessions: (sessions) => set({ chatSessions: sessions }),
  setSelectedTaskId: (id) => set({ selectedTaskId: id }),
  setSelectedTaskIds: (ids) => set({ selectedTaskIds: ids }),
  toggleTaskSelected: (id) =>
    set((state) => ({
      selectedTaskIds: state.selectedTaskIds.includes(id)
        ? state.selectedTaskIds.filter((sid) => sid !== id)
        : [...state.selectedTaskIds, id],
    })),
  clearTaskSelection: () => set({ selectedTaskIds: [] }),
  setSelectedTagId: (id) => set({ selectedTagId: id }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setNavFilter: (filter) => set({ navFilter: filter }),
  reset: () => set({ ...initialState }),
}));
