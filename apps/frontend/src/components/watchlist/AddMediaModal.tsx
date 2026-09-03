"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import type {
  TMDBResult,
  WatchlistMediaType,
  WatchlistStatus,
} from "@/types/watchlist";
import type { WatchlistAddPayload } from "@/hooks/useWatchlist";

interface AddMediaModalProps {
  open: boolean;
  onClose: () => void;
  search: (query: string) => Promise<TMDBResult[]>;
  onAdd: (payload: WatchlistAddPayload) => Promise<unknown>;
}

const POSTER_THUMB = "https://image.tmdb.org/t/p/w92";
const SEARCH_DEBOUNCE_MS = 400;

const STATUS_CHOICES: { value: WatchlistStatus; label: string }[] = [
  { value: "plan_to_watch", label: "Plan to watch" },
  { value: "watching", label: "Watching" },
  { value: "watched", label: "Watched" },
];

const keyOf = (r: TMDBResult) => `${r.media_type}:${r.tmdb_id}`;

export function AddMediaModal({ open, onClose, search, onAdd }: AddMediaModalProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TMDBResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Map<string, TMDBResult>>(new Map());
  const [adding, setAdding] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualType, setManualType] = useState<WatchlistMediaType>("movie");
  const [manualYear, setManualYear] = useState("");
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeqRef = useRef(0);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults([]);
      setSelected(new Map());
      setManualOpen(false);
      setManualTitle("");
      setManualYear("");
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const q = query.trim();
    if (!q) {
      searchSeqRef.current++;
      setResults([]);
      setSearching(false);
      return;
    }
    const seq = ++searchSeqRef.current;
    setSearching(true);
    timerRef.current = setTimeout(async () => {
      const data = await search(q);
      if (seq !== searchSeqRef.current) return;
      setResults(data);
      setSearching(false);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, search]);

  const toggle = (r: TMDBResult) => {
    const key = keyOf(r);
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.set(key, r);
      }
      return next;
    });
  };

  const shownResults: TMDBResult[] = (() => {
    const resultKeys = new Set(results.map(keyOf));
    const pinned = [...selected.values()].filter((r) => !resultKeys.has(keyOf(r)));
    return [...pinned, ...results];
  })();

  const addSelection = async (status: WatchlistStatus) => {
    if (adding || selected.size === 0) return;
    setAdding(true);
    setError(null);
    const chosen = [...selected.values()];
    const succeeded: string[] = [];
    let firstError: string | null = null;
    for (const r of chosen) {
      try {
        await onAdd({
          tmdb_id: r.tmdb_id,
          media_type: r.media_type,
          title: r.title,
          release_year: r.release_year,
          poster_path: r.poster_path,
          status,
        });
        succeeded.push(keyOf(r));
      } catch (e) {
        if (!firstError) {
          firstError = e instanceof Error ? e.message : `Could not add "${r.title}"`;
        }
      }
    }
    setAdding(false);
    if (firstError) {
      // Keep the modal open with the remaining selection so the user can retry.
      setError(firstError);
      setSelected((prev) => {
        const next = new Map(prev);
        for (const key of succeeded) next.delete(key);
        return next;
      });
    } else {
      onClose();
    }
  };

  const addItem = async (payload: WatchlistAddPayload) => {
    setAdding(true);
    setError(null);
    try {
      await onAdd(payload);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add to watchlist");
      setAdding(false);
    }
  };

  const submitManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualTitle.trim()) return;
    const year = manualYear.trim() ? Number(manualYear.trim()) : null;
    void addItem({
      tmdb_id: Math.floor(Date.now()),
      media_type: manualType,
      title: manualTitle.trim(),
      release_year: year && year > 1800 && year < 2100 ? year : null,
    });
  };

  return (
    <Modal isOpen={open} onClose={onClose} title="Add to watchlist">
      <div className="space-y-3">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search movies & TV shows..."
          className="input-field text-sm"
        />

        {searching && <p className="text-xs text-muted">Searching...</p>}

        {!searching && query.trim() && shownResults.length === 0 && (
          <p className="text-xs text-muted">No results. Try adding manually below.</p>
        )}

        {shownResults.length > 0 && (
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {shownResults.map((r) => {
              const key = keyOf(r);
              const isSelected = selected.has(key);
              return (
                <li key={key}>
                  <button
                    onClick={() => toggle(r)}
                    disabled={adding}
                    aria-pressed={isSelected}
                    className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors disabled:opacity-60 ${
                      isSelected
                        ? "border-accent/40 bg-accent/10"
                        : "border-transparent hover:bg-hover"
                    }`}
                  >
                    {r.poster_path ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={`${POSTER_THUMB}${r.poster_path}`}
                        alt=""
                        className="h-12 w-8 shrink-0 rounded object-cover"
                      />
                    ) : (
                      <span className="flex h-12 w-8 shrink-0 items-center justify-center rounded bg-elevated text-[9px] text-muted">
                        No img
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-primary">
                        {r.title}
                      </span>
                      <span className="block text-[11px] text-muted">
                        {r.release_year ?? "Unknown year"} · {r.media_type === "tv" ? "TV show" : "Movie"}
                      </span>
                    </span>
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] transition-colors ${
                        isSelected
                          ? "border-accent bg-accent text-[var(--on-gradient)]"
                          : "border-border text-transparent"
                      }`}
                    >
                      ✓
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2">
            <span className="text-xs font-semibold text-primary">
              {selected.size} selected
            </span>
            <span className="mx-1 hidden h-4 w-px bg-border sm:block" />
            <div className="flex flex-wrap items-center gap-1.5">
              {STATUS_CHOICES.map((choice) => (
                <button
                  key={choice.value}
                  onClick={() => void addSelection(choice.value)}
                  disabled={adding}
                  className="btn bg-elevated border border-border px-2.5 py-1 text-xs text-secondary transition-colors hover:text-primary disabled:opacity-60"
                >
                  {adding ? "Adding..." : choice.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setSelected(new Map())}
              disabled={adding}
              className="ml-auto text-xs font-semibold text-muted transition-colors hover:text-primary disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        )}

        <button
          onClick={() => setManualOpen((v) => !v)}
          className="text-xs font-semibold text-accent hover:underline"
        >
          {manualOpen ? "Hide manual entry" : "Add manually (no search / no TMDB key)"}
        </button>

        {manualOpen && (
          <form onSubmit={submitManual} className="space-y-2 rounded-lg border border-border bg-elevated p-2.5">
            <input
              value={manualTitle}
              onChange={(e) => setManualTitle(e.target.value)}
              placeholder="Title"
              required
              className="input-field text-sm"
            />
            <div className="flex gap-2">
              <select
                value={manualType}
                onChange={(e) => setManualType(e.target.value as WatchlistMediaType)}
                className="input-field text-sm w-auto"
              >
                <option value="movie">Movie</option>
                <option value="tv">TV show</option>
              </select>
              <input
                value={manualYear}
                onChange={(e) => setManualYear(e.target.value)}
                placeholder="Year (optional)"
                inputMode="numeric"
                className="input-field text-sm w-28"
              />
              <Button type="submit" size="sm" disabled={adding || !manualTitle.trim()}>
                {adding ? "Adding..." : "Add"}
              </Button>
            </div>
          </form>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    </Modal>
  );
}
