export type PriorityTier = 1 | 2 | 3;

export const TIER_LABELS: Record<PriorityTier, string> = {
  1: "High",
  2: "Medium",
  3: "Low",
};

export const TIER_COLORS: Record<PriorityTier, string> = {
  1: "#ef5350", // red   high
  2: "#4fc3f7", // blue  medium
  3: "#66bb6a", // green low
};

export const TIER_VALUES: PriorityTier[] = [1, 2, 3];

export function normalizePriority(p?: number | null): PriorityTier {
  if (!p) return 2;
  if (p <= 1) return 1;
  if (p === 2) return 2;
  return 3;
}
