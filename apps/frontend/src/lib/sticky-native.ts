"use client";

import { useEffect, useRef, useState } from "react";
import {
  getNotes,
  subscribeNotes,
  upsertNote,
  minimizeNote,
  deleteNote,
  isNativeStickySupported,
  openNativeStickyNote,
  closeNativeStickyNote,
  updateNativeStickyNote,
  setNativeStickyAlwaysOnTop,
  getNativeStickyByNoteId,
  subscribeNativeStickyClosed,
  subscribeNativeStickyNoteUpdated,
  subscribeNativeStickyNoteMinimized,
  type StickyNote,
  type NativeStickyWindowInfo,
} from "@/lib/notes";

interface UseNativeStickyNotesReturn {
  supported: boolean;
  nativeWindows: Map<string, NativeStickyWindowInfo>;
  openNativeWindow: (noteId: string) => Promise<void>;
  closeNativeWindow: (noteId: string) => Promise<void>;
  syncNativeWindow: (noteId: string) => Promise<void>;
  isNativeOpen: (noteId: string) => boolean;
}

const nativeWindowsRef = new Map<string, NativeStickyWindowInfo>();
const listenersRef = new Set<() => void>();

function emit() {
  listenersRef.forEach((l) => l());
}

export function useNativeStickyNotes(): UseNativeStickyNotesReturn {
  const [supported, setSupported] = useState(false);
  const [, forceUpdate] = useState(0);
  const initializedRef = useRef(false);

  useEffect(() => {
    const checkSupported = isNativeStickySupported();
    setSupported(checkSupported);

    if (checkSupported && !initializedRef.current) {
      initializedRef.current = true;

      const unsubClosed = subscribeNativeStickyClosed((data) => {
        nativeWindowsRef.delete(data.windowId);
        emit();
      });

      const unsubUpdated = subscribeNativeStickyNoteUpdated((data) => {
        const winInfo = nativeWindowsRef.get(data.noteId ? `sticky_${data.noteId}` : "");
        if (winInfo) {
          nativeWindowsRef.set(winInfo.windowId, { ...winInfo, ...data });
        }
        emit();
      });

      const unsubMinimized = subscribeNativeStickyNoteMinimized((data) => {
        const note = getNotes().find((n) => n.id === data.noteId);
        if (note) {
          nativeWindowsRef.delete(`sticky_${data.noteId}`);
        }
        emit();
      });

      return () => {
        unsubClosed();
        unsubUpdated();
        unsubMinimized();
      };
    }
  }, []);

  const subscribe = (listener: () => void) => {
    listenersRef.add(listener);
    return () => listenersRef.delete(listener);
  };

  useEffect(() => {
    const listener = () => forceUpdate((n) => n + 1);
    const cleanup = subscribe(listener);
    return () => {
      cleanup();
    };
  }, []);

  const openNativeWindow = async (noteId: string) => {
    if (!supported) return;
    const note = getNotes().find((n) => n.id === noteId);
    if (!note) return;

    const existing = await getNativeStickyByNoteId(noteId);
    if (existing) {
      return;
    }

    const windowId = await openNativeStickyNote(note);
    if (windowId) {
      nativeWindowsRef.set(windowId, {
        windowId,
        noteId: note.id,
        bounds: { x: note.x, y: note.y, width: note.width, height: note.height },
        alwaysOnTop: true,
      });
      emit();
    }
  };

  const closeNativeWindow = async (noteId: string) => {
    if (!supported) return;
    const windowId = `sticky_${noteId}`;
    const winInfo = nativeWindowsRef.get(windowId);
    if (winInfo) {
      await closeNativeStickyNote(windowId);
      nativeWindowsRef.delete(windowId);
      emit();
    }
  };

  const syncNativeWindow = async (noteId: string) => {
    if (!supported) return;
    const note = getNotes().find((n) => n.id === noteId);
    if (!note) return;

    const winInfo = nativeWindowsRef.get(`sticky_${noteId}`);
    if (winInfo) {
      await updateNativeStickyNote(winInfo.windowId, {
        x: note.x,
        y: note.y,
        width: note.width,
        height: note.height,
        color: note.color,
        title: note.title,
        content: note.content,
        minimized: note.minimized,
      });
    }
  };

  const isNativeOpen = (noteId: string) => {
    return nativeWindowsRef.has(`sticky_${noteId}`);
  };

  return {
    supported,
    nativeWindows: nativeWindowsRef,
    openNativeWindow,
    closeNativeWindow,
    syncNativeWindow,
    isNativeOpen,
  };
}

export function useNativeStickyNote(noteId: string) {
  const { supported, isNativeOpen, openNativeWindow, closeNativeWindow, syncNativeWindow } =
    useNativeStickyNotes();

  const isOpen = isNativeOpen(noteId);

  return {
    supported,
    isOpen,
    open: () => openNativeWindow(noteId),
    close: () => closeNativeWindow(noteId),
    sync: () => syncNativeWindow(noteId),
  };
}