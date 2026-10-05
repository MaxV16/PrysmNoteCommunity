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
  /**
   * True once an authoritative status has been applied (a network response or a
   * hydrated cache entry). While false the plan is UNKNOWN, not free: consumers
   * must show a loading state instead of the "Upgrade to Premium" lock.
   */
  resolved: boolean;
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
 * Best-effort cache of the last authoritative status so the Integrations page
 * renders unlocked instantly for a Premium user instead of flashing the lock
 * while the first status request is in flight. Keyed by authenticated user id so
 * a login change never shows another user's plan.
 */
const SUB_CACHE_KEY = "prysm_subscription_status";

function subscriptionCacheKey(authKey?: string | null): string {
  return authKey ? `${SUB_CACHE_KEY}:${authKey}` : SUB_CACHE_KEY;
}

function readCachedStatus(authKey?: string | null): SubscriptionStatus | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(subscriptionCacheKey(authKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SubscriptionStatus>;
    if (typeof parsed?.active !== "boolean" || typeof parsed?.tier !== "string") return null;
    return { ...FREE_SUBSCRIPTION, ...parsed };
  } catch {
    return null;
  }
}

function writeCachedStatus(authKey: string | null | undefined, status: SubscriptionStatus): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(subscriptionCacheKey(authKey), JSON.stringify(status));
  } catch {
    // Storage blocked or full: the cache is best-effort, never fatal.
  }
}

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
async function fetchStatus(retried = false): Promise<SubscriptionStatus | null> {
  try {
    const res = await fetch(`${API_URL}/ee/billing/status`, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (res.status === 401 && !retried) {
      const refreshed = await silentRefresh();
      if (refreshed) return fetchStatus(true);
    }
    // 401 (logged out), 403 and 404 (community build, no EE billing endpoint)
    // are authoritative "free": report free and let the caller replace state.
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return FREE_SUBSCRIPTION;
    }
    // A 429/5xx is TRANSIENT. Returning FREE here flipped a genuine Premium
    // user to the locked "Upgrade" panel after a momentary rate limit, so we
    // return null and the caller keeps the last known status instead.
    if (!res.ok) return null;
    const data = await res.json();
    return { ...FREE_SUBSCRIPTION, ...data };
  } catch {
    // Network error is transient too; keep the last known status.
    return null;
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
  const [resolved, setResolved] = useState(false);

  // Hydrate the last authoritative status on mount / user change so a Premium
  // user's page renders unlocked instantly, before the network call returns.
  // With no cache for this user we start UNRESOLVED (skeleton), never an
  // authoritative "free" that would flash the upgrade lock.
  useEffect(() => {
    const cached = readCachedStatus(authKey);
    if (cached) {
      setSub(cached);
      setResolved(true);
    } else {
      setSub(FREE_SUBSCRIPTION);
      setResolved(false);
    }
  }, [authKey]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await fetchStatus();
      // null == transient failure: keep the last known status so a momentary
      // 429/5xx never locks a Premium user out of their features.
      if (s) {
        setSub(s);
        setResolved(true);
        writeCachedStatus(authKey, s);
      }
    } finally {
      setLoading(false);
    }
  }, [authKey]);

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
    () => ({ ...sub, isPremium: sub.active, loading, resolved, refresh }),
    [sub, loading, resolved, refresh]
  );
}
