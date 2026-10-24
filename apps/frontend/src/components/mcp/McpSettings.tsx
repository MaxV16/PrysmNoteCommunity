"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { CodeBlock } from "@/components/mcp/CodeBlock";
import { McpAppGrid } from "@/components/mcp/McpAppGrid";
import { useMcpEndpoint } from "@/hooks/useMcpEndpoint";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  created_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function McpSettings() {
  const { showToast } = useToast();
  const endpoint = useMcpEndpoint();
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<{ plaintext: string; id: string } | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const loadTokens = useCallback(async () => {
    try {
      const data = await api.get<{ tokens: ApiToken[] }>("/tokens");
      setTokens(data.tokens.filter((t) => !t.revoked_at));
    } catch {
      setMsg({ text: "Could not load tokens.", ok: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTokens();
  }, [loadTokens]);

  const handleCreate = async () => {
    setCreating(true);
    setMsg(null);
    try {
      const data = await api.post<{ plaintext: string; id: string; name: string }>("/tokens", {
        name: name.trim() || "MCP token",
      });
      setCreatedToken({ plaintext: data.plaintext, id: data.id });
      setName("");
      await loadTokens();
    } catch {
      setMsg({ text: "Could not create the token.", ok: false });
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (token: ApiToken) => {
    if (!window.confirm(`Revoke "${token.name}"? Apps using it will lose access.`)) return;
    try {
      await api.delete(`/tokens/${token.id}`);
      await loadTokens();
      showToast("Token revoked", "success");
    } catch {
      setMsg({ text: "Could not revoke the token.", ok: false });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-primary">AI Connect (MCP)</h2>
        <p className="text-sm text-muted">
          Connect external AI apps (Claude Code, opencode, VS Code, Cursor, Claude, Kilo, ...) to
          your tasks, watchlist and habits over the Model Context Protocol. Most apps sign in
          through the browser, so there is no token to copy.
        </p>
        <Link href="/docs" className="mt-1 inline-block text-xs text-accent hover:underline">
          Full setup guides and docs
        </Link>
      </div>

      {msg && (
        <div
          className={`rounded-xl px-4 py-2.5 text-sm border ${
            msg.ok
              ? "bg-success/10 border-success/20 text-success"
              : "bg-danger/10 border-danger/20 text-danger"
          }`}
        >
          {msg.text}
        </div>
      )}

      {createdToken && (
        <div className="rounded-xl border border-accent/30 bg-accent/10 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-accent">Your new token (shown once)</p>
              <p className="mt-0.5 text-xs text-secondary">
                Copy it now. For security it is never shown again.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCreatedToken(null)}
              aria-label="Dismiss token"
              className="shrink-0 rounded-lg px-1.5 py-1 text-secondary hover:text-primary"
            >
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <CodeBlock code={createdToken.plaintext} />
        </div>
      )}

      <div className="rounded-xl bg-elevated border border-border p-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-xs font-medium text-secondary">Server URL</p>
          <Link href="/docs" className="text-[11px] text-accent hover:underline">
            Setup guides
          </Link>
        </div>
        <CodeBlock code={endpoint} compact />
        <p className="mt-2 text-xs text-muted">
          Paste this one URL into your AI app. The first request opens a sign-in tab: choose
          Allow access once and you land back in the app, already connected.
        </p>
      </div>

      <details className="card p-6">
        <summary className="cursor-pointer list-none">
          <span className="text-sm font-semibold text-primary">How it works</span>
          <span className="mt-1 block text-xs text-muted">
            One URL, one browser approval, no token to manage.
          </span>
        </summary>
        <ol className="mt-4 space-y-3 text-sm text-secondary">
          <li className="flex gap-2">
            <span className="text-muted">1.</span>
            <span>Add the server URL above to your AI app (exact configs are below).</span>
          </li>
          <li className="flex gap-2">
            <span className="text-muted">2.</span>
            <span>
              Use the app. A browser tab opens on Prysm Note: sign in and choose Allow access.
            </span>
          </li>
          <li className="flex gap-2">
            <span className="text-muted">3.</span>
            <span>
              You are returned to the app automatically and it stays connected, refreshing on its
              own. Revoke access any time below or from this page.
            </span>
          </li>
        </ol>
        <p className="mt-3 text-xs text-muted">
          Apps without browser sign-in accept a Personal Access Token instead. Claude Code,
          opencode, VS Code, Cursor, Claude Desktop and Kilo use the browser flow.
        </p>
        <Link href="/docs" className="mt-4 inline-block text-xs text-accent hover:underline">
          Full setup guides and docs
        </Link>
      </details>

      <section className="card p-6 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-primary">App configurations</h3>
          <p className="text-xs text-muted">
            Copy-paste for your app. Start with the browser sign-in group; a token is only needed
            for apps that cannot do OAuth.
          </p>
        </div>
        <McpAppGrid endpoint={endpoint} />
      </section>

      <section className="card p-6 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-primary">Personal Access Tokens</h3>
          <p className="text-xs text-muted">
            Only needed for apps without browser sign-in. One token per app is best, so you can
            revoke them individually.
          </p>
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Token name"
              maxLength={80}
              className="input-field w-full"
            />
            <p className="mt-1 text-[11px] text-muted">Give it the name of the app you connect.</p>
          </div>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            className="btn btn-gradient px-4 py-2 text-sm rounded-xl disabled:opacity-50 shrink-0"
          >
            {creating ? "Creating..." : "Create token"}
          </button>
        </div>

        {loading ? (
          <p className="text-sm text-muted">Loading tokens...</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted">No tokens yet. Create one to connect an AI app.</p>
        ) : (
          <div className="space-y-2">
            {tokens.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between rounded-xl bg-elevated border border-border px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-primary">
                    {t.name} <span className="text-muted">{t.prefix}...</span>
                  </p>
                  <p className="text-[11px] text-muted">
                    Created {t.created_at ? new Date(t.created_at).toLocaleDateString() : "unknown"}
                    {t.last_used_at
                      ? ` - last used ${new Date(t.last_used_at).toLocaleDateString()}`
                      : " - never used"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleRevoke(t)}
                  className="btn bg-elevated border border-border text-xs text-danger px-3 py-1.5 rounded-lg hover:bg-danger/10 shrink-0"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default McpSettings;
