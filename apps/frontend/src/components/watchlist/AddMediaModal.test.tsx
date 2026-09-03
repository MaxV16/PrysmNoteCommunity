import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddMediaModal } from "./AddMediaModal";
import type { TMDBResult } from "@/types/watchlist";

const onClose = vi.fn();
const onAdd = vi.fn();
const search = vi.fn();

const DUNE: TMDBResult = {
  tmdb_id: 438631,
  media_type: "movie",
  title: "Dune",
  release_year: 2021,
  poster_path: null,
};
const SEVERANCE: TMDBResult = {
  tmdb_id: 1396,
  media_type: "tv",
  title: "Severance",
  release_year: 2022,
  poster_path: null,
};

function renderModal() {
  return render(<AddMediaModal open search={search} onAdd={onAdd} onClose={onClose} />);
}

describe("AddMediaModal", () => {
  beforeEach(() => {
    onClose.mockReset();
    onAdd.mockReset();
    onAdd.mockResolvedValue({});
    search.mockReset();
    search.mockResolvedValue([DUNE, SEVERANCE]);
  });

  it("adds multiple selected titles at once with a shared status", async () => {
    renderModal();
    await userEvent.type(screen.getByPlaceholderText(/Search movies/i), "dune");
    await screen.findByText("Dune", {}, { timeout: 3000 });
    await screen.findByText("Severance");

    await userEvent.click(screen.getByText("Dune"));
    await userEvent.click(screen.getByText("Severance"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Watched" }));

    expect(onAdd).toHaveBeenCalledTimes(2);
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Dune", status: "watched" }));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Severance", status: "watched" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancel clears the selection without adding", async () => {
    renderModal();
    await userEvent.type(screen.getByPlaceholderText(/Search movies/i), "dune");
    await screen.findByText("Dune", {}, { timeout: 3000 });

    await userEvent.click(screen.getByText("Dune"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
    expect(onAdd).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("adds titles selected across multiple searches", async () => {
    search.mockImplementation((q: string) =>
      Promise.resolve(
        q.toLowerCase().includes("severance") ? [SEVERANCE] : q.toLowerCase().includes("dune") ? [DUNE] : []
      )
    );
    renderModal();
    const input = screen.getByPlaceholderText(/Search movies/i);

    await userEvent.type(input, "dune");
    await screen.findByText("Dune", {}, { timeout: 3000 });
    await userEvent.click(screen.getByText("Dune"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, "severance");
    await screen.findByText("Severance", {}, { timeout: 3000 });
    await userEvent.click(screen.getByText("Severance"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Plan to watch" }));

    expect(onAdd).toHaveBeenCalledTimes(2);
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Dune", status: "plan_to_watch" })
    );
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Severance", status: "plan_to_watch" })
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores stale search results that resolve after a newer query", async () => {
    let resolveOld: (v: TMDBResult[]) => void;
    search.mockImplementation((q: string) =>
      q === "dune"
        ? new Promise<TMDBResult[]>((res) => {
            resolveOld = res;
          })
        : Promise.resolve([SEVERANCE])
    );
    renderModal();
    const input = screen.getByPlaceholderText(/Search movies/i);

    await userEvent.type(input, "dune");
    // Let the dune request fire and stay in flight.
    await new Promise((r) => setTimeout(r, 500));

    await userEvent.clear(input);
    await userEvent.type(input, "severance");
    await screen.findByText("Severance", {}, { timeout: 3000 });

    // Resolve the stale dune response last; it must not clobber Severance.
    resolveOld!([DUNE]);
    await new Promise((r) => setTimeout(r, 50));

    expect(screen.getByText("Severance")).toBeInTheDocument();
    expect(screen.queryByText("Dune")).not.toBeInTheDocument();
  });

  it("keeps the modal open when only some adds fail", async () => {
    onAdd.mockImplementation((payload: { title: string }) =>
      payload.title === "Dune"
        ? Promise.resolve({})
        : Promise.reject(new Error("Already on your watchlist"))
    );
    renderModal();
    await userEvent.type(screen.getByPlaceholderText(/Search movies/i), "dune");
    await screen.findByText("Dune", {}, { timeout: 3000 });
    await screen.findByText("Severance");

    await userEvent.click(screen.getByText("Dune"));
    await userEvent.click(screen.getByText("Severance"));
    await userEvent.click(screen.getByRole("button", { name: "Watching" }));

    expect(onClose).not.toHaveBeenCalled();
    expect(await screen.findByText(/Already on your watchlist/)).toBeInTheDocument();
    // The successful item leaves the selection; the failed one stays for retry.
    expect(screen.getByText("1 selected")).toBeInTheDocument();
  });
});
