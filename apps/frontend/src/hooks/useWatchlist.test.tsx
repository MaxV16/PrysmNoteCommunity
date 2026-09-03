import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { useWatchlist } from "./useWatchlist";
import type { WatchlistItem } from "@/types/watchlist";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api }));

function wrapper({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function makeItem(id: string, overrides: Partial<WatchlistItem> = {}): WatchlistItem {
  return {
    id,
    tmdb_id: 438631,
    media_type: "movie",
    is_theatrical: false,
    title: id,
    poster_path: null,
    poster_url: null,
    release_year: 2021,
    status: "plan_to_watch",
    rating: null,
    notes: null,
    watched_at: null,
    upcoming: [],
    providers: {},
    created_at: "2026-08-30T00:00:00",
    ...overrides,
  };
}

describe("useWatchlist", () => {
  beforeEach(() => {
    api.get.mockReset();
    api.post.mockReset();
    api.patch.mockReset();
    api.delete.mockReset();
  });

  it("loads items on mount", async () => {
    api.get.mockResolvedValue([makeItem("w1"), makeItem("w2")]);
    const { result } = renderHook(() => useWatchlist(), { wrapper });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(api.get).toHaveBeenCalledWith("/watchlist/");
  });

  it("add prepends the created item", async () => {
    api.get.mockResolvedValue([]);
    api.post.mockResolvedValue(makeItem("new1", { title: "Dune" }));
    const { result } = renderHook(() => useWatchlist(), { wrapper });
    await waitFor(() => expect(result.current.items).toHaveLength(0));
    await result.current.add({ tmdb_id: 438631, media_type: "movie", title: "Dune" });
    expect(api.post).toHaveBeenCalledWith("/watchlist/", {
      tmdb_id: 438631,
      media_type: "movie",
      title: "Dune",
    });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
  });

  it("search returns mapped results and swallows errors", async () => {
    api.post.mockResolvedValue([
      { tmdb_id: 438631, media_type: "movie", title: "Dune", release_year: 2021, poster_path: null },
    ]);
    const { result } = renderHook(() => useWatchlist(), { wrapper });
    await waitFor(() => expect(result.current.items).toHaveLength(0));

    const found = await result.current.search("dune");
    expect(api.post).toHaveBeenCalledWith("/watchlist/search?query=dune");
    expect(found).toHaveLength(1);

    api.post.mockRejectedValue(new Error("boom"));
    expect(await result.current.search("x")).toEqual([]);
  });

  it("update replaces the item in place", async () => {
    api.get.mockResolvedValue([makeItem("w1", { status: "plan_to_watch" })]);
    api.patch.mockResolvedValue(makeItem("w1", { status: "watched" }));
    const { result } = renderHook(() => useWatchlist(), { wrapper });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await result.current.update("w1", { status: "watched" });
    expect(api.patch).toHaveBeenCalledWith("/watchlist/w1", { status: "watched" });
    await waitFor(() => expect(result.current.items[0].status).toBe("watched"));
  });

  it("remove filters the item out", async () => {
    api.get.mockResolvedValue([makeItem("w1")]);
    api.delete.mockResolvedValue({});
    const { result } = renderHook(() => useWatchlist(), { wrapper });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await result.current.remove("w1");
    expect(api.delete).toHaveBeenCalledWith("/watchlist/w1");
    await waitFor(() => expect(result.current.items).toHaveLength(0));
  });

  it("fetchProviders returns providers and swallows errors", async () => {
    api.get.mockResolvedValue({ flatrate: [{ id: 8, name: "Netflix", logo_path: null }] });
    const { result } = renderHook(() => useWatchlist(), { wrapper });
    await waitFor(() => expect(result.current.items).toHaveLength(0));
    const providers = await result.current.fetchProviders("w1", "US");
    expect(api.get).toHaveBeenCalledWith("/watchlist/w1/providers?region=US");
    expect(providers.flatrate).toHaveLength(1);

    api.get.mockRejectedValue(new Error("boom"));
    expect(await result.current.fetchProviders("w1", "DE")).toEqual({});
  });

  it("a slow initial fetch cannot clobber a newer mutation", async () => {
    let resolveFetch: (v: WatchlistItem[]) => void = () => {};
    api.get.mockReturnValue(
      new Promise<WatchlistItem[]>((resolve) => {
        resolveFetch = resolve;
      })
    );
    api.post.mockResolvedValue(makeItem("new1", { title: "Dune" }));

    const { result } = renderHook(() => useWatchlist(), { wrapper });
    await waitFor(() => expect(api.get).toHaveBeenCalled());

    await result.current.add({ tmdb_id: 438631, media_type: "movie", title: "Dune" });
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    // The stale initial fetch resolves now - it must NOT wipe the added item.
    resolveFetch([makeItem("stale")]);
    await waitFor(() => expect(result.current.items[0].title).toBe("Dune"));
    expect(result.current.items).toHaveLength(1);
  });
});
