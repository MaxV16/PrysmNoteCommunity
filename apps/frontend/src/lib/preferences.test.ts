import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getPrefSync,
  loadPreferencesFromServer,
  savePreference,
  PREFERENCES_KEY,
  PREF_DEFAULT_VIEW,
  PREF_DEFAULT_LIST,
  DEFAULT_LANDING_ALL,
  readDefaultList,
  isNavDefault,
} from "./preferences";

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMock }));

describe("preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    apiMock.get.mockReset();
    apiMock.put.mockReset();
  });

  it("getPrefSync reads the cache synchronously with a fallback", () => {
    expect(getPrefSync(PREF_DEFAULT_VIEW, "timeline")).toBe("timeline");
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ default_view: "board" }));
    expect(getPrefSync(PREF_DEFAULT_VIEW, "timeline")).toBe("board");
  });

  it("getPrefSync tolerates a corrupt cache", () => {
    localStorage.setItem(PREFERENCES_KEY, "not-json{{");
    expect(getPrefSync(PREF_DEFAULT_VIEW, "timeline")).toBe("timeline");
  });

  it("savePreference writes the cache and PUTs to the server", async () => {
    apiMock.put.mockResolvedValue({ key: "default_view", value: "board" });
    await savePreference(PREF_DEFAULT_VIEW, "board");
    expect(apiMock.put).toHaveBeenCalledWith("/preferences/default_view", { value: "board" });
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY) as string)).toEqual({
      default_view: "board",
    });
  });

  it("savePreference preserves other cached keys", async () => {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ a: 1 }));
    apiMock.put.mockResolvedValue({});
    await savePreference(PREF_DEFAULT_VIEW, "kanban");
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY) as string)).toEqual({
      a: 1,
      default_view: "kanban",
    });
  });

  it("savePreference propagates server failures to the caller for rollback", async () => {
    apiMock.put.mockRejectedValue(new Error("offline"));
    await expect(savePreference(PREF_DEFAULT_VIEW, "board")).rejects.toThrow("offline");
    // The cache was still updated optimistically (the store rolls back its state).
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY) as string)).toEqual({
      default_view: "board",
    });
  });

  it("loadPreferencesFromServer merges server values over the cache", async () => {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ a: 1, b: "local" }));
    apiMock.get.mockResolvedValue({ b: "server" });
    const result = await loadPreferencesFromServer();
    expect(result).toEqual({ a: 1, b: "server" });
    expect(JSON.parse(localStorage.getItem(PREFERENCES_KEY) as string)).toEqual({
      a: 1,
      b: "server",
    });
  });

  it("loadPreferencesFromServer falls back to the cache on failure", async () => {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ a: 1 }));
    apiMock.get.mockRejectedValue(new Error("boom"));
    const result = await loadPreferencesFromServer();
    expect(result).toEqual({ a: 1 });
  });
});

describe("default landing list", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to the All Tasks smart list", () => {
    expect(readDefaultList()).toBe(DEFAULT_LANDING_ALL);
    expect(DEFAULT_LANDING_ALL).toBe("all");
  });

  it("reads a saved list id from the cache", () => {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ [PREF_DEFAULT_LIST]: "list-123" }));
    expect(readDefaultList()).toBe("list-123");
  });

  it("ignores empty or non-string stored values", () => {
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ [PREF_DEFAULT_LIST]: "" }));
    expect(readDefaultList()).toBe(DEFAULT_LANDING_ALL);
    localStorage.setItem(PREFERENCES_KEY, JSON.stringify({ [PREF_DEFAULT_LIST]: 42 }));
    expect(readDefaultList()).toBe(DEFAULT_LANDING_ALL);
  });

  it("classifies smart-filter values as nav defaults, list ids as not", () => {
    expect(isNavDefault("all")).toBe(true);
    expect(isNavDefault("today")).toBe(true);
    expect(isNavDefault("next7")).toBe(true);
    expect(isNavDefault("completed")).toBe(true);
    expect(isNavDefault("list-123")).toBe(false);
    expect(isNavDefault("")).toBe(false);
  });
});
