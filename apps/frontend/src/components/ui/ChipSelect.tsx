"use client";

import { useRef, useState } from "react";
import { PopoverMenu } from "./PopoverMenu";

export interface ChipSelectOption {
  value: string;
  label: string;
}

interface ChipSelectProps {
  /** Small uppercase caption inside the chip ("List", "Status", "Priority"). */
  label: string;
  value: string;
  options: ChipSelectOption[];
  onChange: (value: string) => void;
  /** Accessible name for the trigger; defaults to `label`. */
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A compact select that lives in the same chip rail as the date pickers.
 *
 * It is deliberately NOT a native `<select>`: the browser draws that popup
 * itself, so it ignores the theme (a dark app got a white list with light text
 * in it) and its width. This renders the list through `PopoverMenu` instead, so
 * the menu uses the app's own surface, border and hover tokens, is clamped to
 * the viewport, and is keyboard navigable (arrows, Home/End, Escape).
 */
export function ChipSelect({
  label,
  value,
  options,
  onChange,
  ariaLabel,
  disabled,
  className = "",
}: ChipSelectProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = options.find((option) => option.value === value) ?? options[0];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? label}
        disabled={disabled}
        onClick={() => setOpen((prev) => !prev)}
        className={`pointer-coarse:h-10 pointer-coarse:pl-3 flex h-8 items-center gap-1.5 rounded-full border border-border/70 pl-2.5 pr-1.5 text-left transition-colors hover:bg-hover/30 focus-visible:border-accent disabled:opacity-50 ${className}`}
      >
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted">
          {label}
        </span>
        <span className="max-w-[8rem] truncate text-xs text-primary">{current?.label}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          aria-hidden="true"
          className="ml-auto shrink-0 text-muted"
        >
          <path
            d="M2.5 4.5 6 8l3.5-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <PopoverMenu
        open={open}
        triggerRef={triggerRef}
        onClose={() => setOpen(false)}
        className="min-w-[11rem]"
      >
        <div role="listbox" aria-label={ariaLabel ?? label}>
          {options.map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-hover focus:bg-hover focus:outline-none ${
                  selected ? "text-primary" : "text-secondary"
                }`}
              >
                <span className="truncate">{option.label}</span>
                {selected && (
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                    className="shrink-0 text-accent"
                  >
                    <path
                      d="M2.5 6.5 5 9l4.5-6"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      </PopoverMenu>
    </>
  );
}
