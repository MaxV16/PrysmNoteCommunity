"use client";

import { useNotes } from "@/components/notes/NoteWindow";
import { openNote, createNote, deleteNote, openNotesWindow } from "@/lib/notes";
import { useUiModule } from "@/lib/ui-module-registry";

export function NotesSection() {
  const notes = useNotes();
  const notesOn = useUiModule("stickyNotes");
  const inNotesWindow = typeof window !== "undefined" && window.name === "prysm_notes";
  if (!notesOn) return null;

  const handleNewNote = () => {
    // Inside the /notes popup the note is created in-place; elsewhere the notes
    // window is opened (and focused) so notes stay window-only.
    if (inNotesWindow) createNote();
    else openNotesWindow();
  };

  const handleOpenNote = (id: string) => {
    openNote(id);
    if (!inNotesWindow) openNotesWindow(id);
  };

  return (
    <div className="mt-5">
      <div className="flex items-center justify-between px-2 pb-1.5">
        <p className="nav-label">Notes</p>
        <button
          onClick={handleNewNote}
          className="flex h-5 w-5 items-center justify-center rounded-md text-muted transition-colors hover:bg-hover hover:text-primary"
          title="New note"
          aria-label="New note"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      {notes.length === 0 ? (
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
      )}
    </div>
  );
}
