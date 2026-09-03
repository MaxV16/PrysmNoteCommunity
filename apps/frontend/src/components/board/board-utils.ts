"use client";

export const MUTED_PALETTE: readonly string[] = [
  "#3d4a63",
  "#5a4a6b",
  "#6e3f4a",
  "#2f5c5c",
  "#5c4a3a",
  "#4a5d47",
];

export const BOARD_CARD_WIDTHS = [280, 300, 340] as const;

export type BoardDecoration = "blob" | "dots" | "arc" | "waves" | "none";

const DECORATIONS: readonly BoardDecoration[] = ["blob", "dots", "arc", "waves", "none"];

/** Stable FNV-1a 32-bit hash - task ids are UUIDs, so positions are stable
 * across sessions and devices without any persistence. */
export function hashString(s: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function defaultCardColor(taskId: string): string {
  return MUTED_PALETTE[hashString(taskId) % MUTED_PALETTE.length];
}

export function cardColor(taskId: string, overrides: Record<string, string>): string {
  return overrides[taskId] ?? defaultCardColor(taskId);
}

export function cardWidth(taskId: string): number {
  return BOARD_CARD_WIDTHS[hashString(taskId) % BOARD_CARD_WIDTHS.length];
}

export function cardTopOffset(taskId: string): number {
  return hashString(taskId) % 48;
}

export function pickDecoration(taskId: string): BoardDecoration {
  return DECORATIONS[hashString(taskId) % DECORATIONS.length];
}

/** ~1 in 4 cards gets a wide (2-track) span for visual variety. */
export function isWideCard(taskId: string): boolean {
  return hashString(taskId) % 4 === 0;
}

export const BOARD_COLOR_KEY = "prysm_board_card_colors";

export function loadColorOverrides(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(BOARD_COLOR_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveColorOverrides(map: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(BOARD_COLOR_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable */
  }
}

export function getBoardColor(taskId: string): string {
  const map = loadColorOverrides();
  return map[taskId] ?? defaultCardColor(taskId);
}

export function setBoardColor(taskId: string, color: string): void {
  const map = loadColorOverrides();
  map[taskId] = color;
  saveColorOverrides(map);
}
