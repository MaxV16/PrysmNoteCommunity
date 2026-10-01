"use client";

import { createContext, useContext, useCallback, type ReactNode } from "react";
import { useUiModule } from "@/lib/ui-module-registry";
import {
  createNote,
  openNote,
  flushNotes,
  getNotes,
  openStickyWindow,
  openNotesWindow,
  type StickyNote,
} from "@/lib/notes";
import { useNativeStickyNotes } from "@/lib/sticky-native";
import { useIsMobileOS } from "@/lib/use-is-mobile-os";

interface StickyBoardContextValue {
  open: () => void;
  toggle: () => void;
  addNoteWithContent: (title: string, content: string) => void;
  openSticky: (noteId: string) => void;
  openNativeWindow: (noteId: string) => Promise<void>;
  closeNativeWindow: (noteId: string) => Promise<void>;
  isNativeOpen: (noteId: string) => boolean;
  nativeSupported: boolean;
}

const StickyBoardContext = createContext<StickyBoardContextValue>({
  open: () => {},
  toggle: () => {},
  addNoteWithContent: () => {},
  openSticky: () => {},
  openNativeWindow: async () => {},
  closeNativeWindow: async () => {},
  isNativeOpen: () => false,
  nativeSupported: false,
});

export function useStickyBoard(): StickyBoardContextValue {
  return useContext(StickyBoardContext);
}

export function StickyBoardProvider({ children }: { children: ReactNode }) {
  const isMobileOS = useIsMobileOS();
  const stickyOn = useUiModule("stickyNotes") && !isMobileOS;
  const { supported, openNativeWindow, closeNativeWindow, isNativeOpen } = useNativeStickyNotes();

  // Open one note as a floating window: a native always-on-top window in the
  // desktop app, or a small standalone popup in the browser. Never the board.
  const openNoteWindow = useCallback(
    (note: StickyNote) => {
      if (supported) {
        void openNativeWindow(note.id);
      } else {
        const win = openStickyWindow(note.id);
        if (!win) {
          // The popup was blocked (or the browser refused it). Fall back to the
          // notes board so the note is still reachable instead of failing
          // silently when the user clicks Notes or +.
          openNotesWindow(note.id);
        }
      }
    },
    [supported, openNativeWindow]
  );

  const open = useCallback(() => {
    if (!stickyOn) return;
    const all = getNotes();
    const note = all.length > 0 ? all[all.length - 1] : createNote();
    flushNotes();
    openNoteWindow(note);
  }, [stickyOn, openNoteWindow]);

  const toggle = open;

  const addNoteWithContent = useCallback(
    (title: string, content: string) => {
      if (!stickyOn) return;
      const note = createNote(title, content);
      flushNotes();
      openNoteWindow(note);
    },
    [stickyOn, openNoteWindow]
  );

  const openSticky = useCallback(
    (noteId: string) => {
      if (!stickyOn) return;
      const note = getNotes().find((n) => n.id === noteId);
      if (!note) return;
      openNote(noteId);
      flushNotes();
      openNoteWindow(note);
    },
    [stickyOn, openNoteWindow]
  );

  return (
    <StickyBoardContext.Provider
      value={{
        open,
        toggle,
        addNoteWithContent,
        openSticky,
        openNativeWindow,
        closeNativeWindow,
        isNativeOpen,
        nativeSupported: supported,
      }}
    >
      {children}
    </StickyBoardContext.Provider>
  );
}
