import { describe, expect, it } from "vitest";
import { buildCsp } from "./csp";

describe("buildCsp", () => {
  it("issues a nonce script-src with no unsafe-inline in production", () => {
    const csp = buildCsp({ nonce: "abc123", isProd: true });
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic' https://static.cloudflareinsights.com");
    expect(csp).not.toContain("'unsafe-inline' https://static.cloudflareinsights.com");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("never allows unsafe-inline for scripts in production, even without a nonce", () => {
    const csp = buildCsp({ nonce: undefined, isProd: true });
    const scriptSrc = csp.split("; ").find((part) => part.startsWith("script-src"));
    expect(scriptSrc).toBe("script-src 'self' https://static.cloudflareinsights.com");
    expect(scriptSrc).not.toContain("unsafe-inline");
    expect(scriptSrc).not.toContain("unsafe-eval");
  });

  it("keeps the permissive dev policy the dev server needs", () => {
    const csp = buildCsp({ nonce: undefined, isProd: false });
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(csp).toContain("http://localhost:8000");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("adds the uploaded-image origin and keeps the rest of the policy intact", () => {
    const csp = buildCsp({ nonce: "n", isProd: true, uploadedImages: "https://api.example.com" });
    expect(csp).toContain("img-src 'self' data: blob: https://image.tmdb.org https://www.themoviedb.org https://api.example.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
  });
});
