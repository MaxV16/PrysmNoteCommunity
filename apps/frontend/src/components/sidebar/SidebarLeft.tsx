"use client";

import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/lib/theme-context";
import { useUiModule } from "@/lib/ui-module-registry";
import { SidebarNav } from "@/components/sidebar/SidebarNav";
import { TagList } from "@/components/sidebar/TagList";
import { ThemeMenu } from "@/components/sidebar/ThemeMenu";
import { BrandMark } from "@/components/ui/BrandMark";
import type { WorkspaceView } from "@/components/layout/AppShell";

interface SidebarLeftProps {
  collapsed: boolean;
  onToggle: () => void;
  view: WorkspaceView;
  onSelectView: (v: WorkspaceView) => void;
}

export function SidebarLeft({ collapsed, onToggle, view, onSelectView }: SidebarLeftProps) {
  const { user, logout } = useAuth();
  const { toggleTheme } = useTheme();
  const tagsOn = useUiModule("tagList");
  const financeOn = useUiModule("finance");
  const router = useRouter();

  const handleLogout = () => {
    logout();
    router.push("/login");
  };

  if (collapsed) {
    return (
      <div className="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-3">
        <button
          onClick={onToggle}
          aria-label="Expand sidebar"
          className="icon-btn"
          title="Expand sidebar"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div className="my-1 h-px w-8 bg-border" />
        <div className="flex flex-1 flex-col items-center gap-1">
          <button
            onClick={() => onSelectView("timeline")}
            aria-label="Timeline"
            className={`icon-btn mt-1 ${view === "timeline" ? "bg-accent/15 text-accent" : ""}`}
            title="Timeline"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          {financeOn && (
            <button
              onClick={() => onSelectView("finance")}
              aria-label="Finance"
              className={`icon-btn ${view === "finance" ? "bg-accent/15 text-accent" : ""}`}
              title="Finance"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>
            </button>
          )}
        </div>
        <button
          onClick={handleLogout}
          className="icon-btn"
          title="Log out"
          aria-label="Log out"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full w-56 shrink-0 flex-col overflow-hidden border-r border-border bg-surface lg:w-60">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <BrandMark size={28} />
          <div className="leading-tight">
            <h1 className="text-sm font-bold gradient-text">Prysm Note</h1>
            <span className="text-[10px] text-muted">AI Task Manager</span>
          </div>
        </div>
        <button
          onClick={onToggle}
          className="icon-btn"
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
      </div>

      {/* Navigation */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        <SidebarNav view={view} onSelectView={onSelectView} financeOn={financeOn} />
        {tagsOn && (
          <div className="mt-6">
            <TagList />
          </div>
        )}
      </div>

      {/* Account + appearance */}
      <div className="shrink-0 border-t border-border px-2 py-2">
        {user && (
          <button
            onClick={() => router.push("/settings")}
            className="mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-secondary transition-colors hover:bg-hover hover:text-primary"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent/20 text-xs font-bold text-accent">
              {(user.display_name || user.email || "U")[0].toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 truncate text-left">{user.display_name || user.email}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
        )}

        <div className="relative flex items-center gap-1">
          <ThemeMenu />
          <button
            onClick={toggleTheme}
            className="icon-btn ml-auto"
            title="Toggle dark / light"
            aria-label="Toggle dark / light"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          </button>
          <button
            onClick={handleLogout}
            className="icon-btn"
            title="Log out"
            aria-label="Log out"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          </button>
        </div>
      </div>
    </div>
  );
}
