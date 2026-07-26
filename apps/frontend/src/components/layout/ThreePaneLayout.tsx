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
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { StickyBoardProvider, useStickyBoard } from "@/components/sticky/StickyNoteBoard";
import { HabitForm } from "@/components/habits/HabitForm";
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
  const { open: openSticky } = useStickyBoard();
  const { fetchTasks } = useTasks();
  const { fetchProjects } = useProjects();
  const { fetchTags } = useTags();
  const { user } = useAuth();
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
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [leftCollapsed]);

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
          <div className="flex-1 relative flex flex-col overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-surface/50 shrink-0">
              <button
                onClick={() => setLeftCollapsed(!leftCollapsed)}
                className="btn bg-elevated border border-border text-xs text-secondary px-3 py-1 rounded-xl hover:text-primary"
              >
                {leftCollapsed ? "Show" : "Hide"} Sidebar
              </button>
              <div className="flex-1" />
              <button
                onClick={() => setHabitsOpen(!habitsOpen)}
                className={`btn text-xs px-3 py-1 rounded-xl ${habitsOpen ? "bg-accent text-white" : "bg-elevated border border-border text-secondary hover:text-primary"}`}
              >
                Habits
              </button>
              <button
                onClick={() => setKanbanMode(!kanbanMode)}
                className={`btn text-xs px-3 py-1 rounded-xl ${kanbanMode ? "bg-accent text-white" : "bg-elevated border border-border text-secondary hover:text-primary"}`}
              >
                {kanbanMode ? "Timeline" : "Kanban"}
              </button>
              <button
                onClick={() => openSticky()}
                className="btn text-xs px-3 py-1 rounded-xl bg-elevated border border-border text-secondary hover:text-primary"
              >
                Notes
              </button>
            </div>
            <div className="flex-1 flex overflow-hidden">
              {kanbanMode ? (
                <KanbanBoard />
              ) : (
                <TimelineView
                  viewDays={viewDays}
                  isMobile={isMobile}
                  onSettingsClick={() => router.push("/settings")}
                  onAIClick={() => setRightOpen(true)}
                  rightOpen={rightOpen}
                />
              )}

              {habitsOpen && (
                <div className="w-[320px] shrink-0 border-l border-border overflow-auto p-4 space-y-4">
                  <HabitTracker />
                  <HabitForm onCreated={() => {}} />
                </div>
              )}
            </div>
          </div>

          {/* Right AI Panel */}
          {rightOpen && !isMobile && (
            <div className="relative w-[400px] shrink-0 border-l border-border">
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