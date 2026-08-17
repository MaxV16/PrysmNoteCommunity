"use client";

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";
// Baked at `next build` time (deploy pipelines pass NEXT_PUBLIC_GIT_SHA). Empty
// in local/dev builds, which disables the update banner entirely.
const BAKED_SHA = process.env.NEXT_PUBLIC_GIT_SHA || "";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Compares the deployed backend SHA (from /api/health) against the SHA baked
 * into this frontend build. When they differ, a new version is live and the UI
 * should offer a reload. Polls every 5 minutes while signed in.
 */
export function useAppVersion() {
  const { user } = useAuth();
  const [outdated, setOutdated] = useState(false);

  const check = useCallback(async () => {
    if (!BAKED_SHA) return; // dev build has nothing to compare
    try {
      const res = await fetch(`${API_URL}/health`, { credentials: "include" });
      if (!res.ok) return;
      const data = (await res.json()) as { version?: string | null };
      if (data.version && data.version !== BAKED_SHA) {
        setOutdated(true);
      }
    } catch {
      // Network hiccup — the next poll retries.
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void check();
    const id = setInterval(check, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [user, check]);

  const reload = useCallback(() => {
    window.location.reload();
  }, []);

  return { outdated, reload };
}
