import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MediaCard } from "./MediaCard";
import type { WatchlistItem } from "@/types/watchlist";

const tasksMock = vi.hoisted(() => ({ createTask: vi.fn() }));
vi.mock("@/hooks/useTasks", () => ({
  useTasks: () => ({ createTask: tasksMock.createTask }),
}));

const onUpdate = vi.fn();
const onRemove = vi.fn();
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
    status: "watched",
    rating: 8,
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

describe("MediaCard", () => {
  beforeEach(() => {
    onUpdate.mockReset();
    onRemove.mockReset();
    fetchProviders.mockReset();
    fetchProviders.mockResolvedValue({});
  });

  it("shows the status badge collapsed and hides it when expanded", async () => {
    render(
      <MediaCard item={makeItem()} region="US" onUpdate={onUpdate} onRemove={onRemove} fetchProviders={fetchProviders} />
    );
    expect(screen.getByText("Watched", { selector: "span.badge" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Dune details" }));

    expect(screen.queryByText("Watched", { selector: "span.badge" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("watched");
  });

  it("does not show Get tickets for a TV item", async () => {
    render(
      <MediaCard
        item={makeItem({ media_type: "tv", tmdb_id: 1396, is_theatrical: true })}
        region="US"
        onUpdate={onUpdate}
        onRemove={onRemove}
        fetchProviders={fetchProviders}
      />
    );
    await userEvent.click(screen.getByRole("button", { name: "Dune details" }));

    expect(screen.queryByRole("link", { name: "Get tickets" })).not.toBeInTheDocument();
  });

  it("edits rating via dropdown and saves all pending changes with one button", async () => {
    onUpdate.mockResolvedValue({});
    render(
      <MediaCard item={makeItem()} region="US" onUpdate={onUpdate} onRemove={onRemove} fetchProviders={fetchProviders} />
    );
    await userEvent.click(screen.getByRole("button", { name: "Dune details" }));

    const rating = screen.getByRole("combobox", { name: "Rating" });
    expect(rating).toHaveValue("8");
    await userEvent.selectOptions(rating, "9");

    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeEnabled();
    await userEvent.click(save);

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith("w1", {
        status: "watched",
        rating: 9,
        notes: null,
        watched_at: null,
      });
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("reverts local edits when saving fails", async () => {
    onUpdate.mockRejectedValue(new Error("boom"));
    render(
      <MediaCard item={makeItem()} region="US" onUpdate={onUpdate} onRemove={onRemove} fetchProviders={fetchProviders} />
    );
    await userEvent.click(screen.getByRole("button", { name: "Dune details" }));

    const status = screen.getByRole("combobox", { name: "Status" });
    await userEvent.selectOptions(status, "watching");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Status" })).toHaveValue("watched");
    });
  });

  it("disables Save when nothing changed", async () => {
    render(
      <MediaCard item={makeItem()} region="US" onUpdate={onUpdate} onRemove={onRemove} fetchProviders={fetchProviders} />
    );
    await userEvent.click(screen.getByRole("button", { name: "Dune details" }));

    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });
});
