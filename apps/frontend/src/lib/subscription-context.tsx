"use client";

import { createContext, useContext, type ReactNode } from "react";

import { useAuth } from "@/lib/auth-context";
import { FREE_SUBSCRIPTION, useSubscription, type SubscriptionValue } from "@/hooks/use-subscription";

const SubscriptionContext = createContext<SubscriptionValue | null>(null);

/**
 * Provides the user's premium entitlement to the tree. Community-safe: the
 * provider works (defaults to free) even when the EE billing endpoint is absent,
 * and the community build simply never mounts the EE gates.
 *
 * Keyed on the authenticated user id so a client-side login/logout re-fetches the
 * status: the provider mounts once in the root layout, and without this a login
 * that does not hard-reload would keep reporting "free" (trial banner reappears,
 * Collaborate/Integrations stay locked) while the server already sees the plan.
 */
export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const value = useSubscription(user?.id ?? null);
  return <SubscriptionContext.Provider value={value}>{children}</SubscriptionContext.Provider>;
}

export function useSubscriptionContext(): SubscriptionValue {
  const ctx = useContext(SubscriptionContext);
  if (!ctx) {
    return {
      ...FREE_SUBSCRIPTION,
      isPremium: false,
      loading: false,
      resolved: true,
      refresh: async () => {},
    };
  }
  return ctx;
}
