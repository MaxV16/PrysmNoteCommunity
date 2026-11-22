import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildCsp } from "@/lib/csp";

/**
 * Issues the Content-Security-Policy with a per-request script nonce.
 *
 * Next.js attaches the nonce to its own inline bootstrap scripts only when the
 * policy is on the REQUEST headers, so the header is set both ways: on the
 * request (consumed by the renderer) and on the response (what the browser
 * enforces). Without this the policy had to allow `script-src 'unsafe-inline'`,
 * which defeats the main protection a CSP provides.
 *
 * In development the policy stays permissive: the dev server injects inline
 * HMR scripts that never carry a nonce.
 */
export function middleware(request: NextRequest) {
  const isProd = process.env.NODE_ENV === "production";
  const nonce = isProd ? crypto.randomUUID().replace(/-/g, "") : undefined;
  const csp = buildCsp({ nonce, isProd });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce ?? "");
  if (nonce) requestHeaders.set("content-security-policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Page and API-proxy traffic only. Static assets and images need no policy and
  // would otherwise pay for a function invocation on every file.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
