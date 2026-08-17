import { describe, it, expect, vi, beforeEach } from "vitest";
import { api } from "./api";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(document, "cookie", {
      writable: true,
      value: "csrf_token=test-csrf-token",
    });
  });

  it("sends GET request with correct headers", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: "test" }),
    });

    const result = await api.get("/tasks");
    expect(result).toEqual({ data: "test" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:8000/api/tasks");
    expect(opts.method ?? "GET").toBe("GET");
    expect(opts.credentials).toBe("include");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    // GETs are safe — no CSRF header needed.
    expect(opts.headers["X-CSRF-Token"]).toBeUndefined();
  });

  it("sends POST with JSON body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "1" }),
    });

    const result = await api.post("/tasks", { title: "Test" });
    expect(result).toEqual({ id: "1" });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:8000/api/tasks");
    expect(opts.method).toBe("POST");
    expect(opts.body).toBe(JSON.stringify({ title: "Test" }));
  });

  it("sends X-CSRF-Token on unsafe methods", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: "1" }),
    });

    await api.post("/tasks", { title: "Test" });
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["X-CSRF-Token"]).toBe("test-csrf-token");
  });

  it("primes the csrf cookie via a safe GET before an unsafe request without one", async () => {
    document.cookie = ""; // no csrf cookie yet
    const order: string[] = [];
    mockFetch.mockImplementation(async (url: string, _options?: any) => {
      order.push(url);
      if (url.includes("auth/me")) {
        return { ok: false, status: 401 };
      }
      return { ok: true, json: () => Promise.resolve({ id: "1" }) };
    });

    await api.post("/tasks", { title: "Test" });
    // The priming GET runs first, then the actual POST.
    expect(order[0]).toContain("auth/me");
    expect(order[1]).toContain("/api/tasks");
  });

  it("sends PATCH with JSON body", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ title: "Updated" }),
    });

    const result = await api.patch("/tasks/1", { title: "Updated" });
    expect(result).toEqual({ title: "Updated" });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:8000/api/tasks/1");
    expect(opts.method).toBe("PATCH");
    expect(opts.body).toBe(JSON.stringify({ title: "Updated" }));
  });

  it("sends DELETE request", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ status: "deleted" }),
    });

    const result = await api.delete("/tasks/1");
    expect(result).toEqual({ status: "deleted" });
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("http://localhost:8000/api/tasks/1");
    expect(opts.method).toBe("DELETE");
  });

  it("includes Authorization header when cookie present", async () => {
    document.cookie = "access_token=my-test-token";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: "auth" }),
    });

    await api.get("/tasks");
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["Authorization"]).toBe("Bearer my-test-token");
  });

  it("retries on 401 when refresh succeeds", async () => {
    document.cookie = "access_token=expired-token";

    let callCount = 0;
    mockFetch.mockImplementation(async (url: string, _options?: any) => {
      callCount++;
      if (url.includes("auth/refresh")) {
        return { ok: true };
      }
      if (callCount <= 1) {
        return { ok: false, status: 401, json: () => Promise.resolve({ detail: "Unauthorized" }) };
      }
      return { ok: true, json: () => Promise.resolve({ data: "retried" }) };
    });

    const result = await api.get("/tasks");
    expect(result).toEqual({ data: "retried" });
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("redirects on 401 when refresh fails", async () => {
    document.cookie = "access_token=expired-token";
    const originalLocation = window.location;
    // @ts-expect-error - mocking location
    delete window.location;
    window.location = { href: "" } as any;

    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ detail: "Unauthorized" }),
    });

    await expect(api.get("/tasks")).rejects.toThrow("Session expired");
    expect(window.location.href).toBe("/login");

    window.location.href = originalLocation.href;
  });

  it("throws on non-ok response with detail", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ detail: "Validation error" }),
    });

    await expect(api.get("/tasks")).rejects.toThrow("Validation error");
  });

  it("throws on non-ok response with status text fallback", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.reject(new Error("parse failed")),
    });

    await expect(api.get("/tasks")).rejects.toThrow("Internal Server Error");
  });

  it("throws descriptive error when fetch fails (network down)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Failed to fetch"));

    await expect(api.get("/tasks")).rejects.toThrow(
      "Cannot reach server at http://localhost:8000/api. Is the backend running?"
    );
  });
});
