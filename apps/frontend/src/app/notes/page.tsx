"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { createNote, openNote, syncNotesFromServer } from "@/lib/notes";
import { useUiModule } from "@/lib/ui-module-registry";
import { useMediaQuery } from "@/lib/use-media-query";
import { NotesOverlay } from "@/components/notes/NoteWindow";
import { NotesSection } from "@/components/sidebar/NotesSection";


function NotesWorkspace() {
  const searchParams = useSearchParams();
  const stickyOn = useUiModule("stickyNotes");
  const smallScreen = useMediaQuery("(max-width: 767px)");
  const [sidebarOpen, setSidebarOpen] = useState(() => {
    // On small screens start with the list collapsed; it opens as an overlay.
    if (typeof window === "undefined") return true;
    return !window.matchMedia("(max-width: 767px)").matches;
  });

  useEffect(() => {
    void syncNotesFromServer();
  }, []);

  useEffect(() => {
    const focus = searchParams?.get("focus");
    if (focus) openNote(focus);
  }, [searchParams]);

  return (
    <div className="flex h-dvh w-screen flex-col overflow-hidden bg-base">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-surface px-4">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSidebarOpen((v) => !v)}
            className="flex h-8 w-8 items-center justify-center rounded-full text-secondary transition-colors hover:bg-hover hover:text-primary md:hidden"
            aria-label="Toggle note list"
            title="Toggle note list"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
          </button>
          <h1 className="text-sm font-bold text-primary">Notes</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => createNote()}
            className="btn btn-primary px-3 py-1.5 text-xs"
          >
            New note
          </button>
          <button
            onClick={() => window.close()}
            className="btn bg-elevated border border-border px-3 py-1.5 text-xs text-secondary hover:text-primary"
          >
            Close
          </button>
        </div>
      </header>
      {!stickyOn ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted">
          Notes are turned off in your UI settings.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Mobile: slide-in overlay drawer for the note list */}
          {smallScreen && sidebarOpen && (
            <>
              <div
                className="fixed inset-0 z-40 bg-black/40"
                aria-hidden
                onClick={() => setSidebarOpen(false)}
              />
              <aside className="fixed inset-y-0 left-0 z-40 w-64 overflow-y-auto border-r border-border bg-surface px-2 py-3 slide-in-left">
                <NotesSection />
              </aside>
            </>
          )}
          {/* Desktop (md+): inline note list, always visible */}
          <aside className="hidden w-64 shrink-0 overflow-y-auto border-r border-border bg-surface px-2 py-3 md:block">
            <NotesSection />
          </aside>
          <main className="relative min-h-0 flex-1 overflow-hidden">
            <NotesOverlay />
          </main>
        </div>
      )}
    </div>
  );
}

export default function NotesPage() {
  return (
    <Suspense fallback={null}>
        <NotesWorkspace />
    </Suspense>
  );
}
