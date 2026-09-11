"use client";

import { useMemo, useState } from "react";
import { useWatchlist } from "@/hooks/useWatchlist";
import { AddMediaModal } from "./AddMediaModal";
import { MediaCard } from "./MediaCard";
import { usePreferencesStore } from "@/stores/preferences-store";
import { PREF_WATCHLIST_REGION } from "@/lib/preferences";
import type { WatchlistStatus } from "@/types/watchlist";
import { AiPanelButton } from "@/components/ui/AiPanelButton";

interface WatchlistViewProps {
  onOpenAi?: () => void;
}

const REGIONS = ["US", "CA", "GB", "DE", "FR", "ES", "IT", "NL", "SE", "NO", "DK", "FI", "PL", "PT", "IE", "AU", "NZ", "IN", "JP", "BR", "MX", "AR", "CL", "CO", "KR"];

const STATUS_GROUPS: { status: WatchlistStatus; label: string }[] = [
  { status: "plan_to_watch", label: "Plan to watch" },
  { status: "watching", label: "Watching" },
  { status: "watched", label: "Watched" },
];

type FilterTab = "all" | WatchlistStatus;

export function WatchlistView({ onOpenAi }: WatchlistViewProps) {
  const { items, loading, search, add, update, remove, fetchProviders } = useWatchlist();
  const [tab, setTab] = useState<FilterTab>("all");
  const [modalOpen, setModalOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const region = usePreferencesStore(
    (s) => (s.prefs[PREF_WATCHLIST_REGION] as string) || "US"
  );
  const setPreference = usePreferencesStore((s) => s.setPreference);

  const grouped = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = items.filter(
      (i) =>
        (tab === "all" || i.status === tab) &&
        (!q || i.title.toLowerCase().includes(q))
    );
    return STATUS_GROUPS.map((g) => ({
      ...g,
      items: filtered.filter((i) => i.status === g.status),
    })).filter((g) => g.items.length > 0);
  }, [items, tab, searchQuery]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base">
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-2">
        <h1 className="text-lg font-bold text-primary">Shows &amp; Movies</h1>
        <div className="relative ml-auto w-full sm:w-56">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search your watchlist..."
            className="input-field pl-8 text-xs"
          />
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          </span>
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-primary"
            >
              ✕
            </button>
          )}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Region
          <select
            value={region}
            onChange={(e) => setPreference(PREF_WATCHLIST_REGION, e.target.value)}
            className="btn bg-elevated border border-border px-3 py-1.5 text-xs font-semibold text-secondary transition-colors hover:text-primary [&>option]:bg-surface [&>option]:text-primary"
          >
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-0.5 rounded-full bg-elevated p-0.5">
          {(["all", ...STATUS_GROUPS.map((g) => g.status)] as FilterTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
                tab === t ? "bg-accent font-semibold text-[var(--on-gradient)]" : "text-secondary hover:text-primary"
              }`}
            >
              {t === "all" ? "All" : STATUS_GROUPS.find((g) => g.status === t)!.label}
            </button>
          ))}
        </div>
        <button onClick={() => setModalOpen(true)} className="btn btn-primary px-3 py-1.5 text-xs">
          + Add
        </button>
        {onOpenAi && <AiPanelButton onClick={onOpenAi} />}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {loading && items.length === 0 ? (
          <p className="text-sm text-muted">Loading your watchlist...</p>
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5"/></svg>
            </div>
            <div>
              <p className="text-sm font-semibold text-primary">Track movies &amp; TV shows</p>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-secondary">
                Titles you want to watch, are watching, or finished - with streaming links, upcoming releases, and reminder tasks.
              </p>
            </div>
            <button onClick={() => setModalOpen(true)} className="btn-gradient rounded-lg px-4 py-2 text-xs font-semibold">
              + Add your first title
            </button>
          </div>
        ) : grouped.length === 0 ? (
          <p className="text-sm text-muted">
            {searchQuery.trim()
              ? "No titles match your search."
              : "No items in this status yet."}
          </p>
        ) : (
          <div className="space-y-6">
            {grouped.map((group) => (
              <section key={group.status}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                  {group.label} ({group.items.length})
                </h2>
                <div className="flex flex-wrap gap-3">
                  {group.items.map((item) => (
                    <MediaCard
                      key={item.id}
                      item={item}
                      region={region}
                      onUpdate={update}
                      onRemove={remove}
                      fetchProviders={fetchProviders}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-2 text-[10px] text-muted">
        <a
          href="https://www.themoviedb.org/"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="The Movie Database (TMDB)"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="https://www.themoviedb.org/assets/v4/logos/v2/blue_short-8e7b30f73a4020692ccca9c88bafe5dcb6f8a62a4c6bc55cd9ba82bb2cd95f6c.svg"
            alt="The Movie Database (TMDB)"
            className="h-3"
          />
        </a>
        <span>This product uses the TMDB API but is not endorsed or certified by TMDB.</span>
      </footer>

      <AddMediaModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        search={search}
        onAdd={add}
      />
    </div>
  );
}
