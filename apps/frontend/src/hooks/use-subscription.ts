"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

export type SubscriptionStatus = {
  tier: string;
  status: string;
  active: boolean;
  provider: string | null;
  current_period_end: string | null;
};

export type SubscriptionValue = SubscriptionStatus & {
  isPremium: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
};

export const FREE_SUBSCRIPTION: SubscriptionStatus = {
  tier: "free",
  status: "free",
  active: false,
  provider: null,
  current_period_end: null,
};

const API_URL = process.env.NEXT_PUBLIC_API_URL || "/api";

/**
 * Silently refresh the 15-minute access-token cookie so a status read can retry
 * once after a 401. Mirrors `doRefresh` in lib/api.ts, but never redirects: this
 * provider mounts in the root layout (including /login and /register), so a hard
 * redirect here would bounce the auth pages.
 */
async function silentRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch subscription status WITHOUT the shared API helper's 401→/login redirect.
 * This provider mounts in the root layout (including /login and /register), so it
 * must be silent: a 401/404 (logged-out user, or community build without the EE
 * endpoint) simply means "free". Redirecting here caused an infinite reload
 * bounce on the auth pages.
 *
 * A 401 for a LOGGED-IN user usually just means the short-lived access-token
 * cookie expired: refresh it once and retry, otherwise a premium user would be
 * stuck on the free tier for the whole session (trial banner reappears, the
 * Collaborate tab and Integrations panel stay locked).
 */
async function fetchStatus(retried = false): Promise<SubscriptionStatus> {
  try {
    const res = await fetch(`${API_URL}/ee/billing/status`, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (res.status === 401 && !retried) {
      const refreshed = await silentRefresh();
      if (refreshed) return fetchStatus(true);
    }
    if (!res.ok) return FREE_SUBSCRIPTION;
    const data = await res.json();
    return { ...FREE_SUBSCRIPTION, ...data };
  } catch {
    return FREE_SUBSCRIPTION;
  }
}

/**
 * Reads the user's subscription/entitlement from `/api/ee/billing/status`.
 *
 * Community-safe: the EE billing endpoint doesn't exist in the community build,
 * so the fetch 404s and we degrade to the free tier (no premium features). In the
 * EE build an active subscription returns `active: true` and `isPremium` follows.
 * The `refresh()` callback re-fetches so a user can upgrade without a full reload.
 *
 * Pass the authenticated user id as `authKey`: the root-layout provider mounts
 * once (often before a client-side login finishes), so without a dependency the
 * status would stay "free" for the whole session after an SPA login even though
 * the server already sees the subscription. Changing the key re-fetches.
 */
export function useSubscription(authKey?: string | null): SubscriptionValue {
  const [sub, setSub] = useState<SubscriptionStatus>(FREE_SUBSCRIPTION);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await fetchStatus();
      setSub(s);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, authKey]);

  useEffect(() => {
    const onFocus = () => { void refresh(); };
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  return useMemo(
    () => ({ ...sub, isPremium: sub.active, loading, refresh }),
    [sub, loading, refresh]
  );
}
