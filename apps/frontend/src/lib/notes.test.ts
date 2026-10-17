import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createNote,
  flushNotes,
  getNotes,
  openNotesWindow,
  noteZIndex,
  setNotePinned,
  NOTES_STORAGE_KEY,
  NOTE_Z_PINNED_BASE,
  NOTE_Z_UNPINNED_BASE,
} from "./notes";

describe("notes window helpers", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("openNotesWindow opens /notes without a focus id", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null as never);
    openNotesWindow();
    expect(open).toHaveBeenCalledWith(
      "/notes",
      "prysm_notes",
      expect.stringContaining("width=1000")
    );
  });

  it("openNotesWindow appends an encoded focus query param", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null as never);
    openNotesWindow("sticky abc");
    expect(open).toHaveBeenCalledWith(
      "/notes?focus=sticky%20abc",
      "prysm_notes",
      expect.stringContaining("height=760")
    );
  });

  it("flushNotes writes notes to localStorage synchronously", () => {
    createNote("Title", "Body");
    flushNotes();
    const raw = localStorage.getItem(NOTES_STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].title).toBe("Title");
    expect(parsed[0].content).toBe("Body");
    expect(parsed[0].open).toBe(true);
  });

  it("creates notes unpinned below the pinned z-index band", () => {
    const note = createNote("Unpinned");
    const saved = getNotes().find((n) => n.id === note.id)!;
    expect(saved.alwaysOnTop).toBe(false);
    expect(noteZIndex(saved)).toBeLessThan(NOTE_Z_PINNED_BASE);
    expect(noteZIndex(saved)).toBeGreaterThanOrEqual(NOTE_Z_UNPINNED_BASE);
  });

  it("keeps pinned notes above every unpinned note", () => {
    const unpinned = createNote("Unpinned");
    const pinned = createNote("Pinned");
    setNotePinned(pinned.id, true);

    const savedUnpinned = getNotes().find((n) => n.id === unpinned.id)!;
    const savedPinned = getNotes().find((n) => n.id === pinned.id)!;
    expect(savedPinned.alwaysOnTop).toBe(true);
    expect(noteZIndex(savedPinned)).toBeGreaterThanOrEqual(NOTE_Z_PINNED_BASE);
    expect(noteZIndex(savedPinned)).toBeGreaterThan(noteZIndex(savedUnpinned));
  });

  it("unpinning returns a note to the unpinned band and persists locally", () => {
    const note = createNote("Pinned");
    setNotePinned(note.id, true);
    setNotePinned(note.id, false);
    flushNotes();

    const saved = getNotes().find((n) => n.id === note.id)!;
    expect(saved.alwaysOnTop).toBe(false);
    expect(noteZIndex(saved)).toBeLessThan(NOTE_Z_PINNED_BASE);
    const stored = JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY)!) as Array<{
      id: string;
      alwaysOnTop?: boolean;
    }>;
    expect(stored.find((n) => n.id === note.id)?.alwaysOnTop).toBe(false);
  });
});
