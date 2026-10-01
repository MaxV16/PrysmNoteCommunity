import { describe, it, expect, vi } from "vitest";
import type { NextRequest } from "next/server";

// The middleware builds real NextResponse values, which need the edge/Web
// Response globals. A tiny stand-in keeps this a pure unit test of the routing
// decisions (status + redirect destination) with no Next runtime.
vi.mock("next/server", () => {
  class MockNextResponse {
    cookies = { delete: (_name: string) => {} };
    constructor(
      public status: number,
      public location: string | null,
    ) {}
    static next() {
      return new MockNextResponse(200, null);
    }
    static redirect(url: URL) {
      return new MockNextResponse(307, url.toString());
    }
  }
  return { NextResponse: MockNextResponse };
});

const { middleware } = await import("./middleware");

type Cookies = Record<string, string>;

function makeRequest(path: string, cookies: Cookies = {}): NextRequest {
  const url = new URL(`https://prysmnote.com${path}`);
  return {
    url: url.toString(),
    nextUrl: url,
    cookies: {
      get: (name: string) => (name in cookies ? { name, value: cookies[name] } : undefined),
    },
  } as unknown as NextRequest;
}

function redirectLocation(res: unknown): string | null {
  return (res as { location: string | null }).location;
}

/** Minimal JWT-shaped token carrying just an `exp` (seconds since epoch). */
function jwt(expSeconds: number): string {
  const payload = btoa(JSON.stringify({ exp: expSeconds }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `header.${payload}.signature`;
}

describe("middleware session handling", () => {
  it("does not bounce /settings when only the refresh token is present", () => {
    // The access token expires after 15 minutes while the refresh token lives
    // for 7 days. Keying off access_token alone sent a valid session to /login,
    // which dropped the ?code=... from a returning OAuth callback.
    const res = middleware(makeRequest("/settings", { refresh_token: "r" }));
    expect(redirectLocation(res)).toBeNull();
  });

  it("does not bounce /settings when the access token is present", () => {
    const res = middleware(makeRequest("/settings", { access_token: "a" }));
    expect(redirectLocation(res)).toBeNull();
  });

  it("preserves the full destination when bouncing a logged-out visitor", () => {
    const res = middleware(makeRequest("/settings?code=abc&state=github%3Axyz"));
    expect(redirectLocation(res)).toBe(
      "https://prysmnote.com/login?next=%2Fsettings%3Fcode%3Dabc%26state%3Dgithub%253Axyz",
    );
  });

  it("sends a visitor with a live session away from the auth pages", () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const res = middleware(makeRequest("/login", { access_token: jwt(future) }));
    expect(redirectLocation(res)).toBe("https://prysmnote.com/");
  });

  it("serves the login page when the access token is stale", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const res = middleware(makeRequest("/login", { access_token: jwt(past) }));
    expect(redirectLocation(res)).toBeNull();
  });

  it("serves the login page when only a refresh token is left", () => {
    const res = middleware(makeRequest("/login", { refresh_token: "r" }));
    expect(redirectLocation(res)).toBeNull();
  });

  it("leaves public pages alone", () => {
    for (const path of ["/", "/marketing/changelog", "/pricing"]) {
      expect(redirectLocation(middleware(makeRequest(path)))).toBeNull();
    }
  });
});
