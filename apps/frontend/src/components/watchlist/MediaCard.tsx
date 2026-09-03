"use client";

import { useCallback, useEffect, useState } from "react";
import { UpcomingBanner } from "./UpcomingBanner";
import type {
  WatchProviders,
  WatchlistItem,
  WatchlistStatus,
  WatchlistUpdate,
} from "@/types/watchlist";

interface MediaCardProps {
  item: WatchlistItem;
  region: string;
  onUpdate: (id: string, fields: WatchlistUpdate) => Promise<unknown>;
  onRemove: (id: string) => Promise<unknown>;
  fetchProviders: (id: string, region: string) => Promise<WatchProviders>;
}

const STATUS_META: Record<WatchlistStatus, { label: string; className: string }> = {
  plan_to_watch: { label: "Plan to watch", className: "bg-elevated text-muted" },
  watching: { label: "Watching", className: "bg-accent/20 text-accent" },
  watched: { label: "Watched", className: "bg-success/20 text-success" },
};

const STATUSES: WatchlistStatus[] = ["plan_to_watch", "watching", "watched"];

export function MediaCard({ item, region, onUpdate, onRemove, fetchProviders }: MediaCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<WatchlistStatus>(item.status);
  const [rating, setRating] = useState<number | null>(item.rating);
  const [notes, setNotes] = useState(item.notes ?? "");
  const [watchedAt, setWatchedAt] = useState(item.watched_at ?? "");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const meta = STATUS_META[item.status] ?? STATUS_META.plan_to_watch;

  const syncFromItem = useCallback(() => {
    setStatus(item.status);
    setRating(item.rating);
    setNotes(item.notes ?? "");
    setWatchedAt(item.watched_at ?? "");
  }, [item.status, item.rating, item.notes, item.watched_at]);

  useEffect(() => {
    syncFromItem();
  }, [syncFromItem, item.id]);

  const dirty =
    status !== item.status ||
    rating !== item.rating ||
    notes !== (item.notes ?? "") ||
    watchedAt !== (item.watched_at ?? "");

  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await onUpdate(item.id, {
        status,
        rating,
        notes: notes.trim() ? notes.trim() : null,
        watched_at: watchedAt || null,
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch {
      // Revert local edits so the card never shows values the server rejected.
      syncFromItem();
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = () => {
    if (window.confirm(`Remove "${item.title}" from your watchlist?`)) {
      void onRemove(item.id);
    }
  };

  return (
    <div
      className={`flex overflow-hidden rounded-2xl border border-border bg-surface shadow-sm transition-colors hover:border-accent/40 ${
        expanded ? "w-full flex-row" : "w-40 flex-col"
      }`}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className={`group relative overflow-hidden bg-elevated text-left ${
          expanded ? "w-24 shrink-0 self-stretch sm:w-28" : "aspect-[2/3] w-full"
        }`}
        aria-expanded={expanded}
        aria-label={`${item.title} details`}
      >
        {item.poster_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={item.poster_url}
            alt={item.title}
            className="h-full w-full object-cover transition-transform group-hover:scale-[1.03]"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 4v16M17 4v16M2 9h5M2 15h5M17 9h5M17 15h5"/></svg>
            <span className="text-center text-xs font-semibold text-secondary">{item.title}</span>
          </div>
        )}
        <span className={`badge absolute left-1.5 top-1.5 ${meta.className}`}>
          {item.media_type === "tv" ? "TV" : "Movie"}
        </span>
      </button>

      <div className="flex flex-1 flex-col gap-1 p-2.5">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-left text-[13px] font-semibold leading-snug text-primary hover:text-accent"
        >
          {item.title}
          {item.release_year ? <span className="ml-1 text-muted">({item.release_year})</span> : null}
        </button>
        <div className="flex items-center justify-between gap-1">
          {!expanded && <span className={`badge ${meta.className}`}>{meta.label}</span>}
          {item.rating ? (
            <span className="text-xs font-semibold text-accent">{item.rating}/10</span>
          ) : null}
        </div>

        {expanded && (
          <div className="mt-1.5 grid gap-2.5 border-t border-border pt-2 text-xs sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-muted">Status</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as WatchlistStatus)}
                className="w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-primary outline-none focus:border-accent [&>option]:bg-surface [&>option]:text-primary"
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_META[s].label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-muted">Rating</span>
              <select
                value={rating === null ? "" : String(rating)}
                onChange={(e) => setRating(e.target.value ? Number(e.target.value) : null)}
                className="w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-primary outline-none focus:border-accent [&>option]:bg-surface [&>option]:text-primary"
              >
                <option value="">No rating</option>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n} / 10
                  </option>
                ))}
              </select>
            </label>

            <label className="block sm:col-span-2">
              <span className="mb-1 block text-muted">Notes</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Add notes..."
                className="w-full resize-none rounded-lg border border-border bg-elevated px-2 py-1.5 text-primary outline-none placeholder:text-muted focus:border-accent"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-muted">Watched on</span>
              <input
                type="date"
                value={watchedAt}
                onChange={(e) => setWatchedAt(e.target.value)}
                className="w-full rounded-lg border border-border bg-elevated px-2 py-1.5 text-primary outline-none focus:border-accent"
              />
            </label>

            <button
              onClick={handleRemove}
              disabled={saving}
              className="w-full rounded-lg bg-elevated px-2 py-1.5 font-semibold text-secondary transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-60"
            >
              Remove
            </button>

            <div className="sm:col-span-2">
              <UpcomingBanner item={item} region={region} fetchProviders={fetchProviders} />
            </div>

            {savedFlash ? (
              <span className="rounded-full bg-success/15 px-3 py-1.5 text-center text-xs font-semibold text-success sm:col-span-2">
                Saved
              </span>
            ) : (
              <button
                onClick={handleSave}
                disabled={!dirty || saving}
                className="btn btn-primary w-full px-3 py-1.5 text-xs disabled:opacity-50 sm:col-span-2"
              >
                {saving ? "Saving..." : "Save changes"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
