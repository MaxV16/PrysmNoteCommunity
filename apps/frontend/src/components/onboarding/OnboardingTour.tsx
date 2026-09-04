"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ONBOARDING_STEPS,
  useOnboardingTour,
} from "@/hooks/useOnboardingTour";

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
}

const PADDING = 8;
const RETRY_MS = 600;
const MAX_TRIES = 3;
const Z_INDEX = 300;

/** True on the last step, where the primary button reads "Got it". */
function isLastStep(index: number | null): boolean {
  return index !== null && index >= ONBOARDING_STEPS.length - 1;
}

export function OnboardingTour() {
  const { stepIndex, goNext, skip } = useOnboardingTour();
  const [rect, setRect] = useState<Rect | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const step = stepIndex === null ? null : ONBOARDING_STEPS[stepIndex];

  // Locate the spotlight target for the active step. The workspace loads
  // async data before some elements exist, so retry briefly, then skip the
  // step entirely if the anchor never appears.
  useEffect(() => {
    if (!step) {
      setRect(null);
      setTooltipPos(null);
      return;
    }
    let cancelled = false;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const measure = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.id}"]`);
      if (!el) {
        tries += 1;
        if (tries <= MAX_TRIES && !cancelled) {
          timer = setTimeout(measure, RETRY_MS);
          return;
        }
        if (!cancelled) goNext();
        return;
      }
      el.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: reducedMotion ? "auto" : "smooth",
      });
      // Re-measure after the scroll settles so the ring hugs the element.
      timer = setTimeout(() => {
        if (cancelled) return;
        const r = el.getBoundingClientRect();
        setRect({
          top: r.top - PADDING,
          left: r.left - PADDING,
          width: r.width + PADDING * 2,
          height: r.height + PADDING * 2,
          bottom: r.bottom + PADDING,
        });
      }, reducedMotion ? 0 : 400);
    };
    timer = setTimeout(measure, 100);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [step, goNext]);

  // Position the tooltip card next to the highlight, flipping above when there
  // is no room below.
  useLayoutEffect(() => {
    if (!step || !rect || !tooltipRef.current) {
      setTooltipPos(null);
      return;
    }
    const card = tooltipRef.current;
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = rect.bottom + 12;
    if (top + h + 16 > vh) top = Math.max(16, rect.top - h - 12);
    const left = Math.min(Math.max(16, rect.left), Math.max(16, vw - w - 16));
    setTooltipPos({ top, left });
  }, [step, rect]);

  // Escape dismisses the tour (and marks it done so it does not replay).
  useEffect(() => {
    if (stepIndex === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        skip();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [stepIndex, skip]);

  const handleNext = useCallback(() => {
    goNext();
  }, [goNext]);

  if (stepIndex === null || !step) return null;

  const lastStep = isLastStep(stepIndex);

  return (
    <div className="fixed inset-0" style={{ zIndex: Z_INDEX }} role="dialog" aria-modal="true" aria-label={step.title}>
      {/* Full-screen click catcher: blocks interaction until the tour ends. */}
      <div className="absolute inset-0" />

      {/* Spotlight glow: transparent at the element, dimmed everywhere else. */}
      {rect && (
        <div
          className="pointer-events-none absolute"
          style={{
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            borderRadius: 14,
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.45)",
            transition:
              "top 0.25s ease, left 0.25s ease, width 0.25s ease, height 0.25s ease",
          }}
        />
      )}

      {/* Tooltip card */}
      <div
        ref={tooltipRef}
        className="absolute w-[min(21rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-4 shadow-2xl"
        style={
          tooltipPos
            ? { top: tooltipPos.top, left: tooltipPos.left }
            : { top: -9999, left: -9999 }
        }
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">
            {stepIndex + 1} / {ONBOARDING_STEPS.length}
          </span>
          <span className="ml-auto flex gap-0.5">
            {ONBOARDING_STEPS.map((s, i) => (
              <span
                key={s.id}
                className={`h-1 w-4 rounded-full ${i === stepIndex ? "bg-accent" : "bg-elevated"}`}
              />
            ))}
          </span>
        </div>
        <h3 className="text-sm font-bold text-primary">{step.title}</h3>
        <p className="mt-1 text-xs leading-relaxed text-secondary">{step.body}</p>
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={handleNext}
            className="btn btn-primary px-4 py-1.5 text-xs"
          >
            {lastStep ? "Got it" : "Next"}
          </button>
          <button
            onClick={skip}
            className="text-xs text-muted transition-colors hover:text-primary"
          >
            Skip
          </button>
        </div>
      </div>
    </div>
  );
}