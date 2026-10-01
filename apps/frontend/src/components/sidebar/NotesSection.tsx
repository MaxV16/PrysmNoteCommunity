"use client";

import { useEffect, useState } from "react";
import { useNotes } from "@/components/notes/NoteWindow";
import { openNote, createNote, deleteNote, flushNotes, isNativeStickySupported } from "@/lib/notes";
import { useUiModule } from "@/lib/ui-module-registry";
import { useStickyBoard } from "@/components/sticky/StickyNoteBoard";
import { useIsMobileOS } from "@/lib/use-is-mobile-os";

const OPEN_KEY = "prysm_notes_section_open";

export function NotesSection() {
  const notes = useNotes();
  const notesOn = useUiModule("stickyNotes");
  const isMobile = useIsMobileOS();
  const { nativeSupported, openNativeWindow, isNativeOpen, openSticky } = useStickyBoard();
  const nativeSupportedNow = nativeSupported && isNativeStickySupported();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(OPEN_KEY);
      if (saved != null) setOpen(saved === "1");
    } catch {
      /* storage unavailable */
    }
  }, []);

  const toggleOpen = () => {
    setOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(OPEN_KEY, next ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  };

  if (!notesOn || isMobile) return null;

  const handleNewNote = () => {
    // New notes open directly as a floating sticky note, not a board.
    const note = createNote();
    flushNotes();
    openSticky(note.id);
  };

  const handleOpenNote = (id: string) => {
    openNote(id);
    openSticky(id);
  };

  return (
    <div className="mt-5">
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <button
          onClick={toggleOpen}
          className="nav-label flex min-w-0 flex-1 items-center gap-1 text-left transition-colors hover:text-primary"
          aria-expanded={open}
          aria-label={open ? "Collapse notes" : "Expand notes"}
        >
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          >
            <polyline points="9 6 15 12 9 18" />
          </svg>
          <span className="truncate">Notes</span>
          {notes.length > 0 && <span className="shrink-0 text-[10px] text-muted">({notes.length})</span>}
        </button>
        <button
          onClick={handleNewNote}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-primary"
          title="New note"
          aria-label="New note"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      {open &&
        (notes.length === 0 ? (
          <p className="px-2 py-1 text-[11px] text-muted">No notes yet</p>
        ) : (
          <div className="space-y-0.5">
            {notes.map((n) => (
              <div key={n.id} className="group flex items-center">
                <button
                  onClick={() => handleOpenNote(n.id)}
                  className={`sidebar-item flex-1 text-[13px] ${
                    n.open ? "bg-accent/10 text-accent" : ""
                  }`}
                  title={n.title || "Untitled"}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: n.color }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate text-left">
                    {n.title || "Untitled"}
                  </span>
                  {n.open && (
                    <span className="shrink-0 text-[9px] uppercase tracking-wide text-accent/70">
                      open
                    </span>
                  )}
                </button>
                {nativeSupportedNow && (
                  <button
                    onClick={() => openNativeWindow(n.id)}
                    className={`pointer-coarse:opacity-100 mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors ${
                      isNativeOpen(n.id)
                        ? "bg-accent/20 text-accent"
                        : "text-muted opacity-0 hover:bg-hover hover:text-primary"
                    } group-hover:opacity-100`}
                    title={isNativeOpen(n.id) ? "Already open as native window" : "Pop out as native window (always on top)"}
                    aria-label={isNativeOpen(n.id) ? "Already open as native window" : "Pop out as native window"}
                    disabled={isNativeOpen(n.id)}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
                  </button>
                )}
                <button
                  onClick={() => {
                    if (window.confirm("Delete this note?")) deleteNote(n.id);
                  }}
                  className="pointer-coarse:opacity-100 mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-opacity hover:bg-danger/20 hover:text-danger group-hover:opacity-100"
                  title="Delete note"
                  aria-label={`Delete ${n.title || "note"}`}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}
