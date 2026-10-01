"use client";

import { CodeBlock } from "@/components/mcp/CodeBlock";
import { MCP_APPS, MCP_TOKEN_PLACEHOLDER } from "@/lib/mcp-apps";

export function McpAppGrid() {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {MCP_APPS.map((app) => (
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
      <p className="text-xs text-muted md:col-span-2">
        Replace{" "}
        <code className="rounded bg-base px-1 text-[10px]">{MCP_TOKEN_PLACEHOLDER}</code> with a
        token you create below.
      </p>
    </div>
  );
}

export default McpAppGrid;
