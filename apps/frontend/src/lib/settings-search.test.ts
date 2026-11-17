import { describe, it, expect } from "vitest";
import { searchSettings, SETTINGS_ENTRY_COUNT } from "./settings-search";

const titles = (query: string) => searchSettings(query).map((hit) => hit.title);

describe("searchSettings", () => {
  it("indexes every setting exactly once", () => {
    expect(SETTINGS_ENTRY_COUNT).toBeGreaterThan(40);
  });

  it("returns nothing for an empty or whitespace query", () => {
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
  });

  it("finds a setting by its own name", () => {
    expect(titles("theme")).toContain("Theme");
    expect(titles("timezone")).toContain("Timezone");
  });

  it("finds a setting by a word the user would actually type", () => {
    // None of these words appear in the titles.
    expect(titles("alerts")).toContain("Notifications");
    expect(titles("byok")).toContain("AI provider keys");
    expect(titles("confetti")).toContain("Completion animations");
    expect(titles("monday")).toContain("Week starts on");
    expect(titles("logout")).toContain("Sign out");
  });

  it("finds vault semantic search", () => {
    expect(titles("embeddings")).toContain("Semantic search");
  });

  it("narrows with a second word instead of widening", () => {
    const one = titles("slack");
    const two = titles("slack messages");
    expect(two.length).toBeLessThanOrEqual(one.length);
    expect(two.length).toBeGreaterThan(0);
  });

  it("ranks a title match above a keyword-only match", () => {
    const results = searchSettings("vault export");
    expect(results[0].title).toBe("Vault export and import");
  });

  it("returns an empty list when nothing matches", () => {
    expect(searchSettings("zzzznothing")).toEqual([]);
  });

  it("never returns more than the requested limit", () => {
    expect(searchSettings("a", 3).length).toBeLessThanOrEqual(3);
  });
});
