"use client";

export const MCP_ENDPOINT = "https://prysmnote.com/api/mcp";
export const MCP_TOKEN_PLACEHOLDER = "prysm_live_YOUR_PAT_HERE";

export interface McpAppConfig {
  id: string;
  name: string;
  description: string;
  file: string;
  kind: "json" | "cli" | "plugin" | "markdown";
  /** JSON string for `type: "http"` configs; the Authorization header uses MCP_TOKEN_PLACEHOLDER. */
  json?: string;
  /** CLI command string. */
  command?: string;
  /** Human text for plugin/markdown entries. */
  text?: string;
}

const JSON_TEMPLATE = `{
  "mcpServers": {
    "prysm": {
      "type": "http",
      "url": "${MCP_ENDPOINT}",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN_PLACEHOLDER}"
      }
    }
  }
}`;

const JSON_ARRAY_TEMPLATE = `{
  "mcp": [
    {
      "name": "prysm",
      "type": "http",
      "url": "${MCP_ENDPOINT}",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN_PLACEHOLDER}"
      }
    }
  ]
}`;

const JSON_BODY_TEMPLATE = `{
  "mcpServers": {
    "prysm": {
      "type": "http",
      "url": "${MCP_ENDPOINT}",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN_PLACEHOLDER}"
      }
    }
  }
}`;

export const MCP_APPS: McpAppConfig[] = [
  {
    id: "vscode",
    name: "VS Code (GitHub Copilot MCP)",
    description: "Add the server to your workspace so GitHub Copilot can read and update tasks.",
    file: ".vscode/mcp.json",
    kind: "json",
    json: JSON_TEMPLATE,
  },
  {
    id: "cursor",
    name: "Cursor",
    description: "Cursor reads MCP servers from the project settings file.",
    file: ".cursor/mcp.json",
    kind: "json",
    json: JSON_TEMPLATE,
  },
  {
    id: "windsurf",
    name: "Windsurf",
    description: "Windsurf stores user-level MCP config in your home directory.",
    file: "~/.codeium/windsurf/mcp_config.json",
    kind: "json",
    json: JSON_TEMPLATE,
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    description: "Add the server to the Claude Desktop app config to let Claude use your tasks.",
    file: "claude_desktop_config.json",
    kind: "json",
    json: JSON_TEMPLATE,
  },
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Register the server with the Claude Code CLI in your terminal.",
    file: "terminal (claude mcp add)",
    kind: "cli",
    command: `claude mcp add --transport http prysm ${MCP_ENDPOINT} --header "Authorization: Bearer ${MCP_TOKEN_PLACEHOLDER}"`,
  },
  {
    id: "zed",
    name: "Zed",
    description: "Zed configures MCP servers in your settings.json under the \"mcp\" array.",
    file: "settings.json",
    kind: "json",
    json: JSON_ARRAY_TEMPLATE,
  },
  {
    id: "jetbrains",
    name: "JetBrains IDEs",
    description: "IntelliJ, PyCharm and WebStorm use the MCP Client plugin. Add a new HTTP server in Settings > Tools > MCP Client.",
    file: "Settings > Tools > MCP Client",
    kind: "plugin",
    text: JSON_BODY_TEMPLATE,
  },
  {
    id: "continue",
    name: "Continue.dev",
    description: "Continue loads MCP servers from config.json (the legacy mcpServers shape is still honored).",
    file: "~/.continue/config.json",
    kind: "json",
    json: JSON_TEMPLATE,
  },
  {
    id: "cline",
    name: "Cline",
    description: "Cline stores MCP servers in its settings file; paste the HTTP server entry.",
    file: "cline_mcp_settings.json",
    kind: "json",
    json: JSON_TEMPLATE,
  },
  {
    id: "roo-code",
    name: "Roo Code",
    description: "Roo Code stores MCP servers in its settings file; paste the HTTP server entry.",
    file: "roo_mcp_settings.json",
    kind: "json",
    json: JSON_TEMPLATE,
  },
  {
    id: "kilo",
    name: "Kilo",
    description: "Kilo loads MCP servers from its project config file.",
    file: "kilo.json",
    kind: "json",
    json: JSON_TEMPLATE,
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    description: "Gemini CLI accepts MCP servers through its settings. Add a Streamable HTTP server with the bearer token.",
    file: "~/.gemini/settings.json",
    kind: "json",
    json: JSON_TEMPLATE,
  },
  {
    id: "obsidian",
    name: "Obsidian",
    description: "Install a community MCP plugin (for example MCP Tools) and add this HTTP server.",
    file: "Obsidian community plugin",
    kind: "plugin",
    text: JSON_TEMPLATE,
  },
  {
    id: "raycast",
    name: "Raycast",
    description: "The Raycast MCP extension lets you add remote HTTP servers. Paste the URL and token.",
    file: "Raycast MCP extension",
    kind: "plugin",
    text: `URL: ${MCP_ENDPOINT}\nToken: ${MCP_TOKEN_PLACEHOLDER}`,
  },
];

export const MCP_EXAMPLE_PROMPTS = [
  "What tasks do I have tomorrow?",
  "Create a task to call the dentist next Tuesday at 10am.",
  "Is next Wednesday crowded? Check my calendar.",
  "Add Severance to my watchlist.",
  "What have I been watching recently?",
  "Mark the report task as done.",
  "Log today's water habit and tell me my streak.",
];
