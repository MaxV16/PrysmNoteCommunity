import { describe, expect, it } from "vitest";

import { needsFullNavigation, nextFromSearch, safeNextDestination } from "./safe-next";

const ORIGIN = "https://prysmnote.com";

describe("safeNextDestination", () => {
  it("keeps a same-site path and its query string", () => {
    expect(safeNextDestination("/settings?tab=mcp")).toBe("/settings?tab=mcp");
    expect(
      safeNextDestination("/api/ee/mcp-oauth/authorize?client_id=abc&state=xyz")
    ).toBe("/api/ee/mcp-oauth/authorize?client_id=abc&state=xyz");
  });

  it("converts a same-origin absolute URL to path and query", () => {
    // This is what /authorize used to send, and the login page dropped it,
    // abandoning the MCP connection after sign-in.
    expect(
      safeNextDestination(
        "https://prysmnote.com/api/ee/mcp-oauth/authorize?client_id=abc&state=xyz",
        ORIGIN
      )
    ).toBe("/api/ee/mcp-oauth/authorize?client_id=abc&state=xyz");
  });

  it("rejects every other origin and unsafe scheme", () => {
    expect(safeNextDestination("https://evil.example/steal", ORIGIN)).toBe("/");
    expect(safeNextDestination("https://prysmnote.com.evil.example/x", ORIGIN)).toBe("/");
    expect(safeNextDestination("http://prysmnote.com/x", ORIGIN)).toBe("/");
    expect(safeNextDestination("//evil.example/x", ORIGIN)).toBe("/");
    expect(safeNextDestination("/\\evil.example/x", ORIGIN)).toBe("/");
    expect(safeNextDestination("javascript:alert(1)", ORIGIN)).toBe("/");
    expect(safeNextDestination("settings", ORIGIN)).toBe("/");
    expect(safeNextDestination("", ORIGIN)).toBe("/");
    expect(safeNextDestination(null, ORIGIN)).toBe("/");
  });

  it("refuses an absolute URL when the origin is unknown", () => {
    expect(safeNextDestination("https://prysmnote.com/x")).toBe("/");
  });
});

describe("nextFromSearch", () => {
  it("decodes the next parameter", () => {
    const search = `?next=${encodeURIComponent("/api/ee/mcp-oauth/authorize?client_id=abc")}`;
    expect(nextFromSearch(search, ORIGIN)).toBe("/api/ee/mcp-oauth/authorize?client_id=abc");
  });

  it("honors an encoded same-origin absolute URL", () => {
    const search = `?next=${encodeURIComponent("https://prysmnote.com/settings?tab=mcp")}`;
    expect(nextFromSearch(search, ORIGIN)).toBe("/settings?tab=mcp");
  });

  it("falls back to / when next is missing or foreign", () => {
    expect(nextFromSearch("", ORIGIN)).toBe("/");
    expect(nextFromSearch(`?next=${encodeURIComponent("https://evil.example")}`, ORIGIN)).toBe("/");
  });
});

describe("needsFullNavigation", () => {
  it("sends backend paths through the browser, not the app router", () => {
    expect(needsFullNavigation("/api/ee/mcp-oauth/authorize?client_id=abc")).toBe(true);
    expect(needsFullNavigation("/settings?tab=mcp")).toBe(false);
    expect(needsFullNavigation("/")).toBe(false);
  });
});
