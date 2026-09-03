import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createNote,
  flushNotes,
  openNotesWindow,
  NOTES_STORAGE_KEY,
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
});
