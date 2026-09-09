"use client";

import { useState, useEffect } from "react";
import { SidebarLeft } from "@/components/sidebar/SidebarLeft";
import { TimelineView, type TimelineViewMode } from "@/components/layout/TimelineView";
import { AIPanel } from "@/components/ai/AIPanel";
import { useUiModule } from "@/lib/ui-module-registry";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { useTheme } from "@/lib/theme-context";
import { useMediaQuery } from "@/lib/use-media-query";
import { getNotes, minimizeNote, syncNotesFromServer, openNotesWindow } from "@/lib/notes";
import { FinancialWorkspace } from "@/components/finance/FinancialWorkspace";
import { HabitsWorkspace } from "@/components/habits/HabitsWorkspace";
import { QuadrantWorkspace } from "@/components/quadrant/QuadrantWorkspace";
import { WatchlistView } from "@/components/watchlist/WatchlistView";
import { PREF_DEFAULT_VIEW, getPrefSync } from "@/lib/preferences";
import { usePreferencesStore } from "@/stores/preferences-store";
import { track } from "@/lib/track";
import { initErrorTracking } from "@/lib/error-track";
import { MobileTabBar } from "@/components/layout/MobileTabBar";
import { usePwaInstall } from "@/hooks/use-pwa-install";

export type WorkspaceView = "timeline" | "finance" | "watchlist" | "habits" | "quadrant";

const VIEW_MODES: TimelineViewMode[] = ["timeline", "kanban", "calendar", "list", "board"];

export function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [view, setView] = useState<WorkspaceView>("timeline");
  const [viewMode, setViewMode] = useState<TimelineViewMode>(() => {
    // Synchronous localStorage read (no async flash); the TimelineView fallback
    // effect handles a saved value that is disabled at load.
    const saved = getPrefSync<TimelineViewMode>(PREF_DEFAULT_VIEW, "timeline");
    return VIEW_MODES.includes(saved) ? saved : "timeline";
  });

  const { toggleTheme } = useTheme();
  const sidebarOn = useUiModule("sidebar");
  const aiOn = useUiModule("aiPanel");
  const financeOn = false;
  const watchlistOn = useUiModule("watchlist");
  const habitsOn = useUiModule("habits");
  const quadrantOn = false;

  const smallScreen = useMediaQuery("(max-width: 767px)");
  const isSidebarCollapsed = smallScreen ? true : sidebarCollapsed;
  const setSidebarCollapsedState = (v: boolean) => {
    if (!smallScreen) setSidebarCollapsed(v);
  };

  // PWA install prompt (mobile only): captured on load, shown as a small
  // dismissible banner until the user installs or dismisses it.
  const { canInstall, promptInstall } = usePwaInstall();
  const [installBannerDismissed, setInstallBannerDismissed] = useState(false);
  const showInstallBanner = canInstall && !installBannerDismissed;

  const handleSelectView = (v: WorkspaceView) => {
    setView(v);
    if (smallScreen) setSidebarOpen(false);
  };

  // Mobile drawers: opening one closes the other so the overlays never collide.
  const openSidebar = () => {
    setAiOpen(false);
    setSidebarOpen(true);
  };
  const openAi = () => {
    setSidebarOpen(false);
    setAiOpen(true);
  };
  const toggleAi = () => {
    setAiOpen((v) => {
      const next = !v;
      if (next) setSidebarOpen(false);
      return next;
    });
  };

  useGlobalShortcuts({
    onToggleSidebar: () => setSidebarCollapsedState(!isSidebarCollapsed),
    onToggleAiPanel: toggleAi,
    onToggleTheme: toggleTheme,
    onNewTask: () => {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("prysm-new-task"));
      }
    },
  });

  // First-party analytics: silent error tracking + feature-use events. The
  // session id is created lazily on the first event so analytics never runs
  // for a fully logged-out visitor.
  useEffect(() => {
    initErrorTracking();
  }, []);

  useEffect(() => {
    track("feature_used", { feature: view });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    const openAi = () => setAiOpen(true);
    window.addEventListener("prysm-open-ai", openAi);
    return () => window.removeEventListener("prysm-open-ai", openAi);
  }, []);

  // "Auto-show notes on launch": notes that were open persist their open state.
  // If the setting is off, tuck them away so nothing pops up unexpectedly.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("prysm_sticky_autoshow");
      const enabled = raw === null ? true : raw === "true";
      if (!enabled) {
        getNotes()
          .filter((n) => n.open)
          .forEach((n) => minimizeNote(n.id));
      }
    } catch {}
  }, []);

  // Server sync for notes: merge the cross-device copy into the local store and
  // push any offline-only notes up.
  useEffect(() => {
    void syncNotesFromServer();
  }, []);

  // Server sync for preferences (default view, board layout prefs): silent - a
  // logged-out / community 401 simply leaves the localStorage cache in place.
  useEffect(() => {
    void usePreferencesStore.getState().hydrate();
  }, []);

  return (
    <div className="flex h-dvh w-screen flex-col overflow-hidden bg-base">
      {showInstallBanner && (
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-elevated px-4 py-2">
          <p className="min-w-0 flex-1 truncate text-xs text-secondary">
            {smallScreen
              ? "Install Prysm Note for quick access and voice capture."
              : "Install Prysm Note on this device for quick access."}
          </p>
          <button
            onClick={() => { void promptInstall(); setInstallBannerDismissed(true); }}
            className="btn btn-primary px-3 py-1 text-[11px]"
          >
            Install
          </button>
          <button
            onClick={() => setInstallBannerDismissed(true)}
            aria-label="Dismiss install prompt"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs text-muted hover:bg-hover hover:text-primary"
          >
            ✕
          </button>
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1">
      {sidebarOn && !smallScreen && (
        <SidebarLeft
          collapsed={isSidebarCollapsed}
          onToggle={() => setSidebarCollapsedState(!isSidebarCollapsed)}
          view={view}
          onSelectView={handleSelectView}
        />
      )}

      {/* Mobile: the sidebar becomes a slide-in overlay drawer instead of the
          permanent collapsed rail, so content gets the full viewport width. */}
      {sidebarOn && smallScreen && sidebarOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40"
            aria-hidden
            onClick={() => setSidebarOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-40 slide-in-left">
            <SidebarLeft
              collapsed={false}
              onToggle={() => setSidebarOpen(false)}
              view={view}
              onSelectView={handleSelectView}
            />
          </div>
        </>
      )}

      {/* Main workspace + docked AI panel resolve as real layout columns. */}
      <main className="flex min-h-0 min-w-0 flex-1">
        <div
          className="relative flex min-h-0 min-w-0 flex-1"
          data-app-workspace
        >
          {view === "finance" && financeOn ? (
            <FinancialWorkspace onOpenAi={openAi} />
          ) : view === "watchlist" && watchlistOn ? (
            <WatchlistView onOpenAi={openAi} />
          ) : view === "quadrant" && quadrantOn ? (
            <QuadrantWorkspace onOpenAi={openAi} />
          ) : view === "habits" && habitsOn ? (
            <HabitsWorkspace onOpenAi={openAi} />
          ) : (
            <TimelineView
              onToggleRight={toggleAi}
              onOpenSidebar={smallScreen ? openSidebar : undefined}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
            />
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

      {smallScreen && (
        <MobileTabBar
          view={view}
          onSelectView={handleSelectView}
          onOpenAi={openAi}
          showFinance={financeOn}
          showWatchlist={watchlistOn}
          showHabits={habitsOn}
          showQuadrant={quadrantOn}
        />
      )}
    </div>
  );
}
