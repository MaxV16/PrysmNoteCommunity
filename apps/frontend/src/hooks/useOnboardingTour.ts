"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { usePreferencesStore } from "@/stores/preferences-store";
import { PREF_ONBOARDING_DONE } from "@/lib/preferences";

export interface TourStep {
  id: string;
  title: string;
  body: string;
}

export const ONBOARDING_STEPS: TourStep[] = [
  {
    id: "sidebar",
    title: "Welcome to Prysm Note",
    body: "Your projects, tags and filters live in the sidebar. Click anything here to narrow the workspace to just what you need.",
  },
  {
    id: "timeline",
    title: "Plan on the timeline",
    body: "Drag any task bar to move it to another day. Hold Cmd or Ctrl and click to select several tasks, then drag them all at once.",
  },
  {
    id: "ai-panel",
    title: "Prysm AI",
    body: "Ask your AI assistant to create, find, reschedule or complete tasks in plain language. Click the lightning button to open the chat panel.",
  },
  {
    id: "view-switcher",
    title: "Five ways to see your tasks",
    body: "Switch between Timeline, Kanban, Calendar, List and Board. Every view reads the same tasks, so your plan stays in sync.",
  },
  {
    id: "settings",
    title: "Make Prysm yours",
    body: "Themes, data imports, preferences and premium upgrades all live in Settings. Click the gear whenever you want to customize.",
  },
];

export const ONBOARDING_EVENT = "prysm-start-onboarding";

// The tour only ever mounts inside the workspace layout, but "Restart tour" is
// offered from Settings which does not render the tour. The session flag bridges
// that gap: restartOnboardingTour() sets it before dispatching the event, and the
// hook consumes it on mount (e.g. when the user navigates back to the workspace)
// so the tour always opens regardless of which route requested it.
const FORCE_SESSION_KEY = "prysm_onboarding_force";

/** Accounts younger than this window see the tour automatically once. */
const NEW_ACCOUNT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export function isNewAccount(createdAt?: string | null): boolean {
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < NEW_ACCOUNT_WINDOW_MS;
}

/** Force the tour to open (Settings > "Restart tour", independent of age). */
export function restartOnboardingTour(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(FORCE_SESSION_KEY, "1");
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new CustomEvent(ONBOARDING_EVENT));
}

export function useOnboardingTour() {
  const { user } = useAuth();
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const prefs = usePreferencesStore((s) => s.prefs);
  const setPreference = usePreferencesStore((s) => s.setPreference);
  const [stepIndex, setStepIndex] = useState<number | null>(null);
  const forcedRef = useRef(false);
  const stepIndexRef = useRef<number | null>(null);
  stepIndexRef.current = stepIndex;

  // If "Restart tour" was requested from a route that does not mount the tour
  // (Settings), the session flag survives the navigation and force-starts here.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (sessionStorage.getItem(FORCE_SESSION_KEY) === "1") {
        forcedRef.current = true;
        sessionStorage.removeItem(FORCE_SESSION_KEY);
      }
    } catch {
      /* storage unavailable */
    }
  }, []);

  // Manual "Restart tour" events always open the tour, whatever the account age.
  useEffect(() => {
    const onStart = () => {
      forcedRef.current = true;
      setStepIndex(0);
    };
    window.addEventListener(ONBOARDING_EVENT, onStart);
    return () => window.removeEventListener(ONBOARDING_EVENT, onStart);
  }, []);

  // Auto-start once for new accounts that have not dismissed the tour yet.
  useEffect(() => {
    if (stepIndex !== null) return;
    if (!user || !hydrated) return;
    if (prefs[PREF_ONBOARDING_DONE]) return;
    if (!forcedRef.current && !isNewAccount(user.created_at)) return;
    // Give the workspace a moment to settle before the first spotlight.
    const t = setTimeout(() => setStepIndex(0), 800);
    return () => clearTimeout(t);
  }, [user, hydrated, prefs, stepIndex]);

  const complete = useCallback(() => {
    tryUnsetForceFlag();
    setPreference(PREF_ONBOARDING_DONE, true);
    setStepIndex(null);
  }, [setPreference]);

  const goNext = useCallback(() => {
    const cur = stepIndexRef.current;
    if (cur === null) return;
    if (cur >= ONBOARDING_STEPS.length - 1) {
      complete();
    } else {
      setStepIndex(cur + 1);
    }
  }, [complete]);

  const skip = useCallback(() => {
    tryUnsetForceFlag();
    setPreference(PREF_ONBOARDING_DONE, true);
    setStepIndex(null);
  }, [setPreference]);

  return { stepIndex, goNext, skip };
}

function tryUnsetForceFlag(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(FORCE_SESSION_KEY);
  } catch {
    /* storage unavailable */
  }
}