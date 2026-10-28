import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { VaultExplorer } from "@/components/vault/VaultExplorer";
import { ToastProvider } from "@/lib/toast-context";

const get = vi.fn();
const post = vi.fn();
const patch = vi.fn();
const del = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
    patch: (path: string, body?: unknown) => patch(path, body),
    delete: (path: string) => del(path),
  },
}));

const NOTE = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Weekly review",
  tags: ["review"],
  aliases: [],
  folder: "",
  pinned: false,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
  snippet: "What went well",
};

const DETAIL = {
  ...NOTE,
  body: "What went well\n\n- shipped the vault",
  backlinks: [{ id: "22222222-2222-2222-2222-222222222222", title: "October" }],
  links: [{ title: "October", note_id: "22222222-2222-2222-2222-222222222222" }],
  revision_count: 2,
};

function routeGet(path: string) {
  if (path.startsWith("/vault/notes?")) return Promise.resolve({ notes: [NOTE] });
  if (path === `/vault/notes/${NOTE.id}`) return Promise.resolve(DETAIL);
  if (path === "/vault/tags") return Promise.resolve({ tags: [{ tag: "review", count: 1 }] });
  if (path === "/vault/templates") return Promise.resolve({ templates: [] });
  if (path === "/vault/stats") {
    return Promise.resolve({
      notes: 1,
      links: 1,
      tags: 1,
      templates: 0,
      embedded_chunks: 0,
      last_updated: NOTE.updated_at,
      semantic_search: false,
    });
  }
  if (path.startsWith("/vault/search")) return Promise.resolve({ results: [NOTE], mode: "text" });
  if (path.endsWith("/revisions")) return Promise.resolve({ revisions: [] });
  return Promise.resolve({});
}

function renderExplorer() {
  return render(
    <ToastProvider>
      <VaultExplorer />
    </ToastProvider>
  );
}

describe("VaultExplorer", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    patch.mockReset();
    del.mockReset();
    get.mockImplementation(routeGet);
  });

  it("lists notes and opens one in the editor", async () => {
    renderExplorer();

    expect(await screen.findByText("Weekly review")).toBeTruthy();
    fireEvent.click(screen.getByText("Weekly review"));

    await waitFor(() => {
      const body = screen.getByLabelText("Note body") as HTMLTextAreaElement;
      expect(body.value).toContain("shipped the vault");
    });
    expect((screen.getByLabelText("Note title") as HTMLInputElement).value).toBe("Weekly review");
    expect(screen.getAllByText("October").length).toBeGreaterThan(0);
  });

  it("creates a note from the header action", async () => {
    post.mockResolvedValue({ id: NOTE.id });
    renderExplorer();

    await screen.findByText("Weekly review");
    fireEvent.click(screen.getByRole("button", { name: "+ New note" }));

    await waitFor(() => {
      expect(post).toHaveBeenCalledWith("/vault/notes", expect.objectContaining({ title: "Untitled note" }));
    });
  });

  it("saves edits through PATCH", async () => {
    patch.mockResolvedValue({ ...DETAIL, title: "Renamed" });
    renderExplorer();

    fireEvent.click(await screen.findByText("Weekly review"));
    const title = await screen.findByLabelText("Note title");
    fireEvent.change(title, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(patch).toHaveBeenCalledWith(
        `/vault/notes/${NOTE.id}`,
        expect.objectContaining({ title: "Renamed" })
      );
    });
  });
});
