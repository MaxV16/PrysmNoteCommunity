"use client";

import { useMemo } from "react";

import { CodeBlock } from "@/components/mcp/CodeBlock";
import { MCP_ENDPOINT, MCP_TOKEN_PLACEHOLDER, buildMcpApps } from "@/lib/mcp-apps";

function signInSteps(endpoint: string): string {
  let host = "prysmnote.com";
  try {
    host = new URL(endpoint).host;
  } catch {
    // Keep the hosted default when the endpoint is not a full URL.
  }
  return `Your app opens ${host}. Sign in, choose Allow access, and you land back in the app, connected.`;
}

interface McpAppGridProps {
  endpoint?: string;
}

export function McpAppGrid({ endpoint = MCP_ENDPOINT }: McpAppGridProps) {
  const apps = useMemo(() => buildMcpApps(endpoint), [endpoint]);
  const oauthApps = apps.filter((app) => app.auth === "oauth");
  const tokenApps = apps.filter((app) => app.auth === "token");

  const cards = (list: typeof apps) => (
    <div className="grid gap-3 md:grid-cols-2">
      {list.map((app) => (
        <details
          key={app.id}
          className="group rounded-xl border border-border bg-elevated p-4 transition-colors hover:border-accent/30"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2">
            <span className="min-w-0">
              <span className="block truncate text-sm text-secondary">{app.name}</span>
              <span className="block truncate text-[10px] text-muted">{app.file}</span>
            </span>
            <svg
              className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m6 9 6 6 6-6" />
            </svg>
          </summary>
          <p className="mt-2 text-xs text-muted">{app.description}</p>
          {app.kind === "cli" && app.command ? (
            <CodeBlock code={app.command} compact />
          ) : app.kind === "json" && app.json ? (
            <CodeBlock code={app.json} compact />
          ) : (
            <CodeBlock code={app.text ?? ""} compact />
          )}
        </details>
      ))}
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-xs font-semibold text-primary">Sign in with your browser</h4>
          <span className="badge text-[10px]">No token to copy</span>
        </div>
        <p className="mt-1 text-xs text-muted">
          Paste the config for your app and use it. The first request opens a sign-in tab:
          approve it once and the app reconnects on its own from then on.
        </p>
        <div className="mt-3">{cards(oauthApps)}</div>
        <p className="mt-2 text-[11px] text-muted">{signInSteps(endpoint)}</p>
      </div>

      <div>
        <h4 className="text-xs font-semibold text-primary">Apps that ask for a token</h4>
        <p className="mt-1 text-xs text-muted">
          Create a token below, then replace{" "}
          <code className="rounded bg-base px-1 text-[10px]">{MCP_TOKEN_PLACEHOLDER}</code>.
          Many of these also offer a browser sign-in, so try the URL alone first if the app
          supports remote servers.
        </p>
        <div className="mt-3">{cards(tokenApps)}</div>
      </div>
    </div>
  );
}

export default McpAppGrid;
