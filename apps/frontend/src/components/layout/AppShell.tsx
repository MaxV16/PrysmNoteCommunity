"use client";

import { useState, useEffect } from "react";
import { SidebarLeft } from "@/components/sidebar/SidebarLeft";
import { TimelineView, type TimelineViewMode } from "@/components/layout/TimelineView";
import { AIPanel } from "@/components/ai/AIPanel";
import { useUiModule } from "@/lib/ui-module-registry";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { useTheme } from "@/lib/theme-context";
import { useMediaQuery } from "@/lib/use-media-query";
import { useStickyBoard } from "@/components/sticky/StickyNoteBoard";
import { FinancialWorkspace } from "@/components/finance/FinancialWorkspace";

export type WorkspaceView = "timeline" | "finance";

export function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [view, setView] = useState<WorkspaceView>("timeline");
  const [viewMode, setViewMode] = useState<TimelineViewMode>("timeline");

  const { toggle: toggleSticky } = useStickyBoard();
  const { toggleTheme } = useTheme();
  const sidebarOn = useUiModule("sidebar");
  const aiOn = useUiModule("aiPanel");
  const financeOn = useUiModule("finance");

  const smallScreen = useMediaQuery("(max-width: 767px)");
  const isSidebarCollapsed = smallScreen ? true : sidebarCollapsed;
  const setSidebarCollapsedState = (v: boolean) => {
    if (!smallScreen) setSidebarCollapsed(v);
  };

  useGlobalShortcuts({
    onToggleSidebar: () => setSidebarCollapsedState(!isSidebarCollapsed),
    onToggleAiPanel: () => setAiOpen((v) => !v),
    onToggleTheme: toggleTheme,
    onNewTask: () => {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("prysm-new-task"));
      }
    },
  });

  useEffect(() => {
    const openAi = () => setAiOpen(true);
    window.addEventListener("prysm-open-ai", openAi);
    return () => window.removeEventListener("prysm-open-ai", openAi);
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-base">
      {sidebarOn && (
        <SidebarLeft
          collapsed={isSidebarCollapsed}
          onToggle={() => setSidebarCollapsedState(!isSidebarCollapsed)}
          view={view}
          onSelectView={setView}
        />
      )}

      {/* Main workspace + docked AI panel resolve as real layout columns. */}
      <main className="flex min-h-0 min-w-0 flex-1">
        <div
          className="relative flex min-h-0 min-w-0 flex-1"
          data-app-workspace
        >
          {view === "finance" && financeOn ? (
            <FinancialWorkspace onOpenAi={() => setAiOpen(true)} />
          ) : (
            <TimelineView onToggleRight={() => setAiOpen((v) => !v)} onOpenSticky={toggleSticky} viewMode={viewMode} onViewModeChange={setViewMode} />
          )}

          {/* AI panel: a docked column on lg+ (real layout region), and a slide-in
              drawer overlay below lg so timeline content is never clipped or pushed
              off-screen. */}
          {aiOn && aiOpen && (
            <div
              data-ai-dock
              className={
                smallScreen
                  ? "absolute inset-y-0 right-0 z-30 w-[min(22rem,92vw)] shadow-lg"
                  : "relative h-full min-h-0 w-[22.5rem] shrink-0 border-l border-border"
              }
            >
              <AIPanel onClose={() => setAiOpen(false)} view={view} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
