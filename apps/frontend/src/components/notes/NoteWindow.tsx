"use client";

import { useEffect, useRef, useSyncExternalStore, type CSSProperties } from "react";
import {
  getNotes,
  subscribeNotes,
  upsertNote,
  minimizeNote,
  deleteNote,
  NOTE_COLORS,
  noteBodyFontSize,
  type StickyNote,
} from "@/lib/notes";

export function useNotes(): StickyNote[] {
  return useSyncExternalStore(subscribeNotes, getNotes, getNotes);
}

const MIN_W = 280;
const MIN_H = 200;

interface DragState {
  startX: number;
  startY: number;
  origX: number;
  origY: number;
}
interface ResizeState {
  edge: string;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  origX: number;
  origY: number;
}

export function NoteWindow({ note }: { note: StickyNote }) {
  const noteRef = useRef(note);
  noteRef.current = note;
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);

  useEffect(() => {
    const handleMove = (e: PointerEvent) => {
      const current = noteRef.current;
      if (dragRef.current) {
        const { startX, startY, origX, origY } = dragRef.current;
        upsertNote(current.id, {
          x: origX + e.clientX - startX,
          y: origY + e.clientY - startY,
        });
      }
      if (resizeRef.current) {
        const { edge, startX, startY, startW, startH, origX, origY } = resizeRef.current;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const p: Partial<StickyNote> = {};
        if (edge.includes("e")) p.width = Math.max(MIN_W, startW + dx);
        if (edge.includes("s")) p.height = Math.max(MIN_H, startH + dy);
        if (edge.includes("w")) {
          p.width = Math.max(MIN_W, startW - dx);
          p.x = origX + dx - (p.width - startW);
        }
        if (edge.includes("n")) {
          p.height = Math.max(MIN_H, startH - dy);
          p.y = origY + dy - (p.height - startH);
        }
        upsertNote(current.id, p);
      }
    };
    const handleUp = () => {
      dragRef.current = null;
      resizeRef.current = null;
    };
    // Pointer Events unify mouse and touch; listeners stay on the window so
    // dragging continues when the pointer leaves the note.
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, []);

  const onHeaderPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("input, button")) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: note.x,
      origY: note.y,
    };
  };

  const onResizeStart = (edge: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    resizeRef.current = {
      edge,
      startX: e.clientX,
      startY: e.clientY,
      startW: note.width,
      startH: note.height,
      origX: note.x,
      origY: note.y,
    };
  };

  const onWindowPointerDown = () => {
    const z = (getNotes().reduce((max, n) => Math.max(max, n.zIndex || 0), 0) || 0) + 1;
    if ((noteRef.current.zIndex || 0) < z) upsertNote(noteRef.current.id, { zIndex: z });
  };

  const style: CSSProperties = {
    left: note.x,
    top: note.y,
    width: note.width,
    height: note.height,
    zIndex: note.zIndex || 10,
  };

  return (
    <div
      onPointerDown={onWindowPointerDown}
      className="pointer-events-auto absolute flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-surface/85 shadow-glow-lg backdrop-blur-xl"
      style={style}
    >
      <div
        className="flex h-10 shrink-0 cursor-move select-none items-center justify-between gap-2 border-b border-white/10 px-3"
        style={{ touchAction: "none" }}
        onPointerDown={onHeaderPointerDown}
      >
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: note.color }}
          aria-hidden
        />
        <input
          type="text"
          value={note.title}
          onChange={(e) => upsertNote(note.id, { title: e.target.value })}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder="Title"
          className="w-full min-w-0 flex-1 bg-transparent text-sm font-medium text-primary outline-none placeholder:text-muted"
        />
        <button
          onClick={() => minimizeNote(note.id)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-hover hover:text-primary"
          title="Minimize to sidebar"
          aria-label="Minimize note"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
        <button
          onClick={() => {
            if (window.confirm("Delete this note?")) deleteNote(note.id);
          }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-secondary transition-colors hover:bg-danger/20 hover:text-danger"
          title="Delete note"
          aria-label="Delete note"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <textarea
        value={note.content}
        onChange={(e) => upsertNote(note.id, { content: e.target.value })}
        placeholder="Write something..."
        className="w-full flex-1 resize-none bg-transparent p-3 text-sm leading-relaxed text-primary outline-none placeholder:text-muted"
        style={{ fontSize: noteBodyFontSize() }}
      />

      <div className="flex shrink-0 items-center gap-2 border-t border-white/10 px-3 py-2.5">
        {NOTE_COLORS.map((c) => (
          <button
            key={c}
            className={`h-5 w-5 rounded-full border border-white/20 transition-transform hover:scale-110 ${
              note.color === c ? "ring-2 ring-white/70" : ""
            }`}
            style={{ backgroundColor: c }}
            onClick={() => upsertNote(note.id, { color: c })}
            title={c}
            aria-label={`Note color ${c}`}
          />
        ))}
      </div>

      {["nw", "ne", "sw", "se"].map((edge) => (
        <div
          key={edge}
          className="absolute h-7 w-7"
          style={{
            ...(edge.includes("n") ? { top: -14 } : { bottom: -14 }),
            ...(edge.includes("w") ? { left: -14 } : { right: -14 }),
            cursor: `${edge}-resize`,
            // Never let the touch scroll gesture hijack a resize (Pointer Events
            // already unify mouse + touch; this must stay so it is a real hit
            // target, not a scroll region).
            touchAction: "none",
          }}
          onPointerDown={onResizeStart(edge)}
        />
      ))}
    </div>
  );
}

export function NotesOverlay() {
  const notes = useNotes();
  const openNotes = notes.filter((n) => n.open);
  if (openNotes.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      {openNotes.map((n) => (
        <NoteWindow key={n.id} note={n} />
      ))}
    </div>
  );
}
