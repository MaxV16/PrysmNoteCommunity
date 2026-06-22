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
  const { fetchTasks } = useTasks();
  const { fetchProjects } = useProjects();
  const { fetchTags } = useTags();
  const { user } = useAuth();
  const router = useRouter();

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
        <div className="h-screen flex overflow-hidden bg-base">
          {!isMobile && (
            <SidebarLeft
              collapsed={leftCollapsed}
              onToggle={() => setLeftCollapsed(!leftCollapsed)}
            />
          )}

          {/* Main area: timeline + overlays */}
          <div className="flex-1 relative flex flex-col overflow-hidden">
            {/* Top bar with settings always visible */}
            <div className="absolute top-3 right-3 z-30 flex items-center gap-2">
              {user && (
                <button
                  onClick={() => router.push("/settings")}
                  className="flex h-8 w-8 items-center justify-center rounded-xl bg-surface/80 backdrop-blur-sm border border-border text-secondary hover:bg-hover hover:text-primary transition-all shadow-sm"
                  title="Settings"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                  </svg>
                </button>
              )}
              {/* AI toggle button — top-right on desktop, hidden when panel is open */}
              {!rightOpen && (
                <button
                  onClick={() => setRightOpen(true)}
                  className="flex h-8 w-8 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-purple-500 text-base hover:from-accent-hover hover:to-purple-600 transition-all shadow-glow"
                  title="Open AI Chat"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                  </svg>
                </button>
              )}
            </div>

            <TimelineView />
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
                  className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-purple-500 text-white shadow-lg shadow-accent/30 hover:shadow-xl hover:shadow-accent/40 active:scale-95 transition-all"
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
      )}
    </ErrorBoundaryInner>
  );
}