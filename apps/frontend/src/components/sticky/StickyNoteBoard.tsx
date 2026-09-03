"use client";

import { createContext, useContext, useCallback, type ReactNode } from "react";
import { useUiModule } from "@/lib/ui-module-registry";
import { createNote, flushNotes, openNotesWindow } from "@/lib/notes";

interface StickyBoardContextValue {
  open: () => void;
  toggle: () => void;
  addNoteWithContent: (title: string, content: string) => void;
}

const StickyBoardContext = createContext<StickyBoardContextValue>({
  open: () => {},
  toggle: () => {},
  addNoteWithContent: () => {},
});

export function useStickyBoard(): StickyBoardContextValue {
  return useContext(StickyBoardContext);
}

export function StickyBoardProvider({ children }: { children: ReactNode }) {
  const stickyOn = useUiModule("stickyNotes");

  const open = useCallback(() => {
    if (!stickyOn) return;
    openNotesWindow();
  }, [stickyOn]);

  const toggle = useCallback(() => {
    if (!stickyOn) return;
    openNotesWindow();
  }, [stickyOn]);

  const addNoteWithContent = useCallback(
    (title: string, content: string) => {
      if (!stickyOn) return;
      const note = createNote(title, content);
      flushNotes();
      openNotesWindow(note.id);
    },
    [stickyOn]
  );

  return (
    <StickyBoardContext.Provider value={{ open, toggle, addNoteWithContent }}>
      {children}
    </StickyBoardContext.Provider>
  );
}
