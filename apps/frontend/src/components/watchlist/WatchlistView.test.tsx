import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WatchlistView } from "./WatchlistView";
import type { WatchlistItem } from "@/types/watchlist";

const tasksMock = vi.hoisted(() => ({ createTask: vi.fn() }));
vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({ createTask: tasksMock.createTask }),
}));

const watchlistMock = vi.hoisted(() => ({
  items: [] as WatchlistItem[],
  loading: false,
  search: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  fetchProviders: vi.fn(),
}));

vi.mock("@/hooks/useWatchlist", () => ({
  useWatchlist: () => watchlistMock,
}));

function makeItem(overrides: Partial<WatchlistItem> = {}): WatchlistItem {
  return {
    id: "w1",
    tmdb_id: 438631,
    media_type: "movie",
    is_theatrical: false,
    title: "Dune",
    poster_path: null,
    poster_url: null,
    release_year: 2021,
    status: "plan_to_watch",
    rating: null,
    notes: null,
    watched_at: null,
    upcoming: [],
    providers: {},
    created_at: null,
    ...overrides,
  };
}

describe("WatchlistView", () => {
  beforeEach(() => {
    watchlistMock.items = [
      makeItem(),
      makeItem({ id: "w2", tmdb_id: 1396, title: "Severance", media_type: "tv" }),
    ];
    watchlistMock.loading = false;
    watchlistMock.fetchProviders.mockReset();
    watchlistMock.fetchProviders.mockResolvedValue({});
  });

  it("filters the watchlist by title search", async () => {
    render(<WatchlistView />);
    expect(screen.getAllByText("Dune").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Severance").length).toBeGreaterThan(0);

    await userEvent.type(screen.getByPlaceholderText(/Search your watchlist/i), "dune");

    expect(screen.getAllByText("Dune").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Severance")).toHaveLength(0);
  });

  it("shows a no-match message and clears the search", async () => {
    render(<WatchlistView />);
    const input = screen.getByPlaceholderText(/Search your watchlist/i);

    await userEvent.type(input, "zzz");
    expect(screen.getByText(/No titles match your search/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));

    expect(screen.getAllByText("Dune").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Severance").length).toBeGreaterThan(0);
  });
});
