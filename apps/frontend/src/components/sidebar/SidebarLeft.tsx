"use client";

import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/lib/theme-context";
import type { ThemeName } from "@/types/theme";
import { THEMES } from "@/types/theme";
import { NavSection } from "@/components/sidebar/NavSection";
import { ProjectList } from "@/components/sidebar/ProjectList";
import { TagList } from "@/components/sidebar/TagList";
import { FilterBar } from "@/components/sidebar/FilterBar";

interface SidebarLeftProps {
  collapsed: boolean;
  onToggle: () => void;
}

const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

export function SidebarLeft({ collapsed, onToggle }: SidebarLeftProps) {
  const { user, logout } = useAuth();
  const { themeName, setThemeName, toggleTheme } = useTheme();
  const router = useRouter();

  const handleLogout = () => {
    logout();
    router.push("/login");
  };

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 border-r border-border bg-surface py-2 h-full">
        <button
          onClick={onToggle}
          className="flex h-9 w-9 items-center justify-center rounded-lg text-lg text-secondary hover:bg-hover hover:text-primary transition-colors"
          title="Expand sidebar"
        >
          ▶
        </button>
        <div className="w-8 h-px bg-border my-1" />
        {THEME_NAMES.map((name) => (
          <button
            key={name}
            onClick={() => setThemeName(name)}
            className={`h-3 w-3 rounded-full border transition-all ${
              themeName === name ? "border-accent scale-125 ring-2 ring-accent/20" : "border-transparent hover:scale-110"
            }`}
            style={{ backgroundColor: THEMES[name].colors.accent }}
            title={THEMES[name].label}
          />
        ))}
        <div className="flex-1" />
        <button
          onClick={handleLogout}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-sm text-muted hover:bg-hover hover:text-danger transition-colors mt-auto mb-1"
          title="Log out"
        >
          ⏻
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col border-r border-border bg-surface overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z"/>
              <path d="M2 17l10 5 10-5"/>
              <path d="M2 12l10 5 10-5"/>
            </svg>
          </div>
          <div>
            <h1 className="text-sm font-bold gradient-text leading-tight">Prysm Note</h1>
            <span className="text-[10px] text-muted">AI Task Manager</span>
          </div>
        </div>
        <button
          onClick={onToggle}
          className="rounded-lg p-1.5 text-sm text-secondary hover:bg-hover hover:text-primary transition-colors"
          title="Collapse sidebar"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
      </div>

      {/* User section */}
      {user && (
        <div className="flex items-center justify-between border-b border-border/50 px-4 py-2.5">
          <button
            onClick={() => router.push("/settings")}
            className="flex items-center gap-2 text-xs text-muted hover:text-primary transition-colors"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/20 text-xs font-bold text-accent">
              {(user.display_name || user.email || "U")[0].toUpperCase()}
            </span>
            <span className="truncate max-w-[140px]">{user.display_name || user.email}</span>
          </button>
          <button
            onClick={handleLogout}
            className="rounded p-1 text-xs text-muted hover:text-danger transition-colors"
            title="Log out"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
      )}

        {/* Navigation & Content */}
        <div className="flex-1 overflow-auto px-3 py-3 space-y-5 scroll-smooth">
          <NavSection />
          <div className="divider-gradient" />
          <FilterBar />
          <div className="divider-gradient" />
          <ProjectList />
          <div className="divider-gradient" />
          <TagList />
        </div>

      {/* Theme selector in footer */}
      <div className="border-t border-border px-3 py-2">
        <div className="flex items-center justify-between">
          <button
            onClick={toggleTheme}
            className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-secondary hover:bg-hover hover:text-primary transition-colors"
          >
            <span>🎨</span>
            <span>{THEMES[themeName].label}</span>
          </button>
          <div className="flex gap-1">
            {THEME_NAMES.map((name) => (
              <button
                key={name}
                onClick={() => setThemeName(name)}
                className={`h-4 w-4 rounded-full border-2 transition-all ${
                  themeName === name ? "border-accent scale-125" : "border-transparent"
                }`}
                style={{ backgroundColor: THEMES[name].colors.accent }}
                title={THEMES[name].label}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}