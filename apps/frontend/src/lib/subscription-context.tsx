"use client";

import { createContext, useContext, type ReactNode } from "react";

import { FREE_SUBSCRIPTION, useSubscription, type SubscriptionValue } from "@/hooks/use-subscription";

const SubscriptionContext = createContext<SubscriptionValue | null>(null);

/**
 * Provides the user's premium entitlement to the tree. Community-safe: the
 * provider works (defaults to free) even when the EE billing endpoint is absent,
 * and the community build simply never mounts the EE gates.
 */
export function SubscriptionProvider({ children }: { children: ReactNode }) {
  const value = useSubscription();
  return <SubscriptionContext.Provider value={value}>{children}</SubscriptionContext.Provider>;
}

export function useSubscriptionContext(): SubscriptionValue {
  const ctx = useContext(SubscriptionContext);
  if (!ctx) {
    return {
      ...FREE_SUBSCRIPTION,
      isPremium: false,
      loading: false,
      refresh: async () => {},
    };
  }
  return ctx;
}
