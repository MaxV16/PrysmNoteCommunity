import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

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

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
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
    return NextResponse.next();
  }

  if (AUTH_PATHS.some((p) => pathname.startsWith(p))) {
    // Only a still-valid access token proves a real signed-in session. Keying
    // this bounce off cookie presence alone locked users out: a stale or
    // expired cookie redirected /login back to the landing page forever, so
    // they could never sign in again (browser or desktop app).
    if (isAccessTokenValid(accessToken)) {
      return NextResponse.redirect(new URL("/", request.url));
    }
    const response = NextResponse.next();
    if (accessToken) {
      // Clear the dead access cookie so the next navigation is unauthenticated.
      response.cookies.delete("access_token");
    }
    return response;
  }

  if (!hasSession && PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    // Carry the destination (and its query string) so signing in returns the
    // visitor to the page they asked for instead of the app home.
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icons|icon\\.png|apple-icon\\.png|prysm-icon\\.png|sw\\.js|manifest\\.webmanifest|\\.well-known).*)"],
};
