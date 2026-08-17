"use client";

import { useCallback, useEffect, useState } from "react";

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
 * Fetch subscription status WITHOUT the shared API helper's 401→/login redirect.
 * This provider mounts in the root layout (including /login and /register), so it
 * must be silent: a 401/404 (logged-out user, or community build without the EE
 * endpoint) simply means "free". Redirecting here caused an infinite reload
 * bounce on the auth pages.
 */
async function fetchStatus(): Promise<SubscriptionStatus> {
  try {
    const res = await fetch(`${API_URL}/ee/billing/status`, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
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
 */
export function useSubscription(): SubscriptionValue {
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
  }, [refresh]);

  return { ...sub, isPremium: sub.active, loading, refresh };
}
