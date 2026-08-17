const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

export const CSRF_HEADER = "X-CSRF-Token";

export function getCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

let ensurePromise: Promise<void> | null = null;

/**
 * Make sure a csrf_token cookie exists before an unsafe (POST/PUT/PATCH/DELETE)
 * request. The backend CSRF middleware sets the cookie as a side effect of the
 * first safe (GET) request, so this issues a bare GET to /auth/me — which is
 * NOT csrf-exempt — when no cookie is present yet. A 401 for a logged-out user
 * is expected and fine (the middleware still sets the cookie on the response).
 *
 * Deliberately does NOT use api.ts (which redirects to /login on 401).
 */
export function ensureCsrf(): Promise<void> {
  if (getCsrfToken()) return Promise.resolve();
  if (ensurePromise) return ensurePromise;
  ensurePromise = (async () => {
    try {
      await fetch(`${API_URL}/auth/me`, { credentials: "include" });
    } catch {
      // Non-fatal: the middleware can still set the cookie during the real
      // request if the network is reachable then.
    } finally {
      ensurePromise = null;
    }
  })();
  return ensurePromise;
}
