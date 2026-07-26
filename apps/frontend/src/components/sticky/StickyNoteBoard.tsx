"use client";

import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";

interface StickyNote {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
  content: string;
  color: string;
}

const STORAGE_KEY = "prysm_sticky_notes";
const COLORS = ["#fbbf24", "#f87171", "#60a5fa", "#34d399", "#a78bfa", "#f472b6", "#fb923c", "#94a3b8"];

function generateId(): string {
  return `sticky_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function loadNotes(): StickyNote[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveNotes(notes: StickyNote[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  } catch {}
}

interface StickyBoardContextValue {
  isOpen: boolean;
  toggle: () => void;
  open: () => void;
  close: () => void;
  addNoteWithContent: (title: string, content: string) => void;
}

const StickyBoardContext = createContext<StickyBoardContextValue>({
  isOpen: false,
  toggle: () => {},
  open: () => {},
  close: () => {},
  addNoteWithContent: () => {},
});

export function useStickyBoard(): StickyBoardContextValue {
  return useContext(StickyBoardContext);
}

export function StickyBoardProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [notes, setNotes] = useState<StickyNote[]>([]);

  useEffect(() => {
    setNotes(loadNotes());
  }, [isOpen]);

  const persist = useCallback(
    (updated: StickyNote[]) => {
      setNotes(updated);
      saveNotes(updated);
    },
    []
  );

  const toggle = useCallback(() => setIsOpen((v) => !v), []);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const addNoteWithContent = useCallback((title: string, content: string) => {
    const cx = typeof window !== "undefined" ? window.innerWidth / 2 - 130 : 300;
    const cy = typeof window !== "undefined" ? window.innerHeight / 2 - 100 : 200;
    const note: StickyNote = {
      id: generateId(),
      x: cx,
      y: cy,
      width: 260,
      height: 200,
      title,
      content,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    };
    const current = loadNotes();
    current.push(note);
    saveNotes(current);
    setNotes(current);
    setIsOpen(true);
  }, []);

  return (
    <StickyBoardContext.Provider value={{ isOpen, toggle, open, close, addNoteWithContent }}>
      {children}
      <StickyNoteBoard />
    </StickyBoardContext.Provider>
  );
}

function StickyNoteBoard() {
  const { isOpen } = useContext(StickyBoardContext);
  const [notes, setNotes] = useState<StickyNote[]>([]);
  const [_, setRender] = useState(0);
  const dragRef = useRef<{ noteId: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ noteId: string; startW: number; startH: number; origX: number; origY: number; startX: number; startY: number; edge: string } | null>(null);

  const isMobileOrTablet = typeof window !== "undefined" && (/Mobi|Android|iPad|iPhone|iPod/.test(navigator.userAgent) || window.innerWidth < 1024);

  useEffect(() => {
    setNotes(loadNotes());
  }, [isOpen]);

  const persist = useCallback(
    (updated: StickyNote[]) => {
      setNotes(updated);
      saveNotes(updated);
    },
    []
  );

  const addNote = useCallback(() => {
    const cx = typeof window !== "undefined" ? window.innerWidth / 2 - 130 : 300;
    const cy = typeof window !== "undefined" ? window.innerHeight / 2 - 100 : 200;
    const note: StickyNote = {
      id: generateId(),
      x: cx,
      y: cy,
      width: 260,
      height: 200,
      title: "",
      content: "",
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    };
    persist([...notes, note]);
  }, [notes, persist]);

  const deleteNote = useCallback(
    (id: string) => {
      persist(notes.filter((n) => n.id !== id));
    },
    [notes, persist]
  );

  const updateNote = useCallback(
    (id: string, patch: Partial<StickyNote>) => {
      persist(notes.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    },
    [notes, persist]
  );

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (dragRef.current) {
        const dx = e.clientX - dragRef.current.startX;
        const dy = e.clientY - dragRef.current.startY;
        updateNote(dragRef.current.noteId, {
          x: dragRef.current.origX + dx,
          y: dragRef.current.origY + dy,
        });
      }
      if (resizeRef.current) {
        const dx = e.clientX - resizeRef.current.startX;
        const dy = e.clientY - resizeRef.current.startY;
        const { edge, noteId, startW, startH, origX: sx, origY: sy } = resizeRef.current;
        const note = notes.find((n) => n.id === noteId);
        if (!note) return;
        const patch: Partial<StickyNote> = {};
        if (edge.includes("e")) patch.width = Math.max(180, startW + dx);
        if (edge.includes("s")) patch.height = Math.max(120, startH + dy);
        if (edge.includes("w")) {
          patch.width = Math.max(180, startW - dx);
          patch.x = sx + dx - (patch.width - startW);
        }
        if (edge.includes("n")) {
          patch.height = Math.max(120, startH - dy);
          patch.y = sy + dy - (patch.height - startH);
        }
        updateNote(noteId, patch);
      }
    };

    const handleMouseUp = () => {
      dragRef.current = null;
      resizeRef.current = null;
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [notes, updateNote]);

  if (!isOpen || isMobileOrTablet) return null;

  return (
    <div className="fixed inset-0 z-50 pointer-events-none">
      <div className="absolute top-4 left-1/2 -translate-x-1/2 pointer-events-auto">
        <button
          onClick={addNote}
          className="btn bg-accent text-base px-4 py-2 rounded-lg shadow-lg hover:opacity-90 transition-opacity text-sm font-medium"
        >
          + New Note
        </button>
      </div>

      {notes.map((note) => (
        <div
          key={note.id}
          className="absolute pointer-events-auto rounded-xl shadow-sm"
          style={{
            left: note.x,
            top: note.y,
            width: note.width,
            height: note.height,
          }}
        >
          <div
            className="h-8 rounded-t-xl cursor-move flex items-center justify-between px-3"
            style={{ backgroundColor: note.color }}
            onMouseDown={(e) => {
              e.preventDefault();
              dragRef.current = {
                noteId: note.id,
                startX: e.clientX,
                startY: e.clientY,
                origX: note.x,
                origY: note.y,
              };
            }}
          >
            <input
              type="text"
              value={note.title}
              onChange={(e) => updateNote(note.id, { title: e.target.value })}
              onMouseDown={(e) => e.stopPropagation()}
              placeholder="Title"
              className="bg-transparent text-white placeholder-white/50 text-sm font-medium outline-none w-[calc(100%-28px)]"
            />
            <button
              onClick={() => deleteNote(note.id)}
              className="text-white/70 hover:text-white text-sm leading-none"
              title="Delete note"
            >
              ✕
            </button>
          </div>

          <textarea
            value={note.content}
            onChange={(e) => updateNote(note.id, { content: e.target.value })}
            placeholder="Write something..."
            className="w-full h-[calc(100%-60px)] bg-white/95 dark:bg-gray-800/95 text-primary text-sm p-3 outline-none resize-none placeholder-muted"
          />

          <div className="h-7 bg-white/90 dark:bg-gray-800/90 rounded-b-xl flex items-center gap-1 px-2">
            {COLORS.map((c) => (
              <button
                key={c}
                className="h-4 w-4 rounded-full border border-white/30 hover:scale-110 transition-transform"
                style={{ backgroundColor: c, outline: note.color === c ? "2px solid #fff" : undefined }}
                onClick={() => updateNote(note.id, { color: c })}
                title={c}
              />
            ))}
          </div>

          {["nw", "ne", "sw", "se"].map((edge) => (
            <div
              key={edge}
              className="absolute w-3 h-3"
              style={{
                ...(edge.includes("n") ? { top: -3 } : { bottom: -3 }),
                ...(edge.includes("w") ? { left: -3 } : { right: -3 }),
                cursor: `${edge}-resize`,
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                resizeRef.current = {
                  noteId: note.id,
                  startW: note.width,
                  startH: note.height,
                  origX: note.x,
                  origY: note.y,
                  startX: e.clientX,
                  startY: e.clientY,
                  edge,
                };
              }}
            />
          ))}
        </div>
      ))}

      {notes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-muted text-sm">Click &quot;+ New Note&quot; to add a sticky note</p>
        </div>
      )}
    </div>
  );
}
