import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { buildCsp } from "@/lib/csp";

const PUBLIC_PREFIXES = ["/marketing", "/privacy", "/tos", "/privacy-policy", "/terms-of-service", "/cookie-policy", "/pricing", "/about", "/contact", "/docs", "/version"];
// Auth-adjacent public pages: visible when logged out, redirected home when logged in.
const AUTH_PATHS = ["/login", "/register", "/forgot-password", "/reset-password"];
// Signed-in app routes. Only these bounce a logged-out visitor to /login; any
// other unknown path falls through so the branded 404 page renders instead of a
// redirect that hides the real "page not found" state.
const PROTECTED_PREFIXES = ["/notes", "/capture", "/settings", "/widgets", "/verify-email"];

/**
 * True when the JWT access cookie exists and has not passed its `exp` claim.
 * Middleware cannot verify the signature, but the expiry is enough to tell a
 * live session from a dead cookie that would otherwise trap the user.
 */
function isAccessTokenValid(token: string | undefined): boolean {
  if (!token) return false;
  const payload = token.split(".")[1];
  if (!payload) return false;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "="
    );
    const exp = (JSON.parse(atob(padded)) as { exp?: number }).exp;
    if (typeof exp !== "number") return true;
    return exp * 1000 > Date.now() + 5000;
  } catch {
    return false;
  }
}

/**
 * One nonce per request. Next.js inlines its bootstrap scripts, so a policy
 * without a nonce has to allow `script-src 'unsafe-inline'`; the nonce is what
 * lets production drop it. Development keeps `'unsafe-inline'` (see
 * `lib/csp.ts`) because the dev runtime injects scripts without one.
 */
const IS_PRODUCTION = process.env.NODE_ENV === "production";

function newNonce(): string | undefined {
  if (!IS_PRODUCTION) return undefined;
  const source = globalThis.crypto;
  if (!source || typeof source.randomUUID !== "function") return undefined;
  return source.randomUUID().replace(/-/g, "");
}

/**
 * Attaches the policy to the response and forwards the nonce on the request, so
 * the policy and the markup agree: Next reads the nonce out of the request's
 * `Content-Security-Policy` header when it renders its own scripts.
 */
function withCsp(response: NextResponse, nonce: string | undefined, csp: string): NextResponse {
  response.headers.set("Content-Security-Policy", csp);
  if (nonce) response.headers.set("x-nonce", nonce);
  return response;
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const nonce = newNonce();
  const csp = buildCsp({
    nonce,
    isProd: IS_PRODUCTION,
    uploadedImages: process.env.NEXT_PUBLIC_API_URL,
  });

  const next = (): NextResponse => {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("Content-Security-Policy", csp);
    if (nonce) requestHeaders.set("x-nonce", nonce);
    return NextResponse.next({ request: { headers: requestHeaders } });
  };

  // A session is "present" with EITHER cookie. The access token lives only 15
  // minutes while the refresh token lives 7 days, so keying off access_token
  // alone bounces a perfectly valid session to /login as soon as the short
  // cookie expires (the client silently refreshes on load). That bounce also
  // dropped the query string, which is how a returning OAuth callback lost its
  // ?code=...&state=... before it could be exchanged.
  const accessToken = request.cookies.get("access_token")?.value;
  const refreshToken = request.cookies.get("refresh_token")?.value;
  const hasSession = Boolean(accessToken) || Boolean(refreshToken);

  // The public marketing/start site (landing at "/", plus /marketing/* policies)
  // is visible without signing in.
  const isPublic =
    pathname === "/" ||
    PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));

  if (isPublic) {
    return withCsp(next(), nonce, csp);
  }

  if (AUTH_PATHS.some((p) => pathname.startsWith(p))) {
    // Only a still-valid access token proves a real signed-in session. Keying
    // this bounce off cookie presence alone locked users out: a stale or
    // expired cookie redirected /login back to the landing page forever, so
    // they could never sign in again (browser or desktop app).
    if (isAccessTokenValid(accessToken)) {
      return withCsp(NextResponse.redirect(new URL("/", request.url)), nonce, csp);
    }
    const response = next();
    if (accessToken) {
      // Clear the dead access cookie so the next navigation is unauthenticated.
      response.cookies.delete("access_token");
    }
    return withCsp(response, nonce, csp);
  }

  if (!hasSession && PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    // Carry the destination (and its query string) so signing in returns the
    // visitor to the page they asked for instead of the app home.
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    return withCsp(NextResponse.redirect(loginUrl), nonce, csp);
  }

  return withCsp(next(), nonce, csp);
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icons|icon\\.png|apple-icon\\.png|prysm-icon\\.png|sw\\.js|manifest\\.webmanifest|\\.well-known).*)"],
};
