import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

const NOTES_KEY = "prysm_sticky_notes";
const SYNCED_KEY = "prysm_sticky_notes_synced";
const DELETED_KEY = "prysm_sticky_notes_deleted";

const sample = (id: string) => ({
  id,
  x: 10,
  y: 10,
  width: 320,
  height: 240,
  title: id,
  content: "",
  color: "#fbbf24",
  minimized: false,
  open: true,
});

async function freshModule() {
  vi.resetModules();
  const apiMod = await import("@/lib/api");
  const notes = await import("./notes");
  const api = apiMod.api as unknown as {
    get: ReturnType<typeof vi.fn>;
    post: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  return { api, notes };
}

describe("notes server sync", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("propagates a deletion and never resurrects the note from a stale snapshot", async () => {
    localStorage.setItem(NOTES_KEY, JSON.stringify([sample("a")]));
    localStorage.setItem(SYNCED_KEY, JSON.stringify(["a"]));
    const { api, notes } = await freshModule();
    api.get.mockResolvedValue([{ ...sample("a"), sort: 0, updated_at: null }]);
    api.delete.mockResolvedValue({});

    notes.deleteNote("a");
    expect(notes.getNotes()).toHaveLength(0);

    await notes.syncNotesFromServer();

    expect(api.delete).toHaveBeenCalledWith("/notes/a");
    expect(notes.getNotes()).toHaveLength(0);
  });

  it("does not resurrect a note when a stale snapshot arrives after the debounced DELETE ran", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(NOTES_KEY, JSON.stringify([sample("e")]));
      localStorage.setItem(SYNCED_KEY, JSON.stringify(["e"]));
      const { api, notes } = await freshModule();
      api.delete.mockResolvedValue({});
      // The snapshot is stale: it still contains the note the user just deleted.
      api.get.mockResolvedValue([{ ...sample("e"), sort: 0, updated_at: null }]);
      api.post.mockResolvedValue({});

      notes.deleteNote("e");
      // Let the debounced push perform the DELETE and clear the in-memory
      // pending-delete queue, which is what used to drop the only guard.
      await vi.advanceTimersByTimeAsync(700);
      expect(api.delete).toHaveBeenCalledWith("/notes/e");
      expect(notes.getNotes()).toHaveLength(0);

      // A sync now receives a snapshot that still lists the deleted note.
      await notes.syncNotesFromServer();

      expect(notes.getNotes()).toHaveLength(0);
      expect(api.post).not.toHaveBeenCalled();
      expect(localStorage.getItem(DELETED_KEY)).toContain("e");

      // Simulate a reload that races the debounced localStorage write: the old
      // notes blob is still present, but the durable tombstone must win.
      localStorage.setItem(NOTES_KEY, JSON.stringify([sample("e")]));
      const reloaded = await freshModule();
      expect(reloaded.notes.getNotes()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a note deleted on another device instead of re-posting it", async () => {
    localStorage.setItem(NOTES_KEY, JSON.stringify([sample("a")]));
    localStorage.setItem(SYNCED_KEY, JSON.stringify(["a"]));
    const { api, notes } = await freshModule();
    api.get.mockResolvedValue([]);
    api.post.mockResolvedValue({});

    await notes.syncNotesFromServer();

    expect(notes.getNotes()).toHaveLength(0);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("pushes a genuinely new offline note", async () => {
    localStorage.setItem(NOTES_KEY, JSON.stringify([sample("b")]));
    localStorage.setItem(SYNCED_KEY, JSON.stringify([]));
    const { api, notes } = await freshModule();
    api.get.mockResolvedValue([]);
    api.post.mockResolvedValue({});

    await notes.syncNotesFromServer();

    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post.mock.calls[0]?.[1]).toMatchObject({ id: "b" });
    expect(notes.getNotes().map((n) => n.id)).toEqual(["b"]);
  });

  it("keeps server notes without re-posting them", async () => {
    localStorage.setItem(NOTES_KEY, JSON.stringify([sample("c")]));
    localStorage.setItem(SYNCED_KEY, JSON.stringify(["c"]));
    const { api, notes } = await freshModule();
    api.get.mockResolvedValue([{ ...sample("c"), sort: 0, updated_at: null }]);

    await notes.syncNotesFromServer();

    expect(notes.getNotes().map((n) => n.id)).toEqual(["c"]);
    expect(api.post).not.toHaveBeenCalled();
  });

  it("pushes a deletion without waiting for a full sync", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem(NOTES_KEY, JSON.stringify([sample("d")]));
      localStorage.setItem(SYNCED_KEY, JSON.stringify(["d"]));
      const { api, notes } = await freshModule();
      api.delete.mockResolvedValue({});

      notes.deleteNote("d");
      await vi.advanceTimersByTimeAsync(700);

      expect(api.delete).toHaveBeenCalledWith("/notes/d");
    } finally {
      vi.useRealTimers();
    }
  });
});
