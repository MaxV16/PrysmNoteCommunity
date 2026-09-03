import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UpcomingBanner } from "./UpcomingBanner";
import type { WatchlistItem } from "@/types/watchlist";

const tasksMock = vi.hoisted(() => ({ createTask: vi.fn() }));
vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({ createTask: tasksMock.createTask }),
}));

const fetchProviders = vi.fn();

function makeItem(overrides: Partial<WatchlistItem> = {}): WatchlistItem {
  return {
    id: "w1",
    tmdb_id: 438631,
    media_type: "movie",
    is_theatrical: true,
    title: "Dune",
    poster_path: null,
    poster_url: null,
    release_year: 2021,
    status: "plan_to_watch",
    rating: null,
    notes: null,
    watched_at: null,
    upcoming: [
      { label: "Next installment 'Dune: Part Two' releases", date: "2099-01-01", extra: "Dune: Part Two" },
    ],
    providers: {},
    created_at: null,
    ...overrides,
  };
}

describe("UpcomingBanner", () => {
  beforeEach(() => {
    tasksMock.createTask.mockReset();
    fetchProviders.mockReset();
    fetchProviders.mockResolvedValue({});
  });

  it("renders the upcoming label, date, and get-tickets link", () => {
    render(<UpcomingBanner item={makeItem()} region="US" fetchProviders={fetchProviders} />);
    expect(screen.getByText(/Next installment/)).toBeInTheDocument();
    expect(screen.getByText("2099-01-01")).toBeInTheDocument();
    const tickets = screen.getByRole("link", { name: "Get tickets" });
    expect(tickets).toHaveAttribute("href", "https://www.themoviedb.org/movie/438631");
    expect(tickets).toHaveAttribute("target", "_blank");
  });

  it("skips past upcoming entries", () => {
    render(
      <UpcomingBanner
        item={makeItem({ upcoming: [{ label: "Season 3 airs", date: "2000-01-01" }] })}
        region="US"
        fetchProviders={fetchProviders}
      />
    );
    expect(screen.queryByText(/Season 3 airs/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remind me" })).not.toBeInTheDocument();
  });

  it("hides Get tickets for TV items", () => {
    render(
      <UpcomingBanner
        item={makeItem({ media_type: "tv", tmdb_id: 1396, is_theatrical: true })}
        region="US"
        fetchProviders={fetchProviders}
      />
    );
    expect(screen.queryByRole("link", { name: "Get tickets" })).not.toBeInTheDocument();
  });

  it("hides Get tickets for non-theatrical movies", () => {
    render(
      <UpcomingBanner
        item={makeItem({ is_theatrical: false })}
        region="US"
        fetchProviders={fetchProviders}
      />
    );
    expect(screen.queryByRole("link", { name: "Get tickets" })).not.toBeInTheDocument();
  });

  it("Remind me creates a timeline task", async () => {
    tasksMock.createTask.mockResolvedValue({ id: "t1" });
    render(<UpcomingBanner item={makeItem()} region="US" fetchProviders={fetchProviders} />);
    await userEvent.click(screen.getByRole("button", { name: "Remind me" }));
    await waitFor(() =>
      expect(tasksMock.createTask).toHaveBeenCalledWith({
        title: "Dune - Next installment 'Dune: Part Two' releases",
        start_date: "2099-01-01",
        due_date: "2099-01-01",
        status: "todo",
      })
    );
    expect(await screen.findByText("Added to timeline")).toBeInTheDocument();
  });

  it("fetches and renders provider sections", async () => {
    fetchProviders.mockResolvedValue({
      flatrate: [{ id: 8, name: "Netflix", logo_path: "/netflix.png", display_priority: 0 }],
      buy: [{ id: 3, name: "Apple TV", logo_path: "/appletv.png", display_priority: 1 }],
    });
    render(<UpcomingBanner item={makeItem()} region="US" fetchProviders={fetchProviders} />);
    expect(await screen.findByText("Streaming")).toBeInTheDocument();
    expect(screen.getByText("Buy")).toBeInTheDocument();
    expect(screen.getByTitle("Netflix")).toBeInTheDocument();
    expect(fetchProviders).toHaveBeenCalledWith("w1", "US");
  });
});
