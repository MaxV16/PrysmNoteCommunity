"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "@/lib/theme-context";
import { THEMES, type ThemeName } from "@/types/theme";

const APPEARANCE_THEMES: ThemeName[] = ["dark", "light", "slate", "dracula", "nord", "monokai", "coffee", "solarized", "github-dark", "tokyo"];

export function ThemeMenu() {
  const { themeName, setThemeName } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const current = THEMES[themeName];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-xs text-secondary transition-colors hover:bg-hover hover:text-primary"
      >
        <span className="flex h-5 w-5 items-center justify-center rounded-md" style={{ background: `linear-gradient(135deg, ${current?.colors?.surface || "#222"}, ${current?.colors?.accent || "#6c5ce7"})` }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        </span>
        <span className="flex-1 text-left">{current?.label || themeName}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
      </button>

      {open && (
        <div role="menu" className="absolute bottom-full left-0 z-40 mb-1 w-56 rounded-xl border border-border bg-elevated p-2 shadow-lg">
          <p className="nav-label px-2 pb-1.5 pt-1">Appearance</p>
          <div className="grid grid-cols-2 gap-1">
            {APPEARANCE_THEMES.map((name) => {
              const t = THEMES[name];
              const active = themeName === name;
              return (
                <button
                  key={name}
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => { setThemeName(name); setOpen(false); }}
                  className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors ${
                    active ? "bg-accent/15 text-primary" : "text-secondary hover:bg-hover hover:text-primary"
                  }`}
                >
                  <span
                    className="h-3.5 w-3.5 shrink-0 rounded-full border border-border"
                    style={{ background: t?.colors?.accent }}
                  />
                  <span className="truncate">{t?.label || name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
