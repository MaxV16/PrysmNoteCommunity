const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

import { ensureCsrf, getCsrfToken, CSRF_HEADER } from "./csrf";

let refreshPromise: Promise<RefreshOutcome> | null = null;

/**
 * Outcome of a token refresh. `unauthenticated` means the server explicitly
 * rejected the refresh cookie (the session is really over); `transient` covers a
 * network error, a 5xx or a 429 - a deploy-window blip that must NOT sign the
 * user out.
 */
type RefreshOutcome = "ok" | "unauthenticated" | "transient";

async function doRefresh(): Promise<RefreshOutcome> {
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (res.ok) return "ok";
    if (res.status === 401 || res.status === 403) return "unauthenticated";
    return "transient";
  } catch {
    return "transient";
  }
}

function statusFallback(res: Response): string {
  // Edge/proxy errors return HTML (or nothing) instead of our JSON envelope, so
  // the generic fallback is all the user would otherwise see.
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    return "The server was unavailable or the request took too long. Please try again.";
  }
  if (res.status >= 500) {
    return `Server error (${res.status}). Please try again.`;
  }
  return res.statusText || "Request failed";
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  _retried = false
): Promise<T> {
  const method = (options.method || "GET").toUpperCase();
  // Unsafe requests need the double-submit header; make sure the cookie exists
  // first (the middleware sets it on the response of a safe GET).
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    await ensureCsrf();
  }

  // Multipart bodies must NOT carry a Content-Type header: the browser sets the
  // boundary itself, and forcing application/json would make the backend reject
  // the file upload.
  const isFormData =
    typeof FormData !== "undefined" && options.body instanceof FormData;

  const headers: Record<string, string> = {
    ...((options.headers as Record<string, string>) || {}),
  };
  if (!isFormData && !("Content-Type" in headers)) {
    headers["Content-Type"] = "application/json";
  }

  // Auth is cookie-based (HttpOnly access_token + refresh_token); the cookie is
  // never readable from JS, so there is no Authorization header to attach (L2).
  const csrf = getCsrfToken();
  if (csrf && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    headers[CSRF_HEADER] = csrf;
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
    credentials: "include",
  }).catch((err) => {
    console.error(`[API] Failed to connect to ${API_URL}${path}:`, err);
    const isOnline = typeof navigator !== "undefined" ? navigator.onLine : true;
    const message = isOnline
      ? `Cannot reach server at ${API_URL}. Is the backend running?`
      : "Not connected to the internet. Please connect and try again.";
    throw new Error(message);
  });

  if (res.status === 401 && !_retried) {
    if (!refreshPromise) {
      refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
    }
    const refreshed = await refreshPromise;
    if (refreshed === "ok") {
      return request<T>(path, options, true);
    }
    if (refreshed === "unauthenticated") {
      // Preserve the current URL so a deep-linked flow (an integration connect
      // handed to the system browser, or a returning OAuth callback) resumes
      // after sign-in instead of dropping its query string. Same-site only; the
      // login page re-validates and never leaves the app.
      const here =
        typeof window !== "undefined" && window.location.pathname
          ? `${window.location.pathname}${window.location.search || ""}`
          : "";
      const target =
        here && !here.startsWith("/login") && !here.startsWith("/register")
          ? `/login?next=${encodeURIComponent(here)}`
          : "/login";
      window.location.href = target;
      throw new Error("Session expired");
    }
    // Transient refresh failure (backend restarting, 5xx, offline): keep the
    // session and surface a retryable error instead of a forced re-login.
    throw new Error(
      "The server was unavailable or the request took too long. Please try again."
    );
  }

  if (!res.ok) {
    let message: string;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") {
        message = body.detail;
      } else if (Array.isArray(body?.detail) && body.detail.length > 0) {
        // FastAPI validation errors: pick the first field message.
        const first = body.detail[0];
        message = first?.msg || String(first) || "Request failed";
      } else if (typeof body?.message === "string") {
        message = body.message;
      } else {
        message = statusFallback(res);
      }
    } catch {
      // A non-JSON body (an edge/proxy error page, an HTML 502/504) lands here;
      // "Request failed" alone tells the user nothing actionable.
      message = statusFallback(res);
    }
    throw new Error(message);
  }

  // 204 No Content: no body to parse (countdown delete, PAT revoke, etc).
  if (res.status === 204) return undefined as T;
  // Some endpoints return 200 with an empty body; treat same as 204.
  if (res.status === 200 && res.headers.get("content-length") === "0") return undefined as T;
  return res.json();
}

// In-flight GET coalescing: several components often request the same resource
// at the same moment (mount + focus + realtime refresh). Sharing the single
// promise avoids duplicate network round trips and duplicate JSON parsing.
const inflightGets = new Map<string, Promise<unknown>>();

function dedupedGet<T>(path: string): Promise<T> {
  const existing = inflightGets.get(path);
  if (existing) return existing as Promise<T>;
  const promise = request<T>(path).finally(() => {
    if (inflightGets.get(path) === promise) {
      inflightGets.delete(path);
    }
  });
  inflightGets.set(path, promise);
  return promise;
}

export const api = {
  get: <T>(path: string) => dedupedGet<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  // Multipart upload for endpoints that take a file. The browser sets the
  // multipart Content-Type + boundary; do not use post() here (it forces JSON).
  upload: <T>(path: string, formData: FormData) =>
    request<T>(path, { method: "POST", body: formData }),
};
