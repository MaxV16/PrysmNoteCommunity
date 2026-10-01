"use client";

import { charLimitStatus } from "@/lib/char-limits";

interface CharLimitHintProps {
  value: string;
  max: number;
  className?: string;
  alwaysVisible?: boolean;
}

/**
 * Live character counter for a text field.
 * Renders nothing until the value is near or over `max` unless
 * `alwaysVisible` is set. When over the limit it states how many
 * characters must be removed.
 */
export function CharLimitHint({
  value,
  max,
  className = "",
  alwaysVisible = false,
}: CharLimitHintProps) {
  const { remaining, over, isOver, isNear } = charLimitStatus(value, max);

  if (!alwaysVisible && !isNear && !isOver) return null;

  const tone = isOver
    ? "text-danger"
    : isNear
      ? "text-warning"
      : "text-muted";

  const message = isOver
    ? `${over.toLocaleString()} character${over === 1 ? "" : "s"} over the limit`
    : `${remaining.toLocaleString()} character${remaining === 1 ? "" : "s"} left`;

  return (
    <p
      className={`text-[10px] ${tone} ${className}`}
      aria-live="polite"
      data-testid="char-limit-hint"
    >
      {message}
      {!isOver && ` (max ${max.toLocaleString()})`}
    </p>
  );
}
