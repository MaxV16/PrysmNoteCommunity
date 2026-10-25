/**
 * Per-view zoom ladders and storage.
 *
 * Every view keeps its own discrete ladder, so timeline density can be much
 * wider than a calendar's text scale. A stored value is never trusted raw: it is
 * parsed, checked for finiteness, clamped into the ladder's range and snapped to
 * the nearest real step. That means a corrupt localStorage entry, a legacy value
 * from an older ladder, or a hand-edited number can never produce a zero-width
 * column or an unreadable board.
 */

export const ZOOM_STORAGE_PREFIX = "prysm-zoom-";

export type ZoomLadder = readonly number[];

export function zoomStorageKey(view: string): string {
  return `${ZOOM_STORAGE_PREFIX}${view}`;
}

/**
 * Snap any value to a real ladder step, clamped to its ends. Non-finite or
 * unparseable input falls back to the closest step to `fallback`.
 */
export function normalizeZoomLevel(
  raw: unknown,
  levels: ZoomLadder,
  fallback = 1
): number {
  if (!Array.isArray(levels) || levels.length === 0) return 1;
  const fallbackLevel = nearestLevel(fallback, levels);
  if (raw == null || raw === "") return fallbackLevel;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return fallbackLevel;
  return nearestLevel(value, levels);
}

function nearestLevel(value: number, levels: ZoomLadder): number {
  const min = levels[0];
  const max = levels[levels.length - 1];
  const clamped = Math.min(max, Math.max(min, value));
  let best = levels[0];
  let bestDistance = Math.abs(clamped - best);
  for (const level of levels) {
    const distance = Math.abs(clamped - level);
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}

/** Read and validate a per-view zoom. Never throws (private mode, quota). */
export function readStoredZoom(
  view: string,
  levels: ZoomLadder,
  fallback = 1
): number {
  if (typeof window === "undefined") return normalizeZoomLevel(fallback, levels, fallback);
  try {
    return normalizeZoomLevel(localStorage.getItem(zoomStorageKey(view)), levels, fallback);
  } catch {
    return normalizeZoomLevel(fallback, levels, fallback);
  }
}

/** Persist a per-view zoom. Never throws. */
export function writeStoredZoom(view: string, value: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(zoomStorageKey(view), String(value));
  } catch {
    /* storage unavailable, keep the in-memory choice */
  }
}

/** The next step up (dir > 0) or down (dir < 0), clamped at the ladder ends. */
export function stepZoom(current: number, levels: ZoomLadder, dir: 1 | -1): number {
  if (!Array.isArray(levels) || levels.length === 0) return 1;
  const normalized = normalizeZoomLevel(current, levels, current);
  const index = levels.indexOf(normalized);
  if (index === -1) return normalized;
  const next = index + dir;
  if (next < 0) return levels[0];
  if (next >= levels.length) return levels[levels.length - 1];
  return levels[next];
}

/**
 * Scale a base pixel size by a zoom, clamped so a column can never collapse
 * below a usable tap target or grow past the width that still fits a phone.
 */
export function scaledPx(
  base: number,
  zoom: number,
  min: number,
  max: number
): number {
  const safeZoom = Number.isFinite(zoom) ? zoom : 1;
  const safeBase = Number.isFinite(base) ? base : min;
  return Math.round(Math.min(max, Math.max(min, safeBase * safeZoom)));
}

/** A short human label for a control, e.g. 1.25 → "125%". */
export function zoomPercent(zoom: number): string {
  if (!Number.isFinite(zoom)) return "100%";
  return `${Math.round(zoom * 100)}%`;
}

/**
 * Timeline zoom: a wide ladder both ways. 0.5 packs a quarter-year on a phone,
 * 6 gives a single day a wide planning canvas. Every step is a deliberate stop,
 * so ctrl/cmd+wheel and the +/- buttons always agree.
 */
export const TIMELINE_ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 6] as const;

/** Calendar month density. Clamped so day numbers and chips stay readable. */
export const CALENDAR_ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25, 1.4] as const;

/** Board/kanban card density, expressed through the column minimum width. */
export const BOARD_ZOOM_LEVELS = [0.75, 0.85, 1, 1.15, 1.3, 1.5] as const;
