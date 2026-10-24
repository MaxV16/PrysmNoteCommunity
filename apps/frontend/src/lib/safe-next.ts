/**
 * Post-login destination handling for the sign-in page.
 *
 * The MCP OAuth `authorize` endpoint bounces a signed-out user to
 * `/login?next=<authorize request>`. That `next` must survive sign-in without
 * ever becoming an open redirect, so only same-site paths are accepted. An
 * absolute URL on the SAME origin is normalized to its path + query for
 * compatibility with authorize responses that built the URL themselves (that
 * absolute form used to be dropped, silently abandoning the MCP connection).
 */

const FALLBACK = "/";

export function safeNextDestination(
  raw: string | null | undefined,
  currentOrigin?: string
): string {
  if (!raw) return FALLBACK;
  const value = raw.trim();
  if (!value) return FALLBACK;
  // Protocol-relative and backslash tricks are never same-site paths.
  if (value.startsWith("//") || value.startsWith("/\\")) return FALLBACK;
  if (value.startsWith("/")) return value;
  if (!/^https?:\/\//i.test(value)) return FALLBACK;
  // An absolute URL is only usable when it points at this exact origin.
  if (!currentOrigin) return FALLBACK;
  try {
    const url = new URL(value);
    if (url.origin !== currentOrigin) return FALLBACK;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return FALLBACK;
  }
}

/** Read `?next=` from a query string and normalize it. */
export function nextFromSearch(search: string, currentOrigin?: string): string {
  const raw = new URLSearchParams(search).get("next");
  return safeNextDestination(raw, currentOrigin);
}

/**
 * Paths served by the backend (`/api/...`), not by the Next.js router. A
 * client-side `router.push` there tries to fetch a React payload from an API
 * route, so these need a full navigation.
 */
export function needsFullNavigation(path: string): boolean {
  return path.startsWith("/api/") || path.startsWith("/.well-known/");
}
