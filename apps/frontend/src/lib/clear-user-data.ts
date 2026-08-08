"use client";

import { useAppStore } from "@/stores/app-store";

// Per-account localStorage keys that must be cleared whenever the active account
// changes (login/register/logout/delete). Leaving these around leaks one account's
// chat session, cached tasks, provider keys and habits into the next account.
const PER_ACCOUNT_KEYS = [
  "ai_session_id",
  "prysm_tasks",
  "prysm_habits",
  "prysm_key_openai",
  "prysm_key_gemini",
  "prysm_key_deepseek",
  "prysm_key_openrouter",
  "prysm_last_provider",
  "prysm_ai_chat_history",
  "prysm_ai_active_chat",
];

/**
 * Reset all in-memory (Zustand) per-account state and clear the per-account
 * localStorage keys. Call this on login, register, logout and before account
 * deletion so a new account always starts completely clean (no cross-account leak).
 */
export function clearUserData(): void {
  useAppStore.getState().reset();

  if (typeof window === "undefined") return;
  for (const key of PER_ACCOUNT_KEYS) {
    localStorage.removeItem(key);
  }
}
