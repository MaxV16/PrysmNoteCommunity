"use client";

import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { syncNotesFromServer } from "@/lib/notes";
import { useTasks } from "@/hooks/useTasks";

interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
  notes_imported: number;
  errors: { row: number; reason: string }[];
  batch_id?: string;
  total_rows?: number;
}

interface UndoResult {
  deleted_tasks: number;
  deleted_notes: number;
}

const FORMATS = [
  { value: "auto", label: "Auto-detect" },
  { value: "ticktick", label: "TickTick" },
  { value: "todoist", label: "Todoist" },
  { value: "generic", label: "Generic CSV" },
  { value: "ics", label: "iCalendar (.ics)" },
];

const LAST_IMPORT_KEY = "prysm_last_import_batch";
const LARGE_FILE_LINES = 500;

function readLastBatch(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LAST_IMPORT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.batch_id === "string") return parsed.batch_id;
  } catch {
    return null;
  }
  return null;
}

export function ImportPanel() {
  const { fetchTasks } = useTasks();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [largeFile, setLargeFile] = useState(false);
  const [format, setFormat] = useState("auto");
  const [notesAsNotes, setNotesAsNotes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [undoNotice, setUndoNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastBatch, setLastBatch] = useState<string | null>(readLastBatch);
  const [confirmUndo, setConfirmUndo] = useState(false);

  const showNotesToggle = format === "ticktick" || format === "auto";

  const handleFiles = (files: FileList | null) => {
    const f = files?.[0];
    if (f) {
      setFile(f);
      setResult(null);
      setError(null);
      setLargeFile(false);
      // Cheap line count: reading the file text is fine for a warning gate.
      void f.text().then((t) => setLargeFile(t.split("\n").length > LARGE_FILE_LINES));
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    handleFiles(e.dataTransfer.files);
  };

  const persistBatch = (batchId: string) => {
    try {
      window.localStorage.setItem(
        LAST_IMPORT_KEY,
        JSON.stringify({ batch_id: batchId, at: Date.now() })
      );
    } catch {
      // Storage may be unavailable (private mode); undo simply won't be offered.
    }
    setLastBatch(batchId);
  };

  const clearBatch = () => {
    try {
      window.localStorage.removeItem(LAST_IMPORT_KEY);
    } catch {
      // ignore
    }
    setLastBatch(null);
  };

  const submit = async () => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("format", format);
      fd.append("notes_as_notes", String(notesAsNotes));
      const res = await api.upload<ImportResult>("/imports/tasks", fd);
      setResult(res);
      if (res.batch_id) {
        persistBatch(res.batch_id);
      }
      // Merge the new tasks into the store (re-fetches /tasks/ and preserves
      // the lazy far window), and pull down server sticky notes too - they only
      // sync on app mount or an explicit call.
      await fetchTasks();
      if (res.notes_imported > 0) {
        await syncNotesFromServer();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    if (!lastBatch || undoing) return;
    setUndoing(true);
    setError(null);
    setUndoNotice(null);
    try {
      const res = await api.post<UndoResult>("/imports/tasks/undo", {
        batch_id: lastBatch,
      });
      clearBatch();
      await fetchTasks();
      await syncNotesFromServer();
      setUndoNotice(
        `Undone: deleted ${res.deleted_tasks} task${res.deleted_tasks === 1 ? "" : "s"} and ${res.deleted_notes} note${res.deleted_notes === 1 ? "" : "s"}.`
      );
    } catch (e) {
      clearBatch();
      setError(
        e instanceof Error
          ? `Undo failed: ${e.message}`
          : "Undo failed. The batch may already be gone."
      );
    } finally {
      setUndoing(false);
      setConfirmUndo(false);
    }
  };

  const totalRows = result?.total_rows ?? 0;
  const resultLine =
    result && totalRows > 0
      ? `Imported ${result.imported} of ${totalRows} rows (${result.skipped} duplicates, ${result.failed} failed)`
      : null;

  return (
    <section className="card p-6 space-y-5">
      <div className="flex items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl float">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <div>
          <h2 className="text-lg font-bold text-primary">Import</h2>
          <p className="text-sm text-muted">
            Bring tasks from TickTick, Todoist, generic CSVs or iCalendar exports
          </p>
        </div>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") inputRef.current?.click(); }}
        className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging ? "border-accent bg-accent/10" : "border-border bg-elevated hover:border-accent/50"
        }`}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
        {file ? (
          <>
            <p className="text-sm font-semibold text-primary">{file.name}</p>
            <p className="text-xs text-muted">
              {(file.size / 1024).toFixed(1)} KB - click or drop another file to replace
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold text-primary">Drop a file here, or click to browse</p>
            <p className="text-xs text-muted">Supported: .csv (TickTick, Todoist, generic), .ics, .txt</p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.ics,.txt,text/csv,text/calendar,text/plain"
          className="hidden"
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {largeFile && (
        <div className="rounded-xl bg-warning/10 border border-warning/20 px-4 py-2.5 text-sm scale-in" style={{ color: "var(--warning)" }}>
          This file looks large ({file?.name}). Importing a very large file can make the UI slow for a minute. Undo is available after import.
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-xs font-medium text-secondary">Format</label>
          <select className="input-field" value={format} onChange={(e) => setFormat(e.target.value)}>
            {FORMATS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </div>
        {showNotesToggle && (
          <div className="flex items-end pb-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-secondary">
              <input
                type="checkbox"
                checked={notesAsNotes}
                onChange={(e) => setNotesAsNotes(e.target.checked)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              Import TickTick notes as sticky notes
            </label>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={submit}
          disabled={!file || busy}
          className="btn btn-primary px-6 py-2 text-sm disabled:opacity-50"
        >
          {busy ? "Importing..." : "Import"}
        </button>
        {lastBatch && (
          <button
            onClick={() => setConfirmUndo(true)}
            disabled={undoing || busy}
            className="btn bg-elevated border border-border px-4 py-2 text-sm disabled:opacity-50"
          >
            {undoing ? "Undoing..." : "Undo last import"}
          </button>
        )}
        <span className="text-xs text-muted">
          Existing tasks are kept; duplicate rows are skipped, so re-importing the same file is safe.
        </span>
      </div>

      <p className="text-xs text-muted">
        Importing a very large file can make the UI slow for a minute. Undo is available after import.
      </p>

      {confirmUndo && (
        <div className="rounded-xl border border-border bg-elevated p-4 space-y-3 scale-in">
          <p className="text-sm font-semibold text-primary">Undo the last import?</p>
          <p className="text-xs text-muted">
            This deletes every task and note from the last import, including subtasks and all
            recurrence occurrences of imported recurring tasks.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={undo}
              disabled={undoing}
              className="btn px-4 py-1.5 text-sm text-white disabled:opacity-50"
              style={{ background: "var(--danger)" }}
            >
              {undoing ? "Undoing..." : "Yes, undo it"}
            </button>
            <button
              onClick={() => setConfirmUndo(false)}
              disabled={undoing}
              className="btn bg-elevated border border-border px-4 py-1.5 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl bg-danger/10 border border-danger/20 px-4 py-2.5 text-sm text-danger scale-in">
          {error}
        </div>
      )}

      {undoNotice && (
        <div className="rounded-2xl border border-border bg-elevated p-4 scale-in">
          <p className="text-sm font-semibold text-primary">Import undone</p>
          <p className="mt-1 text-xs text-secondary">{undoNotice}</p>
        </div>
      )}

      {result && (
        <div className="rounded-2xl border border-border bg-elevated p-4 space-y-3 scale-in">
          <p className="text-sm font-semibold text-primary">Import complete</p>
          {resultLine && (
            <p className="text-xs text-secondary">{resultLine}</p>
          )}
          {totalRows > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-xl bg-success/10 border border-success/20 px-3 py-2">
                <p className="text-lg font-bold text-success">{result.imported}</p>
                <p className="text-[10px] text-muted">Imported</p>
              </div>
              <div className="rounded-xl bg-muted/10 border border-border px-3 py-2">
                <p className="text-lg font-bold text-primary">{result.skipped}</p>
                <p className="text-[10px] text-muted">Skipped (duplicates)</p>
              </div>
              <div className="rounded-xl bg-warning/10 border border-warning/20 px-3 py-2">
                <p className="text-lg font-bold" style={{ color: "var(--warning)" }}>{result.failed}</p>
                <p className="text-[10px] text-muted">Failed</p>
              </div>
              <div className="rounded-xl bg-accent/10 border border-accent/20 px-3 py-2">
                <p className="text-lg font-bold text-accent">{result.notes_imported}</p>
                <p className="text-[10px] text-muted">Sticky notes</p>
              </div>
            </div>
          )}
          {result.errors.length > 0 && (
            <div className="space-y-1.5 pt-1">
              <p className="text-xs font-medium text-secondary">
                {result.errors.length > 3 ? `First ${Math.min(3, result.errors.length)} of ${result.errors.length} warnings:` : "Warnings:"}
              </p>
              {result.errors.slice(0, 3).map((err, i) => (
                <p key={i} className="text-[11px] text-muted">
                  Row {err.row}: {err.reason}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
