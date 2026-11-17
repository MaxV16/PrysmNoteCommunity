"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useSubscriptionContext } from "@/lib/subscription-context";

/**
 * Vault settings.
 *
 * The vault had no settings surface at all, so semantic search, the note
 * counters and the premium state were only discoverable by opening the vault
 * itself. This panel is read-mostly on purpose: the switches that matter
 * (search mode, note editing, import/export) belong in the workspace where you
 * can see the result, and duplicating them here would give two sources of
 * truth. What it does is answer "is semantic search working, and why not".
 */

interface VaultStats {
  notes: number;
  links: number;
  tags: number;
  templates: number;
  embedded_chunks: number;
  semantic_search: boolean;
  caps?: { notes?: number };
}

function formatCount(value: number | undefined, cap?: number): string {
  if (typeof value !== "number") return "-";
  return cap ? `${value.toLocaleString()} of ${cap.toLocaleString()}` : value.toLocaleString();
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-xs text-secondary">{label}</span>
      <span className="text-xs font-medium text-primary tabular-nums">{value}</span>
    </div>
  );
}

export function VaultSettings() {
  const { isPremium, resolved } = useSubscriptionContext();
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "locked" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await api.get<VaultStats>("/vault/stats");
        if (cancelled) return;
        setStats(data);
        setState("ready");
      } catch (err) {
        if (cancelled) return;
        setState((err as { status?: number } | null)?.status === 402 ? "locked" : "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const locked = state === "locked" || (resolved && !isPremium);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-primary">Vault</h2>
        <p className="text-sm text-muted">
          Notes that live beside your tasks, with links, backlinks and search.
        </p>
      </div>

      {locked ? (
        <section className="border-t border-border/60 pt-4">
          <p className="text-sm font-semibold text-primary">The Vault is a Premium feature</p>
          <p className="mt-1 max-w-prose text-xs text-secondary">
            Notes, backlinks and semantic search are included with Premium on this hosted
            instance. Self-hosted instances get the same vault for free.
          </p>
          <a
            href="/settings?tab=premium"
            className="btn btn-gradient mt-3 inline-flex rounded-full px-3.5 py-1.5 text-xs"
          >
            See plans
          </a>
        </section>
      ) : (
        <>
          <section className="border-t border-border/60 pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
              Semantic search
            </h3>
            {state === "loading" ? (
              <p className="mt-2 text-xs text-secondary">Checking the vault...</p>
            ) : state === "error" ? (
              <p className="mt-2 text-xs text-danger">
                Could not read the vault right now. Open the vault and try again.
              </p>
            ) : (
              <>
                <div className="mt-1.5 flex items-center gap-2">
                  <span
                    aria-hidden
                    className={`h-1.5 w-1.5 rounded-full ${
                      stats?.semantic_search ? "bg-success" : "bg-warning"
                    }`}
                  />
                  <span className="text-sm text-primary">
                    {stats?.semantic_search ? "On" : "Off"}
                  </span>
                  <span className="text-xs text-muted">
                    {stats?.semantic_search
                      ? `${formatCount(stats.embedded_chunks)} passages embedded`
                      : "no AI provider key"}
                  </span>
                </div>
                <p className="mt-1.5 max-w-prose text-xs text-secondary">
                  {stats?.semantic_search
                    ? "Notes are embedded as you write them, so a search can match what a note means rather than the exact words it uses. Text search always works in parallel."
                    : "Semantic search needs an AI provider key, because the note text is embedded through your provider. Until you add one, the vault searches text only: titles, bodies and tags. Add a key under AI provider keys and notes saved afterwards become searchable by meaning."}
                </p>
              </>
            )}
          </section>

          <section className="border-t border-border/60 pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
              In this vault
            </h3>
            <div className="mt-1 divide-y divide-border/40">
              <Row label="Notes" value={formatCount(stats?.notes, stats?.caps?.notes)} />
              <Row label="Links" value={formatCount(stats?.links)} />
              <Row label="Tags" value={formatCount(stats?.tags)} />
              <Row label="Templates" value={formatCount(stats?.templates)} />
              <Row label="Embedded passages" value={formatCount(stats?.embedded_chunks)} />
            </div>
          </section>

          <section className="border-t border-border/60 pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">
              Where things live
            </h3>
            <p className="mt-1.5 max-w-prose text-xs text-secondary">
              Writing, search modes, export and import all live in the workspace itself. Open{" "}
              <span className="text-primary">Vault</span> from the sidebar to switch between Text
              and Semantic search, export your notes as JSON, or import a previous export. Search
              and capture are also available to the assistant and to AI Connect clients.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
