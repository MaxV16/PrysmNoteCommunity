"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  upsertNote,
  minimizeNote,
  deleteNote,
  getNotes,
  subscribeNotes,
  syncNotesFromServer,
  NOTE_COLORS,
  noteBodyFontSize,
  type StickyNote,
} from "@/lib/notes";

const MIN_W = 280;
const MIN_H = 200;

interface ResizeState {
  startScreenX: number;
  startScreenY: number;
  startW: number;
  startH: number;
}

interface StickyBridge {
  sendUpdate: (patch: Partial<StickyNote>) => void;
  sendClose: () => void;
  sendAlwaysOnTop: (onTop: boolean) => void;
}

type RegionStyle = CSSProperties & { WebkitAppRegion?: "drag" | "no-drag" };

const DRAG: RegionStyle = { WebkitAppRegion: "drag" };
const NO_DRAG: RegionStyle = { WebkitAppRegion: "no-drag" };

export function StickyNoteRenderer({ noteId }: { noteId: string }) {
  const [note, setNote] = useState<StickyNote | null>(null);
  const noteRef = useRef<StickyNote | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const isNativeRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const bridge = (window as Window & { prysmSticky?: any }).prysmSticky;
    isNativeRef.current = !!bridge;

    let cancelled = false;

    // The note lives in the local store. Rendering from it fills the window
    // even when the native `sticky:init` message lands before this effect
    // subscribes, and keeps the UI in sync with local edits.
    const applyFromStore = () => {
      if (cancelled) return;
      const next = getNotes().find((x) => x.id === noteId) || null;
      if (next) {
        setNote({ ...next });
        noteRef.current = next;
        return;
      }
      // The note is gone: it was deleted here or on another device. Close this
      // window instead of leaving a stale note on screen.
      if (noteRef.current) {
        noteRef.current = null;
        if (bridge) bridge.sendClose?.();
        else window.close();
      }
    };
    applyFromStore();
    void syncNotesFromServer().then(applyFromStore).catch(applyFromStore);
    const unsubscribeStore = subscribeNotes(applyFromStore);

    if (!bridge) {
      return () => {
        cancelled = true;
        unsubscribeStore();
      };
    }

    bridge.onInit((data: StickyNote) => {
      if (!getNotes().some((n) => n.id === data.id)) {
        noteRef.current = data;
        setNote({ ...data });
      } else {
        applyFromStore();
      }
    });

    bridge.onUpdate((patch: Partial<StickyNote>) => {
      const current = noteRef.current;
      if (!current) return;
      const merged = { ...current, ...patch };
      noteRef.current = merged;
      setNote({ ...merged });
    });

    // Resize from the bottom-right corner only. The window origin stays put,
    // so the pointer's screen delta stays honest (moving the origin mid-gesture
    // is what made the window twitch and cancel itself out).
    const handleResizeMove = (e: PointerEvent) => {
      const r = resizeRef.current;
      const current = noteRef.current;
      if (!r || !current) return;
      const width = Math.max(MIN_W, r.startW + (e.screenX - r.startScreenX));
      const height = Math.max(MIN_H, r.startH + (e.screenY - r.startScreenY));
      if (width === current.width && height === current.height) return;
      upsertNote(current.id, { width, height });
      bridge.sendUpdate({ width, height });
    };

    const handleResizeEnd = () => {
      resizeRef.current = null;
    };

    window.addEventListener("pointermove", handleResizeMove);
    window.addEventListener("pointerup", handleResizeEnd);
    window.addEventListener("pointercancel", handleResizeEnd);

    return () => {
      cancelled = true;
      unsubscribeStore();
      window.removeEventListener("pointermove", handleResizeMove);
      window.removeEventListener("pointerup", handleResizeEnd);
      window.removeEventListener("pointercancel", handleResizeEnd);
    };
  }, [noteId]);

  if (!note) return null;

  const native = isNativeRef.current;
  const stickyBridge = () =>
    (window as Window & { prysmSticky?: StickyBridge }).prysmSticky;

  const handleMinimize = () => {
    minimizeNote(note.id);
    if (native) {
      stickyBridge()?.sendClose();
    } else if (typeof window !== "undefined") {
      window.close();
    }
  };

  const handleDelete = () => {
    if (window.confirm("Delete this note?")) {
      deleteNote(note.id);
      if (native) {
        stickyBridge()?.sendClose();
      } else if (typeof window !== "undefined") {
        window.close();
      }
    }
  };

  const handleColorChange = (color: string) => {
    upsertNote(note.id, { color });
    if (native) stickyBridge()?.sendUpdate({ color });
  };

  const handleAlwaysOnTopChange = (onTop: boolean) => {
    upsertNote(note.id, { alwaysOnTop: onTop });
    if (native) stickyBridge()?.sendAlwaysOnTop(onTop);
  };

  const onWindowPointerDown = () => {
    const z = (note.zIndex || 10) + 1;
    if ((note.zIndex || 0) < z) {
      upsertNote(note.id, { zIndex: z });
    }
  };

  const onResizeStart = (e: React.PointerEvent) => {
    e.stopPropagation();
    resizeRef.current = {
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      startW: note.width,
      startH: note.height,
    };
  };

  // The native sticky window is already positioned and sized on screen by the
  // desktop shell, so the note fills its viewport (0,0).
  const style: CSSProperties = native
    ? { left: 0, top: 0, width: "100%", height: "100%", zIndex: note.zIndex || 10 }
    : { left: 0, top: 0, width: "100vw", height: "100vh", zIndex: note.zIndex || 10 };

  return (
    <div
      onPointerDown={onWindowPointerDown}
      className={`pointer-events-auto absolute flex flex-col overflow-hidden border border-border bg-surface/95 shadow-glow-lg backdrop-blur-xl ${
        native ? "rounded-2xl" : "inset-0 rounded-none"
      }`}
      style={style}
    >
      <div
        className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border px-3"
        style={{ touchAction: "none", ...(native ? DRAG : {}) }}
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: note.color }}
          aria-hidden
        />
        <div className="flex-1" />
        <div className="flex items-center gap-1" style={NO_DRAG}>
          {native && (
            <button
              onClick={() => handleAlwaysOnTopChange(!note.alwaysOnTop)}
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
                note.alwaysOnTop ? "bg-accent/20 text-accent" : "text-secondary hover:bg-hover hover:text-primary"
              }`}
              title={note.alwaysOnTop ? "Stop keeping on top" : "Keep this note on top"}
              aria-label={note.alwaysOnTop ? "Stop keeping on top" : "Keep this note on top"}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 17v5M5 10V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3l-2 2v3H7v-3l-2-2Z" />
              </svg>
            </button>
          )}
          <button
            onClick={handleMinimize}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-hover hover:text-primary"
            title="Minimize to sidebar"
            aria-label="Minimize note"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          </button>
          <button
            onClick={handleDelete}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-danger/20 hover:text-danger"
            title="Delete note"
            aria-label="Delete note"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <input
        type="text"
        value={note.title}
        onChange={(e) => {
          const patch = { title: e.target.value };
          upsertNote(note.id, patch);
          if (native) stickyBridge()?.sendUpdate(patch);
        }}
        placeholder="Title"
        className="w-full shrink-0 bg-transparent px-3 pt-2.5 text-sm font-semibold text-primary outline-none placeholder:text-muted"
      />

      <textarea
        value={note.content}
        onChange={(e) => {
          const patch = { content: e.target.value };
          upsertNote(note.id, patch);
          if (native) stickyBridge()?.sendUpdate(patch);
        }}
        placeholder="Write something..."
        className="w-full flex-1 resize-none bg-transparent px-3 py-2 text-sm leading-relaxed text-primary outline-none placeholder:text-muted"
        style={{ fontSize: noteBodyFontSize() }}
      />

      <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2.5">
        {NOTE_COLORS.map((c) => (
          <button
            key={c}
            className={`h-5 w-5 rounded-full border border-border transition-transform hover:scale-110 ${
              note.color === c ? "ring-2 ring-accent" : ""
            }`}
            style={{ backgroundColor: c }}
            onClick={() => handleColorChange(c)}
            title={c}
            aria-label={`Note color ${c}`}
          />
        ))}
      </div>

      {native && (
        <div
          className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
          style={{ touchAction: "none", ...NO_DRAG }}
          onPointerDown={onResizeStart}
          aria-hidden
        />
      )}
    </div>
  );
}
