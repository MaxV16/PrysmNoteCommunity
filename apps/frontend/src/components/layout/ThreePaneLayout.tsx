"use client";

import React, { useEffect, useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { AppShell } from "@/components/layout/AppShell";
import { Spinner } from "@/components/ui/Spinner";
import { useTasks } from "@/hooks/useTasks";
import { useTags } from "@/hooks/useTags";
import { StickyBoardProvider } from "@/components/sticky/StickyNoteBoard";
import { OnboardingTour } from "@/components/onboarding/OnboardingTour";



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
                className="btn btn-gradient px-4 py-2 text-base"
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
  const { fetchTasks, fetchRange } = useTasks();
  const { fetchTags } = useTags();

  useEffect(() => {
    let disposed = false;

    // Shared-store refresh: two months back, ~5 months forward. Lazy range
    // fetches (timeline scroll) grow this further; recurrence expands on demand
    // server-side. fetchRange unions with the already-loaded window, so repeat
    // calls are cheap and idempotent.
    const refreshWindow = async () => {
      try { await fetchTasks(); } catch {}
      try { await fetchRange(isoDaysAgo(-60), isoDaysAgo(150)); } catch {}
    };

    (async () => {
      await refreshWindow();
      if (disposed) return;
      try { await fetchTags(); } catch {}
      setDataLoaded(true);
    })();

    // Rolling refresh so every view (timeline, kanban, list, calendar, board)
    // sees recurring series keep growing without a reload, and the timeline
    // stays ahead of its scroll edge.
    const intervalId = setInterval(() => { void refreshWindow(); }, 5 * 60_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refreshWindow();
    };
    const onFocus = () => { void refreshWindow(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);

    return () => {
      disposed = true;
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
    };
  }, [fetchTasks, fetchRange, fetchTags]);

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
          <OnboardingTour />
      )}
    </ErrorBoundaryInner>
  );
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
