import { create } from "zustand";
import type { Task } from "@/types/task";
import type { Project } from "@/types/project";
import type { ChatMessage } from "@/types/ai";

interface Tag {
  id: string;
  name: string;
  color: string | null;
}

export type NavFilter = "inbox" | "today" | "next7" | null;

interface AppState {
  tasks: Task[];
  projects: Project[];
  tags: Tag[];
  chatMessages: ChatMessage[];
  selectedTaskId: string | null;
  selectedProjectId: string | null;
  selectedTagId: string | null;
  searchQuery: string;
  navFilter: NavFilter;
  setTasks: (tasks: Task[]) => void;
  setProjects: (projects: Project[]) => void;
  setTags: (tags: Tag[]) => void;
  addTag: (tag: Tag) => void;
  removeTag: (id: string) => void;
  setChatMessages: (msgs: ChatMessage[]) => void;
  addChatMessage: (msg: ChatMessage) => void;
  setSelectedTaskId: (id: string | null) => void;
  setSelectedProjectId: (id: string | null) => void;
  setSelectedTagId: (id: string | null) => void;
  removeProject: (id: string) => void;
  setSearchQuery: (query: string) => void;
  setNavFilter: (filter: NavFilter) => void;
}

export const useAppStore = create<AppState>((set) => ({
  tasks: [],
  projects: [],
  tags: [],
  chatMessages: [],
  selectedTaskId: null,
  selectedProjectId: null,
  selectedTagId: null,
  searchQuery: "",
  navFilter: null,
  setTasks: (tasks) => set({ tasks }),
  setProjects: (projects) => set({ projects }),
  setTags: (tags) => set({ tags }),
  addTag: (tag) => set((state) => ({ tags: [...state.tags, tag] })),
  removeTag: (id) => set((state) => ({ tags: state.tags.filter((t) => t.id !== id) })),
  setChatMessages: (msgs) => set({ chatMessages: msgs }),
  addChatMessage: (msg) =>
    set((state) => ({ chatMessages: [...state.chatMessages, msg] })),
  setSelectedTaskId: (id) => set({ selectedTaskId: id }),
  setSelectedProjectId: (id) => set({ selectedProjectId: id }),
  setSelectedTagId: (id) => set({ selectedTagId: id }),
  removeProject: (id) => set((state) => ({ projects: state.projects.filter((p) => p.id !== id) })),
  setSearchQuery: (query) => set({ searchQuery: query }),
  setNavFilter: (filter) => set({ navFilter: filter }),
}));
