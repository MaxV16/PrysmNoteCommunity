"use client";

import { useEffect, useId, useRef, useState } from "react";
import { PopoverMenu } from "@/components/ui/PopoverMenu";
import { playPriorityTick } from "@/lib/sounds";
import {
  TIER_COLORS,
  TIER_LABELS,
  TIER_VALUES,
  type PriorityTier,
} from "@/lib/priority";

interface PriorityPickerProps {
  value: PriorityTier;
  onChange: (tier: PriorityTier) => void;
  /** `chip` sits in the task form rail; `dot` is the compact drawer-header control. */
  variant?: "chip" | "dot";
  className?: string;
}

const TIER_HINTS: Record<PriorityTier, string> = {
  1: "Do this first",
  2: "Normal pace",
  3: "When there is room",
};

const BAR_HEIGHTS = [6, 10, 14];
const BAR_HEIGHTS_COMPACT = [5, 8, 11];
const CLOSE_DELAY_MS = 260;

/**
 * A three-bar "signal" glyph: three bars for High, two for Medium, one for Low.
 * It reads faster than a coloured dot alone, and the shape still makes sense if
 * the palette is hard to distinguish.
 */
function SignalGlyph({ tier, compact = false }: { tier: PriorityTier; compact?: boolean }) {
  const color = TIER_COLORS[tier];
  const filled = 4 - tier;
  const heights = compact ? BAR_HEIGHTS_COMPACT : BAR_HEIGHTS;

  return (
    <span aria-hidden="true" className="flex items-end gap-[2px]">
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

function CheckIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-muted"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/**
 * Priority picker with a signal-strength trigger and a small tier menu. Picking
 * a tier gives three quick pieces of feedback: the bars pop, a halo expands
 * from the tier tile, and a faint note plays (higher for High). The menu lingers
 * for a beat so the feedback is visible before it closes.
 */
export function PriorityPicker({
  value,
  onChange,
  variant = "chip",
  className = "",
}: PriorityPickerProps) {
  const [open, setOpen] = useState(false);
  const [pulse, setPulse] = useState(0);
  const listboxId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const optionRefs = useRef<Partial<Record<PriorityTier, HTMLButtonElement | null>>>({});
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const color = TIER_COLORS[value];
  const label = TIER_LABELS[value];

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  // Move focus to the current tier when the menu opens, so arrow keys and Enter
  // work immediately without a detour through the trigger.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      optionRefs.current[value]?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [open, value]);

  const choose = (next: PriorityTier) => {
    if (next !== value) onChange(next);
    setPulse((n) => n + 1);
    playPriorityTick(next);
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(pointer: coarse)")?.matches
    ) {
      navigator.vibrate?.(8);
    }
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  const trigger =
    variant === "dot" ? (
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label="Change priority"
        title={`Priority: ${label}`}
        onClick={() => {
          if (closeTimer.current) clearTimeout(closeTimer.current);
          setOpen((v) => !v);
        }}
        className={`flex h-6 w-6 items-center justify-center rounded-full border transition-transform duration-150 hover:scale-110 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${className}`}
        style={{ backgroundColor: `${color}14`, borderColor: `${color}4d` }}
      >
        <span key={`${value}-${pulse}`} className={pulse > 0 ? "animate-pop" : undefined}>
          <SignalGlyph tier={value} compact />
        </span>
      </button>
    ) : (
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label="Priority"
        onClick={() => {
          if (closeTimer.current) clearTimeout(closeTimer.current);
          setOpen((v) => !v);
        }}
        className={`pointer-coarse:h-10 flex h-8 items-center gap-1.5 rounded-full border pl-2 pr-1.5 text-left transition-transform duration-150 hover:-translate-y-px active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${className}`}
        style={{ backgroundColor: `${color}12`, borderColor: `${color}4d` }}
      >
        <span
          key={`${value}-${pulse}`}
          className={`flex h-4 w-4 items-center justify-center ${pulse > 0 ? "animate-pop" : ""}`}
        >
          <SignalGlyph tier={value} compact />
        </span>
        <span className="flex items-baseline gap-1">
          <span className="text-[10px] uppercase tracking-wide text-muted">Priority</span>
          <span className="text-xs font-medium text-primary">{label}</span>
        </span>
        <ChevronIcon />
      </button>
    );

  return (
    <>
      {trigger}
      <PopoverMenu
        open={open}
        triggerRef={triggerRef}
        align={variant === "dot" ? "right" : "left"}
        onClose={() => setOpen(false)}
        className="w-60"
      >
        <div className="px-2.5 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Priority
        </div>
        <div role="listbox" id={listboxId} aria-label="Priority">
          {TIER_VALUES.map((tier) => {
            const selected = tier === value;
            const tierColor = TIER_COLORS[tier];
            return (
              <button
                key={tier}
                ref={(el) => {
                  optionRefs.current[tier] = el;
                }}
                type="button"
                role="option"
                aria-selected={selected}
                aria-label={TIER_LABELS[tier]}
                onClick={() => choose(tier)}
                className={`flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition-colors ${
                  selected ? "bg-elevated" : "hover:bg-hover/40"
                }`}
              >
                <span
                  className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
                  style={{ backgroundColor: `${tierColor}1f` }}
                >
                  {selected && (
                    <span
                      key={`ring-${pulse}-${tier}`}
                      className="animate-priority-ring pointer-events-none absolute inset-0 rounded-lg border"
                      style={{ borderColor: `${tierColor}99` }}
                    />
                  )}
                  <SignalGlyph tier={tier} compact />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold text-primary">
                    {TIER_LABELS[tier]}
                  </span>
                  <span className="block text-[10px] leading-tight text-muted">
                    {TIER_HINTS[tier]}
                  </span>
                </span>
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-accent">
                  {selected && <CheckIcon />}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverMenu>
    </>
  );
}
