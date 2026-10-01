"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { usePreferencesStore } from "@/stores/preferences-store";
import { PREF_ONBOARDING_DONE } from "@/lib/preferences";
import { isNewAccount } from "@/hooks/useOnboardingTour";
import { api } from "@/lib/api";
import { track } from "@/lib/track";

const DISCOVERY_DONE_KEY = "prysm_onboarding_discovery_done";

const EXAMPLE_PROMPT = "Plan my week from my task list";

interface AIEntitlement {
  mode: "byok" | "prysmai" | "none";
}

/**
 * One-time contextual card shown once the tour is finished, giving a new account
 * a concrete next action: try the AI (when entitled) or create a first task.
 * Non-modal, dismissible, and shown at most once per browser.
 */
export function OnboardingDiscoveryCard() {
  const { user } = useAuth();
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const tourDone = usePreferencesStore((s) => Boolean(s.prefs[PREF_ONBOARDING_DONE]));
  const [hidden, setHidden] = useState(true);
  const [aiMode, setAiMode] = useState<AIEntitlement["mode"] | null>(null);

  useEffect(() => {
    try {
      setHidden(localStorage.getItem(DISCOVERY_DONE_KEY) === "1");
    } catch {
      setHidden(false);
    }
  }, []);

  // Only ask for the entitlement when the card can actually be shown, so this
  // costs nothing for returning users.
  const eligible =
    hydrated && tourDone && !hidden && Boolean(user) && isNewAccount(user?.created_at);

  useEffect(() => {
    if (!eligible || aiMode !== null) return;
    let cancelled = false;
    api
      .get<AIEntitlement>("/ai/entitlement")
      .then((e) => {
        if (!cancelled) setAiMode(e.mode);
      })
      .catch(() => {
        if (!cancelled) setAiMode("none");
      });
    return () => {
      cancelled = true;
    };
  }, [eligible, aiMode]);

  const finish = () => {
    setHidden(true);
    try {
      localStorage.setItem(DISCOVERY_DONE_KEY, "1");
    } catch {
      /* storage unavailable: keep it hidden for this session */
    }
  };

  if (!eligible || aiMode === null) {
    return null;
  }

  const hasAi = aiMode !== "none";

  const primary = () => {
    if (hasAi) {
      window.dispatchEvent(new CustomEvent("prysm-open-ai"));
      window.dispatchEvent(
        new CustomEvent("prysm-ai-suggest", { detail: { prompt: EXAMPLE_PROMPT } })
      );
      track("onboarding_next_step", { action: "open_ai" });
    } else {
      window.dispatchEvent(new CustomEvent("prysm-new-task"));
      track("onboarding_next_step", { action: "new_task" });
    }
    finish();
  };

  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-20 w-[min(22rem,calc(100vw-2rem))]">
      <div className="pointer-events-auto flex items-start gap-3 rounded-2xl border border-border bg-surface p-4 shadow-lg">
        <div className="gradient-bg flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[var(--on-gradient)]">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-primary">
            {hasAi ? "Your first AI-planned day" : "Start with your first task"}
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
            {hasAi
              ? "Open the chat and describe your day in a sentence. It creates and schedules the tasks for you."
              : "Add a task and it appears on the timeline instantly. You can always bring your own AI later."}
          </p>
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              onClick={primary}
              className="btn btn-primary px-3 py-1.5 text-[11px]"
            >
              {hasAi ? "Open the chat" : "Create a task"}
            </button>
            <button
              type="button"
              onClick={finish}
              className="text-[11px] text-muted hover:text-secondary"
            >
              Dismiss
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={finish}
          aria-label="Dismiss tip"
          className="shrink-0 text-muted hover:text-primary"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export default OnboardingDiscoveryCard;
