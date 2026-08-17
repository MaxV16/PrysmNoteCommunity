"use client";

import React, { useEffect, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { AppShell } from "@/components/layout/AppShell";
import { Spinner } from "@/components/ui/Spinner";
import { useTasks } from "@/hooks/useTasks";
import { useTags } from "@/hooks/useTags";
import { StickyBoardProvider } from "@/components/sticky/StickyNoteBoard";


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

function WorkspaceStage() {
  return <AppShell />;
}

export function ThreePaneLayout() {
  const [dataLoaded, setDataLoaded] = useState(false);
  const { fetchTasks } = useTasks();
  const { fetchTags } = useTags();

  useEffect(() => {
    (async () => {
      try { await fetchTasks(); } catch {}
      try { await fetchTags(); } catch {}
      setDataLoaded(true);
    })();
  }, [fetchTasks, fetchTags]);

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
            <WorkspaceStage />
          </StickyBoardProvider>
      )}
    </ErrorBoundaryInner>
  );
}
