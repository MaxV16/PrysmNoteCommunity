"use client";

import React, { useState, useEffect, useCallback, type ReactNode } from "react";
import { SidebarLeft } from "@/components/sidebar/SidebarLeft";
import { TimelineView } from "@/components/layout/TimelineView";
import { ChatPanel } from "@/components/ai/ChatPanel";
import { Spinner } from "@/components/ui/Spinner";
import { useTasks } from "@/hooks/useTasks";
import { useProjects } from "@/hooks/useProjects";
import { useTags } from "@/hooks/useTags";

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
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const { fetchTasks } = useTasks();
  const { fetchProjects } = useProjects();
  const { fetchTags } = useTags();

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    (async () => {
      await Promise.all([fetchTasks(), fetchProjects(), fetchTags()]);
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
        <div
          className={`h-screen overflow-hidden transition-all duration-200 ${
            isMobile ? "flex flex-col" : "grid"
          }`}
          style={isMobile ? undefined : {
            gridTemplateColumns: leftCollapsed
              ? "52px 1fr"
              : rightCollapsed
                ? "280px 1fr"
                : "280px 1fr 380px",
          }}
        >
          {!isMobile && (
            <SidebarLeft
              collapsed={leftCollapsed}
              onToggle={() => setLeftCollapsed(!leftCollapsed)}
            />
          )}
          <div className="relative">
            <TimelineView />
          </div>
          {!rightCollapsed && !isMobile && (
            <ChatPanel onClose={() => setRightCollapsed(true)} />
          )}
          {rightCollapsed && (
            <div className="flex items-start justify-center border-l border-border bg-surface pt-4"
              style={{ width: 52, minWidth: 52 }}>
              <button
                onClick={() => setRightCollapsed(false)}
                className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-lg text-base hover:bg-accent-hover transition-all shadow-md"
                title="Open AI Chat"
              >
                🤖
              </button>
            </div>
          )}
        </div>
      )}
    </ErrorBoundaryInner>
  );
}