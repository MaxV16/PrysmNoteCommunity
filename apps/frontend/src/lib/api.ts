const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

import { ensureCsrf, getCsrfToken, CSRF_HEADER } from "./csrf";

let refreshPromise: Promise<boolean> | null = null;

async function doRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    return res.ok;
  } catch {
    return false;
  }
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
    throw new Error(`Cannot reach server at ${API_URL}. Is the backend running?`);
  });

  if (res.status === 401 && !_retried) {
    if (!refreshPromise) {
      refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
    }
    const refreshed = await refreshPromise;
    if (refreshed) {
      return request<T>(path, options, true);
    }
    window.location.href = "/login";
    throw new Error("Session expired");
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
        message = res.statusText || "Request failed";
      }
    } catch {
      message = res.statusText || "Request failed";
    }
    throw new Error(message);
  }

  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
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
