"use client";

import { useCallback, useEffect, useState } from "react";
import { useTasks } from "@/hooks/useTasks";
import { todayISO } from "@/lib/dates";
import type {
  WatchProviders,
  WatchProvider,
  WatchlistItem,
} from "@/types/watchlist";

interface UpcomingBannerProps {
  item: WatchlistItem;
  region: string;
  fetchProviders: (id: string, region: string) => Promise<WatchProviders>;
}

const PROVIDER_SECTIONS: { key: keyof WatchProviders; label: string }[] = [
  { key: "flatrate", label: "Streaming" },
  { key: "free", label: "Free" },
  { key: "rent", label: "Rent" },
  { key: "buy", label: "Buy" },
];

export function UpcomingBanner({ item, region, fetchProviders }: UpcomingBannerProps) {
  const { createTask } = useTasks();
  const [providers, setProviders] = useState<WatchProviders>(item.providers);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [reminded, setReminded] = useState<Set<number>>(new Set());
  const [adding, setAdding] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setProvidersLoading(true);
      const data = await fetchProviders(item.id, region);
      // Replace unconditionally: the server returns cached data on a failed
      // fetch and {} for a region with nothing, so stale data from a previous
      // region is always cleared.
      if (!cancelled) setProviders(data);
      if (!cancelled) setProvidersLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [item.id, region, fetchProviders]);

  const future = item.upcoming.filter((u) => u.date >= todayISO());
  const showProviders = Object.keys(providers).length > 0;

  const handleRemind = useCallback(
    async (index: number) => {
      const upcoming = future[index];
      if (!upcoming || adding !== null) return;
      setAdding(index);
      try {
        await createTask({
          title: `${item.title} - ${upcoming.label}`,
          start_date: upcoming.date,
          due_date: upcoming.date,
          status: "todo",
        });
        setReminded((prev) => {
          const next = new Set(prev);
          next.add(index);
          return next;
        });
      } catch {
        // Leave the button untouched on failure; the user can retry.
      } finally {
        setAdding(null);
      }
    },
    [future, item.title, adding, createTask]
  );

  return (
    <div className="space-y-2">
      {future.length > 0 && (
        <div className="space-y-1.5">
          {future.map((upcoming, idx) => (
            <div
              key={`${upcoming.date}-${idx}`}
              className="flex flex-wrap items-start gap-x-2 gap-y-1.5 rounded-lg border border-accent/30 bg-accent/5 px-2.5 py-2 text-xs"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-0.5 shrink-0 text-accent"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>
              <span className="min-w-0 flex-1 break-words leading-snug">
                <span className="font-medium text-primary">{upcoming.label}</span>{" "}
                <span className="text-muted">{upcoming.date}</span>
              </span>
              <span className="flex shrink-0 flex-wrap items-center gap-2">
                {reminded.has(idx) ? (
                  <span className="badge bg-success/20 text-success">Added to timeline</span>
                ) : (
                  <button
                    onClick={() => void handleRemind(idx)}
                    disabled={adding === idx}
                    className="btn btn-primary px-2.5 py-1 text-xs disabled:opacity-60"
                  >
                    {adding === idx ? "Adding..." : "Remind me"}
                  </button>
                )}
                {item.media_type === "movie" && item.is_theatrical && (
                  <a
                    href={`https://www.themoviedb.org/movie/${item.tmdb_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-lg border border-border bg-elevated px-2 py-1 font-semibold text-secondary transition-colors hover:bg-hover hover:text-primary"
                  >
                    Get tickets
                  </a>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {showProviders && (
        <div className="space-y-1">
          {PROVIDER_SECTIONS.filter((s) => (providers[s.key] ?? []).length > 0).map((section) => (
            <div key={section.key} className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="w-16 shrink-0 text-muted">{section.label}</span>
              {(providers[section.key] as WatchProvider[]).map((p) => (
                <a
                  key={p.id ?? p.name}
                  href={p.link ?? undefined}
                  title={p.name}
                  target={p.link ? "_blank" : undefined}
                  rel="noopener noreferrer"
                  aria-label={p.link ? `Watch on ${p.name}` : p.name}
                  className={`flex h-7 w-7 items-center justify-center overflow-hidden rounded-md bg-elevated transition-opacity ${
                    p.link ? "hover:opacity-80" : ""
                  }`}
                >
                  {p.logo_path ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`https://image.tmdb.org/t/p/w92${p.logo_path}`}
                      alt={p.name}
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <span className="px-1 text-[9px] text-muted">{p.name.slice(0, 3)}</span>
                  )}
                </a>
              ))}
            </div>
          ))}
          {providersLoading && !showProviders && (
            <p className="text-xs text-muted">Looking up where to watch...</p>
          )}
        </div>
      )}
    </div>
  );
}
