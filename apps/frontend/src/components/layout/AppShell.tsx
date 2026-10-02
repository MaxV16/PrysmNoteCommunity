"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { SidebarLeft } from "@/components/sidebar/SidebarLeft";
import dynamic from "next/dynamic";
import { TimelineView, type TimelineViewMode } from "@/components/layout/TimelineView";
import { useUiModule } from "@/lib/ui-module-registry";
import { useGlobalShortcuts } from "@/hooks/useGlobalShortcuts";
import { useTheme } from "@/lib/theme-context";
import { useMediaQuery } from "@/lib/use-media-query";
import { getNotes, minimizeNote, syncNotesFromServer } from "@/lib/notes";
import { FinancialWorkspace } from "@/components/finance/FinancialWorkspace";
import { HabitsWorkspace } from "@/components/habits/HabitsWorkspace";
import { QuadrantWorkspace } from "@/components/quadrant/QuadrantWorkspace";
import { FocusWorkspace } from "@/components/focus/FocusWorkspace";
import { CountdownWorkspace } from "@/components/countdown/CountdownWorkspace";
import { WatchlistView } from "@/components/watchlist/WatchlistView";
import {
  PREF_DEFAULT_VIEW,
  PREF_LIST_VIEWS,
  getPrefSync,
  type ListViewsMap,
} from "@/lib/preferences";
import { usePreferencesStore } from "@/stores/preferences-store";
import { useSyncTimezone } from "@/hooks/useSyncTimezone";
import { track } from "@/lib/track";
import { initErrorTracking } from "@/lib/error-track";
import { MobileTabBar } from "@/components/layout/MobileTabBar";
import { InstallBanner } from "@/components/pwa/InstallBanner";
import { useInAppReminders } from "@/hooks/useInAppReminders";
import { ReminderStack } from "@/components/notifications/ReminderStack";
import { MobileTaskActionBar } from "@/components/tasks/MobileTaskActionBar";
import { OnboardingDiscoveryCard } from "@/components/onboarding/OnboardingDiscoveryCard";
import { useAppStore } from "@/stores/app-store";
import { useForegroundRefresh, FOREGROUND_REFRESH_EVENT } from "@/hooks/useForegroundRefresh";
import { useRealtimeSync } from "@/hooks/useRealtimeSync";
import { refreshTasksPreservingWindow } from "@/hooks/useTasks";
import { registerBackHandler } from "@/lib/back-nav";
import { useFilterPersistence } from "@/hooks/useFilterPersistence";
import { ensureServiceWorker } from "@/lib/service-worker";

// The chat panel pulls in react-markdown + a large tool/voice surface; keep it
// out of the initial workspace bundle and load it only when the user opens it.
const AIPanel = dynamic(
  () => import("@/components/ai/AIPanel").then((m) => m.AIPanel),
  { ssr: false }
);

export type WorkspaceView = "timeline" | "finance" | "watchlist" | "habits" | "quadrant" | "focus" | "countdown";

const VIEW_MODES: TimelineViewMode[] = ["timeline", "kanban", "calendar", "list", "board"];

export function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // Sync browser timezone to localStorage + server on mount.
  useSyncTimezone();

  // Cross-device sync: when the app returns to the foreground (and every 30s
  // while it stays visible) pull the latest tasks, then let every mounted view
  // reload its own slice (sections, reminders, habits, watchlist, countdown,
  // finance) off one shared event - no per-feature timers.
  const refreshFromServer = useCallback(() => {
    // Skip while a task drawer is open: a mid-edit refresh replaced the task
    // object under the editor, so the saved description only appeared after a
    // reopen. The drawer reconciles itself once it closes.
    if (useAppStore.getState().selectedTaskId) return;
    void refreshTasksPreservingWindow();
    window.dispatchEvent(new CustomEvent(FOREGROUND_REFRESH_EVENT));
  }, []);

  // The interval is a slow safety net; SSE below pushes changes as they happen.
  useForegroundRefresh(refreshFromServer);
  useRealtimeSync(refreshFromServer);

  const { reminders, total: reminderTotal, dismiss, complete, snooze, open } = useInAppReminders();
  const mobileActionTaskId = useAppStore((s) => s.mobileActionTaskId);
  const selectedTaskId = useAppStore((s) => s.selectedTaskId);

  // Background refreshes pause while a task drawer is open, so reconcile once
  // it closes to pick up anything that changed elsewhere in the meantime.
  const wasDrawerOpenRef = useRef(false);
  useEffect(() => {
    if (selectedTaskId) {
      wasDrawerOpenRef.current = true;
      return;
    }
    if (wasDrawerOpenRef.current) {
      wasDrawerOpenRef.current = false;
      void refreshTasksPreservingWindow();
    }
  }, [selectedTaskId]);

  // The header's "Notifications" action (More menu) surfaces reminders: it rings
  // the stack when there is something pending, or flashes a short toast when
  // there is nothing so the action always gives visible feedback.
  const [remindersHighlighted, setRemindersHighlighted] = useState(false);
  const [notifToast, setNotifToast] = useState<string | null>(null);
  const notifHighlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notifToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasReminders = reminders.length > 0;
  useEffect(() => {
    const onShowReminders = () => {
      if (hasReminders) {
        setRemindersHighlighted(true);
        if (notifHighlightTimerRef.current) clearTimeout(notifHighlightTimerRef.current);
        notifHighlightTimerRef.current = setTimeout(() => setRemindersHighlighted(false), 1600);
      } else {
        setNotifToast("No new notifications");
        if (notifToastTimerRef.current) clearTimeout(notifToastTimerRef.current);
        notifToastTimerRef.current = setTimeout(() => setNotifToast(null), 2400);
      }
    };
    window.addEventListener("prysm:show-reminders", onShowReminders);
    return () => window.removeEventListener("prysm:show-reminders", onShowReminders);
  }, [hasReminders]);
  useEffect(
    () => () => {
      if (notifHighlightTimerRef.current) clearTimeout(notifHighlightTimerRef.current);
      if (notifToastTimerRef.current) clearTimeout(notifToastTimerRef.current);
    },
    []
  );

  const activeListId = useAppStore((s) => s.activeListId);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [view, setView] = useState<WorkspaceView>("timeline");
  const [viewMode, setViewMode] = useState<TimelineViewMode>(() => {
    // Synchronous localStorage read (no async flash); the TimelineView fallback
    // effect handles a saved value that is disabled at load.
    const saved = getPrefSync<TimelineViewMode>(PREF_DEFAULT_VIEW, "timeline");
    return VIEW_MODES.includes(saved) ? saved : "timeline";
  });

  // Per-list view: changing the view while a list is selected remembers it for
  // that list only, so re-opening the list restores the same view.
  const changeViewMode = useCallback((mode: TimelineViewMode) => {
    setViewMode(mode);
    const listId = useAppStore.getState().activeListId;
    if (!listId) return;
    const current =
      (usePreferencesStore.getState().prefs[PREF_LIST_VIEWS] as ListViewsMap) || {};
    if (current[listId] === mode) return;
    usePreferencesStore.getState().setPreference(PREF_LIST_VIEWS, {
      ...current,
      [listId]: mode,
    });
  }, []);

  // Restore a list's remembered view when it becomes active. A list with no
  // remembered view falls back to the global default view preference.
  const prefsHydrated = usePreferencesStore((s) => s.hydrated);
  useEffect(() => {
    if (!prefsHydrated) return;
    const listId = useAppStore.getState().activeListId;
    if (!listId) return;
    const savedViews =
      (usePreferencesStore.getState().prefs[PREF_LIST_VIEWS] as ListViewsMap) || {};
    const saved = savedViews[listId];
    const fallback = getPrefSync<TimelineViewMode>(PREF_DEFAULT_VIEW, "timeline");
    const next =
      saved && VIEW_MODES.includes(saved as TimelineViewMode)
        ? (saved as TimelineViewMode)
        : VIEW_MODES.includes(fallback)
          ? fallback
          : "timeline";
    setViewMode((prev) => (prev === next ? prev : next));
  }, [activeListId, prefsHydrated]);

  // Board-section kind for the active view. The mobile action bar's section
  // picker must match it; calendar/list and the non-task workspaces have none.
  const boardKind: "timeline" | "kanban" | "board" | null =
    view === "timeline" &&
    (viewMode === "timeline" || viewMode === "kanban" || viewMode === "board")
      ? viewMode
      : null;

  const { toggleTheme } = useTheme();
  const sidebarOn = useUiModule("sidebar");
  const aiOn = useUiModule("aiPanel");
  const financeOn = useUiModule("finance");
  const watchlistOn = useUiModule("watchlist");
  const habitsOn = useUiModule("habits");
  const quadrantOn = false;
  const focusOn = false;
  const countdownOn = false;

  const smallScreen = useMediaQuery("(max-width: 767px)");
  const isSidebarCollapsed = smallScreen ? true : sidebarCollapsed;
  const setSidebarCollapsedState = (v: boolean) => {
    if (!smallScreen) setSidebarCollapsed(v);
  };

  // Cross-browser PWA install surface (native dialog on Chromium, manual
  // Share/menu steps on iOS, Brave, Firefox and other non-supporting browsers).
  // The marketing "Install on your phone" link sets ?install=1 to open the guide.
  const [installRequested, setInstallRequested] = useState(false);
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).get("install") === "1") {
        setInstallRequested(true);
      }
    } catch {
      /* ignore malformed URLs */
    }
  }, []);

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

  // EE features (e.g. Start Focus from a task menu) can request a workspace
  // switch over a window event instead of coupling to AppShell state directly.
  useEffect(() => {
    const onOpenWorkspace = (e: Event) => {
      const detail = (e as CustomEvent<{ view?: WorkspaceView }>).detail;
      if (detail?.view) {
        setView(detail.view);
        if (smallScreen) setSidebarOpen(false);
        setAiOpen(false);
      }
    };
    window.addEventListener("prysm-open-workspace", onOpenWorkspace);
    return () => window.removeEventListener("prysm-open-workspace", onOpenWorkspace);
  }, [smallScreen]);

  // Hardware/Android back: close the top-most drawer first, then leave a
  // non-timeline workspace for the timeline, so back never exits the app while
  // something is still open. Overlays register at a higher priority elsewhere
  // (modals, expanded quadrant, task drawers).
  useEffect(() => {
    const unregister: Array<() => void> = [];
    if (view !== "timeline") {
      unregister.push(registerBackHandler(() => setView("timeline"), 0));
    }
    if (aiOpen) unregister.push(registerBackHandler(() => setAiOpen(false), 50));
    if (sidebarOpen) unregister.push(registerBackHandler(() => setSidebarOpen(false), 50));
    return () => unregister.forEach((u) => u());
  }, [view, aiOpen, sidebarOpen]);

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

  // Restore + persist the smart-list / list / tag / search filter across reloads.
  useFilterPersistence(prefsHydrated);

  // Service worker registration for PWA offline support. The URL carries the
  // build SHA so a new release installs a fresh worker and evicts old caches.
  useEffect(() => {
    void ensureServiceWorker();
  }, []);

  return (
    <div data-app-shell className="flex h-dvh max-h-dvh w-screen flex-col overflow-hidden bg-base">
      <InstallBanner smallScreen={smallScreen} autoOpenGuide={installRequested} />

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
          <div className="fixed inset-y-0 left-0 z-40 slide-in-left pt-safe pb-safe">
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
            <QuadrantWorkspace onOpenAi={openAi} onExit={() => handleSelectView("timeline")} />
          ) : view === "focus" && focusOn ? (
            <FocusWorkspace onOpenAi={openAi} />
          ) : view === "countdown" && countdownOn ? (
            <CountdownWorkspace onOpenAi={openAi} />
          ) : view === "habits" && habitsOn ? (
            <HabitsWorkspace onOpenAi={openAi} />
          ) : (
            <TimelineView
              onToggleRight={toggleAi}
              onOpenSidebar={smallScreen ? openSidebar : undefined}
              viewMode={viewMode}
              onViewModeChange={changeViewMode}
            />
          )}

          {/* AI panel: a docked column on lg+ (real layout region), and a slide-in
              drawer overlay below lg so timeline content is never clipped or pushed
              off-screen. */}
          {aiOn && aiOpen && (
            <>
              {smallScreen && (
                <div
                  className="absolute inset-0 z-20 bg-black/40"
                  aria-hidden
                  onClick={() => setAiOpen(false)}
                />
              )}
              <div
                data-ai-dock
                className={
                  smallScreen
                    ? "absolute inset-y-0 right-0 z-30 w-[min(22rem,92vw)] pt-safe pb-safe shadow-lg"
                    : "relative h-full min-h-0 w-[22.5rem] shrink-0 border-l border-border"
                }
              >
                <AIPanel onClose={() => setAiOpen(false)} view={view} />
              </div>
            </>
          )}

          {view === "timeline" && <OnboardingDiscoveryCard />}
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
          showFocus={focusOn}
          showCountdown={countdownOn}
        />
      )}

      <ReminderStack
        reminders={reminders}
        total={reminderTotal}
        raised={Boolean(mobileActionTaskId)}
        drawerOpen={Boolean(selectedTaskId)}
        highlight={remindersHighlighted}
        onDone={(id) => void complete(id)}
        onSnooze={snooze}
        onOpen={open}
        onDismiss={dismiss}
      />

      {notifToast && (
        <div
          role="status"
          data-testid="notification-toast"
              className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom)+4.75rem)] right-4 z-[9999] slide-up rounded-xl border border-border bg-elevated px-3.5 py-2 text-xs font-medium text-primary shadow-lg sm:bottom-4"
        >
          {notifToast}
        </div>
      )}

      <MobileTaskActionBar sectionKind={boardKind} />
    </div>
  );
}
