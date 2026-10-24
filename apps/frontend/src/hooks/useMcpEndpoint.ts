"use client";

import { useEffect, useState } from "react";

import { MCP_ENDPOINT, mcpEndpointFor } from "@/lib/mcp-apps";

/**
 * The MCP endpoint for the deployment this page runs on.
 *
 * Starts from the hosted default so server and client render the same markup,
 * then switches to `window.location.origin` after mount (self-hosted installs
 * must not tell users to connect to prysmnote.com). The one-frame swap is
 * intentional: reading `window` during render would break hydration.
 */
export function useMcpEndpoint(): string {
  const [endpoint, setEndpoint] = useState(MCP_ENDPOINT);
  useEffect(() => {
    setEndpoint(mcpEndpointFor(window.location.origin));
  }, []);
  return endpoint;
}

export default useMcpEndpoint;
