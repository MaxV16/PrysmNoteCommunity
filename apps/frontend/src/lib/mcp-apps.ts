"use client";

export const MCP_ENDPOINT = "https://prysmnote.com/api/mcp";
export const MCP_TOKEN_PLACEHOLDER = "prysm_live_YOUR_PAT_HERE";

/**
 * The MCP endpoint for the deployment this page is served from.
 *
 * The app is also self-hostable, so settings and docs must show the URL the
 * user is actually on, not the hosted one.
 */
export function mcpEndpointFor(origin?: string): string {
  if (!origin) return MCP_ENDPOINT;
  return `${origin.replace(/\/+$/, "")}/api/mcp`;
}

export interface McpAppConfig {
  id: string;
  name: string;
  description: string;
  file: string;
  kind: "json" | "cli" | "plugin" | "markdown";
  /** "oauth" apps sign in through the browser; "token" apps need a PAT. */
  auth: "oauth" | "token";
  /** JSON string for `type: "http"` configs. */
  json?: string;
  /** CLI command string. */
  command?: string;
  /** Human text for plugin/markdown entries. */
  text?: string;
}

/** A remote server entry with no Authorization header: the client starts OAuth. */
const OAUTH_JSON = (endpoint: string) => `{
  "mcpServers": {
    "prysm": {
      "url": "${endpoint}"
    }
  }
}`;

/** Personal Access Token variant, for clients without OAuth support. */
const TOKEN_JSON = (endpoint: string) => `{
  "mcpServers": {
    "prysm": {
      "type": "http",
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN_PLACEHOLDER}"
      }
    }
  }
}`;

const TOKEN_JSON_ARRAY = (endpoint: string) => `{
  "mcp": [
    {
      "name": "prysm",
      "type": "http",
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN_PLACEHOLDER}"
      }
    }
  ]
}`;

/** Build the per-app catalog for a given endpoint. */
export function buildMcpApps(endpoint: string = MCP_ENDPOINT): McpAppConfig[] {
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      description: "One command in your terminal. The browser opens for sign-in.",
      file: "terminal (claude mcp add)",
      kind: "cli",
      auth: "oauth",
      command: `claude mcp add --transport http prysm ${endpoint}`,
    },
    {
      id: "opencode",
      name: "opencode",
      description: "Add the server to your opencode config, then run opencode.",
      file: "~/.config/opencode/opencode.json",
      kind: "json",
      auth: "oauth",
      json: `{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "prysm": {
      "type": "remote",
      "url": "${endpoint}",
      "enabled": true
    }
  }
}`,
    },
    {
      id: "vscode",
      name: "VS Code (GitHub Copilot)",
      description: "Add it to your workspace, then start the server from the MCP view.",
      file: ".vscode/mcp.json",
      kind: "json",
      auth: "oauth",
      json: `{
  "servers": {
    "prysm": {
      "type": "http",
      "url": "${endpoint}"
    }
  }
}`,
    },
    {
      id: "cursor",
      name: "Cursor",
      description: "Add the server in Cursor settings; it opens the browser on first use.",
      file: "~/.cursor/mcp.json",
      kind: "json",
      auth: "oauth",
      json: `{
  "mcpServers": {
    "prysm": {
      "url": "${endpoint}"
    }
  }
}`,
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      description: "Claude Desktop connects through the mcp-remote bridge, which also handles sign-in.",
      file: "claude_desktop_config.json",
      kind: "json",
      auth: "oauth",
      json: `{
  "mcpServers": {
    "prysm": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "${endpoint}"]
    }
  }
}`,
    },
    {
      id: "kilo",
      name: "Kilo",
      description: "Add the server to the Kilo MCP config.",
      file: "kilo.jsonc",
      kind: "json",
      auth: "oauth",
      json: OAUTH_JSON(endpoint),
    },
    {
      id: "cline",
      name: "Cline",
      description: "Paste the entry into Cline's MCP settings, or paste a token if it asks for one.",
      file: "cline_mcp_settings.json",
      kind: "json",
      auth: "token",
      json: TOKEN_JSON(endpoint),
    },
    {
      id: "roo-code",
      name: "Roo Code",
      description: "Paste the entry into Roo Code's MCP settings.",
      file: "roo_mcp_settings.json",
      kind: "json",
      auth: "token",
      json: TOKEN_JSON(endpoint),
    },
    {
      id: "windsurf",
      name: "Windsurf",
      description: "Windsurf stores user-level MCP config in your home directory.",
      file: "~/.codeium/windsurf/mcp_config.json",
      kind: "json",
      auth: "token",
      json: TOKEN_JSON(endpoint),
    },
    {
      id: "zed",
      name: "Zed",
      description: "Zed configures MCP servers in your settings.json under the \"mcp\" array.",
      file: "settings.json",
      kind: "json",
      auth: "token",
      json: TOKEN_JSON_ARRAY(endpoint),
    },
    {
      id: "jetbrains",
      name: "JetBrains IDEs",
      description: "Add a new HTTP server in Settings > Tools > MCP Client.",
      file: "Settings > Tools > MCP Client",
      kind: "plugin",
      auth: "token",
      text: TOKEN_JSON(endpoint),
    },
    {
      id: "continue",
      name: "Continue.dev",
      description: "Continue loads MCP servers from config.json.",
      file: "~/.continue/config.json",
      kind: "json",
      auth: "token",
      json: TOKEN_JSON(endpoint),
    },
    {
      id: "gemini-cli",
      name: "Gemini CLI",
      description: "Add a Streamable HTTP server with the bearer token.",
      file: "~/.gemini/settings.json",
      kind: "json",
      auth: "token",
      json: TOKEN_JSON(endpoint),
    },
    {
      id: "obsidian",
      name: "Obsidian",
      description: "Install a community MCP plugin (for example MCP Tools) and add this HTTP server.",
      file: "Obsidian community plugin",
      kind: "plugin",
      auth: "token",
      text: TOKEN_JSON(endpoint),
    },
    {
      id: "raycast",
      name: "Raycast",
      description: "The Raycast MCP extension lets you add remote HTTP servers.",
      file: "Raycast MCP extension",
      kind: "plugin",
      auth: "token",
      text: `URL: ${endpoint}\nToken: ${MCP_TOKEN_PLACEHOLDER}`,
    },
  ];
}

/** The hosted defaults, used before the page knows its own origin. */
export const MCP_APPS: McpAppConfig[] = buildMcpApps(MCP_ENDPOINT);

export const MCP_EXAMPLE_PROMPTS = [
  "What tasks do I have tomorrow?",
  "Create a task to call the dentist next Tuesday at 10am.",
  "Is next Wednesday crowded? Check my calendar.",
  "Add Severance to my watchlist.",
  "What have I been watching recently?",
  "Mark the report task as done.",
  "Log today's water habit and tell me my streak.",
];
