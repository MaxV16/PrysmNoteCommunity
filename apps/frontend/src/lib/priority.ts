export type PriorityTier = 1 | 2 | 3;

export const TIER_LABELS: Record<PriorityTier, string> = {
  1: "High",
  2: "Medium",
  3: "Low",
};

export const TIER_COLORS: Record<PriorityTier, string> = {
  1: "#a8504c", // red   high
  2: "#4a6ea5", // blue  medium
  3: "#4a7c62", // green low
};

export const TIER_VALUES: PriorityTier[] = [1, 2, 3];

export function normalizePriority(p?: number | null): PriorityTier {
  if (!p) return 2;
  if (p <= 1) return 1;
  if (p === 2) return 2;
  return 3;
}
