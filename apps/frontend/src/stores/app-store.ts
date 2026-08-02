import { create } from "zustand";
import type { Task } from "@/types/task";
import type { ChatMessage } from "@/types/ai";

interface Tag {
  id: string;
  name: string;
  color: string | null;
}

export type NavFilter = "inbox" | "today" | "next7" | null;

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
  selectedTagId: string | null;
  searchQuery: string;
  navFilter: NavFilter;
  setTasks: (tasks: Task[]) => void;
  setTags: (tags: Tag[]) => void;
  addTag: (tag: Tag) => void;
  removeTag: (id: string) => void;
  setChatMessages: (msgs: ChatMessage[]) => void;
  addChatMessage: (msg: ChatMessage) => void;
  setChatSessions: (sessions: ChatSession[]) => void;
  setSelectedTaskId: (id: string | null) => void;
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
  selectedTagId: null,
  searchQuery: "",
  navFilter: null,
};

export const useAppStore = create<AppState>((set, get) => ({
  ...initialState,
  setTasks: (tasks) => set({ tasks }),
  setTags: (tags) => set({ tags }),
  addTag: (tag) => set((state) => ({ tags: [...state.tags, tag] })),
  removeTag: (id) => set((state) => ({ tags: state.tags.filter((t) => t.id !== id) })),
  setChatMessages: (msgs) => set({ chatMessages: msgs }),
  addChatMessage: (msg) =>
    set((state) => ({ chatMessages: [...state.chatMessages, msg] })),
  setChatSessions: (sessions) => set({ chatSessions: sessions }),
  setSelectedTaskId: (id) => set({ selectedTaskId: id }),
  setSelectedTagId: (id) => set({ selectedTagId: id }),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setNavFilter: (filter) => set({ navFilter: filter }),
  reset: () => set({ ...initialState }),
}));
