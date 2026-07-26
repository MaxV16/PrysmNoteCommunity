"use client";

import React, { useState, useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { SidebarLeft } from "@/components/sidebar/SidebarLeft";
import { TimelineView } from "@/components/layout/TimelineView";
import { ChatPanel } from "@/components/ai/ChatPanel";
import { Spinner } from "@/components/ui/Spinner";
import { useTasks } from "@/hooks/useTasks";
import { useProjects } from "@/hooks/useProjects";
import { useTags } from "@/hooks/useTags";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/lib/theme-context";
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { StickyBoardProvider, useStickyBoard } from "@/components/sticky/StickyNoteBoard";
import { HabitTracker } from "@/components/habits/HabitTracker";
import { HabitForm } from "@/components/habits/HabitForm";

class ErrorBoundaryInner extends React.Component<
  { children: ReactNode; fallback?: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; fallback?: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="flex h-full items-center justify-center bg-base p-8 text-center text-sm text-danger">
            <div className="flex flex-col items-center gap-3">
              <span className="text-4xl">⚠️</span>
              <p>Something went wrong. Please refresh the page.</p>
              <button
                onClick={() => window.location.reload()}
                className="btn bg-accent px-4 py-2 text-base text-base hover:bg-accent-hover"
              >
                Refresh
              </button>
            </div>
          </div>
        )
      );
    }
    return this.props.children;
  }
}

export function ThreePaneLayout() {
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isTablet, setIsTablet] = useState(false);
  const [kanbanMode, setKanbanMode] = useState(false);
  const [habitsOpen, setHabitsOpen] = useState(false);
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const { open: openSticky } = useStickyBoard();
  const { fetchTasks } = useTasks();
  const { fetchProjects } = useProjects();
  const { fetchTags } = useTags();
  const { user } = useAuth();
  const { toggleTheme } = useTheme();
  const router = useRouter();

  useEffect(() => {
    const check = () => {
      const w = window.innerWidth;
      setIsMobile(w < 768);
      setIsTablet(w >= 768 && w < 1024);
      if (w < 1024) setLeftCollapsed(true);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>("[data-search-input]");
        input?.focus();
        if (leftCollapsed && document.querySelector<HTMLInputElement>("[data-search-input]")) {
          setLeftCollapsed(false);
          setTimeout(() => input?.focus(), 100);
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        setNewTaskOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "b") {
        e.preventDefault();
        setLeftCollapsed(!leftCollapsed);
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "J") {
        e.preventDefault();
        setRightOpen(v => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "T") {
        e.preventDefault();
        toggleTheme();
      }
      if (e.key === "Escape") {
        setNewTaskOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [leftCollapsed, toggleTheme]);

  useEffect(() => {
    (async () => {
      await Promise.all([fetchTasks(), fetchProjects(), fetchTags()]);
      setDataLoaded(true);
    })();
  }, [fetchTasks, fetchProjects, fetchTags]);

  const viewDays = isMobile ? 3 : isTablet ? 7 : 14;

  return (
    <ErrorBoundaryInner>
      {!dataLoaded ? (
        <div className="flex h-screen items-center justify-center bg-base">
          <div className="flex flex-col items-center gap-4 fade-in">
            <Spinner />
            <p className="text-sm text-muted">Loading your workspace...</p>
          </div>
        </div>
      ) : (
        <StickyBoardProvider>
        <div className="h-screen flex overflow-hidden bg-base">
          {!isMobile && (
            <SidebarLeft
              collapsed={leftCollapsed}
              onToggle={() => setLeftCollapsed(!leftCollapsed)}
            />
          )}

          {/* Main area */}
          <div className="flex-1 relative flex flex-col min-w-0 overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-surface/50 shrink-0 overflow-x-auto">
              {!isMobile && (
                <button
                  onClick={() => setLeftCollapsed(!leftCollapsed)}
                  className="btn bg-elevated border border-border text-xs text-secondary px-3 py-1 rounded-xl hover:text-primary shrink-0"
                >
                  {leftCollapsed ? "Show" : "Hide"} Sidebar
                </button>
              )}
              <button
                onClick={() => setHabitsOpen(!habitsOpen)}
                className={`btn text-xs px-3 py-1 rounded-xl shrink-0 ${habitsOpen ? "bg-accent text-white" : "bg-elevated border border-border text-secondary hover:text-primary"}`}
              >
                Habits
              </button>
              <button
                onClick={() => setKanbanMode(!kanbanMode)}
                className={`btn text-xs px-3 py-1 rounded-xl shrink-0 ${kanbanMode ? "bg-accent text-white" : "bg-elevated border border-border text-secondary hover:text-primary"}`}
              >
                {kanbanMode ? "Timeline" : "Kanban"}
              </button>
              <button
                onClick={() => openSticky()}
                className="btn text-xs px-3 py-1 rounded-xl shrink-0 bg-elevated border border-border text-secondary hover:text-primary"
              >
                Notes
              </button>
              <div className="flex-1 min-w-4" />
              {!isMobile && (
                <button
                  onClick={() => router.push("/settings")}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-surface/80 border border-border text-secondary hover:bg-hover hover:text-primary transition-all shadow-sm shrink-0"
                  title="Settings"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                  </svg>
                </button>
              )}
              {!isMobile && (
                <button
                  onClick={() => setRightOpen(true)}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-accent to-purple-500 text-base hover:from-accent-hover hover:to-purple-600 transition-all shadow-glow animate-pulse-subtle shrink-0"
                  title="AI Command Center"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                  </svg>
                </button>
              )}
            </div>
            <div className="flex-1 flex min-h-0 overflow-hidden">
              {kanbanMode ? (
                <KanbanBoard />
              ) : (
                <TimelineView
                  viewDays={viewDays}
                  isMobile={isMobile}
                  rightOpen={rightOpen}
                />
              )}

              {habitsOpen && (
                <div className="w-80 max-w-full shrink-0 border-l border-border overflow-auto p-4 space-y-4">
                  <HabitTracker />
                  <HabitForm onCreated={() => {}} />
                </div>
              )}
            </div>
          </div>

          {/* Right AI Panel */}
          {rightOpen && !isMobile && (
            <div className="relative w-96 max-w-full shrink-0 border-l border-border">
              <ChatPanel onClose={() => setRightOpen(false)} />
            </div>
          )}

          {/* Mobile AI toggle overlay */}
          {isMobile && (
            <div className="fixed bottom-6 right-6 z-50">
              {!rightOpen ? (
                <button
                  onClick={() => setRightOpen(true)}
                  className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-purple-500 text-white shadow-lg shadow-accent/30 hover:shadow-xl hover:shadow-accent/40 active:scale-95 transition-all"
                  title="Open AI Chat"
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                  </svg>
                </button>
              ) : (
                <div className="fixed inset-0 z-50 flex flex-col bg-base">
                  <ChatPanel onClose={() => setRightOpen(false)} />
                </div>
              )}
            </div>
          )}
        </div>
        </StickyBoardProvider>
      )}
    </ErrorBoundaryInner>
  );
}