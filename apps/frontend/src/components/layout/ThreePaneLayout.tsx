"use client";

import React, { useState, useEffect, type ReactNode } from "react";
import { SidebarLeft } from "@/components/sidebar/SidebarLeft";
import { TimelineView } from "@/components/layout/TimelineView";
import { ChatPanel } from "@/components/ai/ChatPanel";
import { Spinner } from "@/components/ui/Spinner";
import { useTasks } from "@/hooks/useTasks";
import { useProjects } from "@/hooks/useProjects";
import { useTags } from "@/hooks/useTags";
import { StickyBoardProvider, useStickyBoard } from "@/components/sticky/StickyNoteBoard";

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

function MainLayout() {
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);
  const { toggle: toggleSticky } = useStickyBoard();

  return (
    <div className="flex bg-base" style={{ width: "100vw", height: "100vh", overflow: "hidden" }}>
      <SidebarLeft
        collapsed={leftCollapsed}
        onToggle={() => setLeftCollapsed(!leftCollapsed)}
      />
      <div className="flex flex-col" style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
        <TimelineView
          onToggleRight={() => setRightOpen(v => !v)}
          onOpenSticky={toggleSticky}
          hideProjects={leftCollapsed}
        />
      </div>
      {rightOpen && (
        <div className="shrink-0 border-l border-border bg-base" style={{ width: 384 }}>
          <ChatPanel onClose={() => setRightOpen(false)} />
        </div>
      )}
    </div>
  );
}

export function ThreePaneLayout() {
  const [dataLoaded, setDataLoaded] = useState(false);
  const { fetchTasks } = useTasks();
  const { fetchProjects } = useProjects();
  const { fetchTags } = useTags();

  useEffect(() => {
    (async () => {
      try { await fetchTasks(); } catch {}
      try { await fetchProjects(); } catch {}
      try { await fetchTags(); } catch {}
      setDataLoaded(true);
    })();
  }, [fetchTasks, fetchProjects, fetchTags]);

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
          <MainLayout />
        </StickyBoardProvider>
      )}
    </ErrorBoundaryInner>
  );
}
