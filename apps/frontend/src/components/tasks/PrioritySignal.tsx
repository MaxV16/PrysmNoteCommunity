"use client";

import { playPriorityTick } from "@/lib/sounds";
import {
  TIER_COLORS,
  TIER_LABELS,
  TIER_VALUES,
  type PriorityTier,
} from "@/lib/priority";

const BAR_HEIGHTS = [6, 10, 14];
const BAR_HEIGHTS_COMPACT = [5, 8, 11];

/** Shared selection feedback: a per-tier note plus a light haptic tap. */
export function playPriorityFeedback(tier: PriorityTier) {
  playPriorityTick(tier);
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(pointer: coarse)")?.matches
  ) {
    navigator.vibrate?.(8);
  }
}

interface PrioritySignalProps {
  tier: PriorityTier;
  compact?: boolean;
  /**
   * Use inside a control that already has an accessible name (a menu option or
   * the picker trigger). Standalone row indicators keep the img semantics.
   */
  decorative?: boolean;
  className?: string;
}

/**
 * The shared three-bar priority signal: three bars for High, two for Medium,
 * one for Low. It is deliberately stateless and tiny so every list row, board
 * card, calendar chip and timeline bar can render it without mounting a picker
 * (no effects, no refs, no popover, three spans).
 */
export function PrioritySignal({
  tier,
  compact = false,
  decorative = false,
  className = "",
}: PrioritySignalProps) {
  const color = TIER_COLORS[tier];
  const filled = 4 - tier;
  const heights = compact ? BAR_HEIGHTS_COMPACT : BAR_HEIGHTS;

  return (
    <span
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : `Priority: ${TIER_LABELS[tier]}`}
      className={`inline-flex items-end gap-[2px] ${className}`}
    >
      {heights.map((height, index) => (
        <span
          key={height}
          className="rounded-full"
          style={{
            width: 2.5,
            height,
            backgroundColor: color,
            opacity: index < filled ? 1 : 0.22,
          }}
        />
      ))}
    </span>
  );
}

interface PriorityMenuOptionsProps {
  value: PriorityTier;
  onSelect: (tier: PriorityTier) => void;
  /** Show the small uppercase "Priority" heading above the pills. */
  showLabel?: boolean;
  /** Menu semantics for the context menu/options popover; buttons elsewhere. */
  inMenu?: boolean;
  disabled?: boolean;
  className?: string;
}

/**
 * Compact one-row priority chooser shared by the right-click menu, the task
 * drawer options menu and the mobile action bar. Stateless on purpose: the
 * surrounding menu owns opening/closing, so this adds no listeners or effects.
 */
export function PriorityMenuOptions({
  value,
  onSelect,
  showLabel = true,
  inMenu = true,
  disabled = false,
  className = "",
}: PriorityMenuOptionsProps) {
  const choose = (tier: PriorityTier) => {
    playPriorityFeedback(tier);
    onSelect(tier);
  };

  return (
    <div className={`px-2 pb-1.5 ${showLabel ? "pt-1.5" : ""} ${className}`}>
      {showLabel && (
        <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Priority
        </div>
      )}
      <div role="group" aria-label="Priority" className="flex gap-1">
        {TIER_VALUES.map((tier) => {
          const selected = tier === value;
          const color = TIER_COLORS[tier];
          return (
            <button
              key={tier}
              type="button"
              role={inMenu ? "menuitemradio" : undefined}
              aria-checked={inMenu ? selected : undefined}
              aria-pressed={inMenu ? undefined : selected}
              aria-label={TIER_LABELS[tier]}
              tabIndex={inMenu ? -1 : undefined}
              disabled={disabled}
              onClick={() => choose(tier)}
              className={`flex min-w-0 flex-1 items-center justify-center gap-1 rounded-full border px-1.5 py-1 text-[10px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-50 ${
                selected ? "text-primary" : "text-muted hover:text-primary"
              }`}
              style={
                selected
                  ? { backgroundColor: `${color}1f`, borderColor: `${color}66` }
                  : { borderColor: "var(--border)" }
              }
            >
              <PrioritySignal tier={tier} compact decorative />
              <span className="truncate">{TIER_LABELS[tier]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
