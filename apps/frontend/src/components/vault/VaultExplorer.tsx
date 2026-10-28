"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AiPanelButton } from "@/components/ui/AiPanelButton";
import { Modal } from "@/components/ui/Modal";
import { useForegroundRefresh } from "@/hooks/useForegroundRefresh";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast-context";

export interface VaultNote {
  id: string;
  title: string;
  tags: string[];
  aliases: string[];
  folder: string;
  pinned: boolean;
  created_at: string | null;
  updated_at: string | null;
  snippet: string;
}

export interface VaultOutgoingLink {
  title: string;
  note_id: string | null;
}

export interface VaultBacklink {
  id: string;
  title: string;
}

export interface VaultNoteDetail extends VaultNote {
  body: string;
  backlinks: VaultBacklink[];
  links: VaultOutgoingLink[];
  revision_count: number;
}

interface VaultRevision {
  id: string;
  title: string;
  body: string;
  tags: string[];
  created_at: string | null;
}

interface VaultTemplate {
  id: string;
  name: string;
  body: string;
}

interface VaultTag {
  tag: string;
  count: number;
}

interface VaultStats {
  notes: number;
  links: number;
  tags: number;
  templates: number;
  embedded_chunks: number;
  last_updated: string | null;
  semantic_search: boolean;
  caps?: { notes?: number; body_chars?: number };
}

interface VaultExplorerProps {
  onOpenAi?: () => void;
}

type SearchMode = "text" | "semantic";

const LIST_LIMIT = 100;
const SEARCH_DEBOUNCE_MS = 300;

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function VaultExplorer({ onOpenAi }: VaultExplorerProps) {
  const { showToast } = useToast();

  const [notes, setNotes] = useState<VaultNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [tags, setTags] = useState<VaultTag[]>([]);
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("text");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<VaultNote[] | null>(null);
  const [searchMode, setSearchMode] = useState<SearchMode>("text");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<VaultNoteDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [folder, setFolder] = useState("");
  const [pinned, setPinned] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const [templates, setTemplates] = useState<VaultTemplate[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revisions, setRevisions] = useState<VaultRevision[]>([]);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureText, setCaptureText] = useState("");
  const [captureTitle, setCaptureTitle] = useState("");
  const [importing, setImporting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadMeta = useCallback(async () => {
    try {
      const [tagData, statsData, templateData] = await Promise.all([
        api.get<{ tags: VaultTag[] }>("/vault/tags"),
        api.get<VaultStats>("/vault/stats"),
        api.get<{ templates: VaultTemplate[] }>("/vault/templates"),
      ]);
      setTags(tagData.tags ?? []);
      setStats(statsData);
      setTemplates(templateData.templates ?? []);
    } catch {
      // Meta is decoration around the notes themselves: a failure here must
      // never hide the vault.
    }
  }, []);

  const loadList = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: String(LIST_LIMIT) });
      if (activeTag) params.set("tag", activeTag);
      const data = await api.get<{ notes: VaultNote[] }>(`/vault/notes?${params.toString()}`);
      setNotes(data.notes ?? []);
      setListError(null);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Could not load the vault");
    } finally {
      setLoading(false);
    }
  }, [activeTag]);

  useEffect(() => {
    setLoading(true);
    void loadList();
  }, [loadList]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  useForegroundRefresh(() => {
    void loadList();
    void loadMeta();
  });

  // Search is debounced and reads the ranked endpoint, so typing a phrase does
  // not refetch on every keystroke.
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: trimmed, mode, limit: "50" });
        const data = await api.get<{ results: VaultNote[]; mode?: SearchMode }>(
          `/vault/search?${params.toString()}`
        );
        if (cancelled) return;
        setSearchResults(data.results ?? []);
        setSearchMode(data.mode === "semantic" ? "semantic" : "text");
      } catch (error) {
        if (cancelled) return;
        setSearchResults([]);
        showToast(error instanceof Error ? error.message : "Search failed", "error");
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, mode, showToast]);

  const applyDetail = useCallback((note: VaultNoteDetail) => {
    setDetail(note);
    setTitle(note.title);
    setBody(note.body);
    setTagInput(note.tags.join(", "));
    setFolder(note.folder ?? "");
    setPinned(Boolean(note.pinned));
    setDirty(false);
  }, []);

  const selectNote = useCallback(
    async (id: string) => {
      if (dirty && !window.confirm("Discard unsaved changes to this note?")) return;
      setSelectedId(id);
      setDetailLoading(true);
      try {
        const note = await api.get<VaultNoteDetail>(`/vault/notes/${id}`);
        applyDetail(note);
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Could not open the note", "error");
        setSelectedId(null);
        setDetail(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [applyDetail, dirty, showToast]
  );

  const refreshAfterWrite = useCallback(async () => {
    await loadList();
    void loadMeta();
  }, [loadList, loadMeta]);

  const createNote = useCallback(
    async (preset?: { title?: string; body?: string }) => {
      if (dirty && !window.confirm("Discard unsaved changes to this note?")) return;
      try {
        const created = await api.post<{ id: string }>("/vault/notes", {
          title: preset?.title || "Untitled note",
          body: preset?.body || "",
          tags: [],
          aliases: [],
          folder: "",
        });
        await refreshAfterWrite();
        setTemplatesOpen(false);
        await selectNote(created.id);
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Could not create the note", "error");
      }
    },
    [dirty, refreshAfterWrite, selectNote, showToast]
  );

  const saveNote = useCallback(async () => {
    if (!selectedId || saving) return;
    const trimmed = title.trim();
    if (!trimmed) {
      showToast("A note needs a title", "warning");
      return;
    }
    setSaving(true);
    try {
      const updated = await api.patch<VaultNoteDetail>(`/vault/notes/${selectedId}`, {
        title: trimmed,
        body,
        tags: splitList(tagInput),
        folder: folder.trim(),
        pinned,
      });
      applyDetail(updated);
      await refreshAfterWrite();
      showToast("Note saved", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not save the note", "error");
    } finally {
      setSaving(false);
    }
  }, [
    applyDetail,
    body,
    folder,
    pinned,
    refreshAfterWrite,
    saving,
    selectedId,
    showToast,
    tagInput,
    title,
  ]);

  const deleteNote = useCallback(async () => {
    if (!selectedId) return;
    if (!window.confirm(`Delete "${title || "this note"}"? This cannot be undone.`)) return;
    try {
      await api.delete(`/vault/notes/${selectedId}`);
      setSelectedId(null);
      setDetail(null);
      setDirty(false);
      await refreshAfterWrite();
      showToast("Note deleted", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not delete the note", "error");
    }
  }, [refreshAfterWrite, selectedId, showToast, title]);

  const openHistory = useCallback(async () => {
    if (!selectedId) return;
    setHistoryOpen(true);
    try {
      const data = await api.get<{ revisions: VaultRevision[] }>(
        `/vault/notes/${selectedId}/revisions`
      );
      setRevisions(data.revisions ?? []);
    } catch (error) {
      setRevisions([]);
      showToast(error instanceof Error ? error.message : "Could not load history", "error");
    }
  }, [selectedId, showToast]);

  const restoreRevision = useCallback(
    async (revisionId: string) => {
      if (!selectedId) return;
      if (dirty && !window.confirm("Discard unsaved changes and restore this revision?")) return;
      try {
        const note = await api.post<VaultNoteDetail>(
          `/vault/notes/${selectedId}/revisions/${revisionId}/restore`
        );
        applyDetail(note);
        setHistoryOpen(false);
        await refreshAfterWrite();
        showToast("Revision restored", "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Could not restore", "error");
      }
    },
    [applyDetail, dirty, refreshAfterWrite, selectedId, showToast]
  );

  const submitCapture = useCallback(async () => {
    const text = captureText.trim();
    if (!text) return;
    try {
      const created = await api.post<{ id: string }>("/vault/capture", {
        title: captureTitle.trim() || undefined,
        text,
        tags: [],
      });
      setCaptureOpen(false);
      setCaptureText("");
      setCaptureTitle("");
      await refreshAfterWrite();
      if (created.id) await selectNote(created.id);
      showToast("Captured to the vault", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not capture that", "error");
    }
  }, [captureText, captureTitle, refreshAfterWrite, selectNote, showToast]);

  const exportVault = useCallback(async () => {
    try {
      const bundle = await api.get<unknown>("/vault/export");
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `prysm-vault-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
      showToast("Vault exported", "success");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Export failed", "error");
    }
  }, [showToast]);

  const importVault = useCallback(
    async (file: File) => {
      setImporting(true);
      try {
        const raw = await file.text();
        const parsed = JSON.parse(raw) as { notes?: unknown };
        if (!Array.isArray(parsed.notes) || parsed.notes.length === 0) {
          throw new Error("That file has no notes to import");
        }
        const result = await api.post<{ created: number; skipped: number }>("/vault/import", {
          notes: parsed.notes,
        });
        await refreshAfterWrite();
        showToast(`Imported ${result.created} notes`, "success");
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Import failed", "error");
      } finally {
        setImporting(false);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [refreshAfterWrite, showToast]
  );

  const deleteTemplate = useCallback(
    async (id: string) => {
      try {
        await api.delete(`/vault/templates/${id}`);
        setTemplates((prev) => prev.filter((template) => template.id !== id));
      } catch (error) {
        showToast(error instanceof Error ? error.message : "Could not delete the template", "error");
      }
    },
    [showToast]
  );

  const visibleNotes = searchResults ?? notes;
  const activeNote = useMemo(
    () => visibleNotes.find((note) => note.id === selectedId) ?? null,
    [selectedId, visibleNotes]
  );

  const heading = searchResults ? "Results" : activeTag ? `#${activeTag}` : "Notes";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-surface px-4 py-2">
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M4 19.5V5a2 2 0 0 1 2-2h9l5 5v11.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5Z" />
          <path d="M14 3v6h6" />
        </svg>
        <span className="text-sm font-semibold text-primary">Vault</span>
        {stats && (
          <span className="badge bg-elevated text-secondary tnum" data-testid="vault-stats">
            {stats.notes} notes
          </span>
        )}

        <div className="relative ml-auto w-full sm:w-64">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search notes..."
            aria-label="Search notes"
            className="input-field pl-8 text-xs"
          />
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
          </span>
        </div>

        <div className="flex items-center gap-0.5 rounded-full bg-elevated p-0.5" role="group" aria-label="Search mode">
          {(["text", "semantic"] as SearchMode[]).map((option) => (
            <button
              key={option}
              onClick={() => setMode(option)}
              aria-pressed={mode === option}
              className={`rounded-full px-2.5 py-0.5 text-[11px] transition-colors ${
                mode === option
                  ? "bg-accent font-semibold text-[var(--on-gradient)]"
                  : "text-secondary hover:text-primary"
              }`}
            >
              {option === "text" ? "Text" : "Semantic"}
            </button>
          ))}
        </div>

        <button
          onClick={() => setCaptureOpen(true)}
          className="btn bg-elevated border border-border px-3 py-1.5 text-xs"
        >
          Capture
        </button>
        <button
          onClick={() => void createNote()}
          className="btn btn-primary px-3 py-1.5 text-xs"
        >
          + New note
        </button>
        {onOpenAi && <AiPanelButton onClick={onOpenAi} />}
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
              {heading}
            </span>
            {searching && <span className="text-[10px] text-muted">searching...</span>}
            <button
              onClick={() => setTemplatesOpen(true)}
              className="ml-auto text-[11px] text-secondary hover:text-primary"
              title="Templates"
            >
              Templates
            </button>
          </div>

          {tags.length > 0 && (
            <div className="flex max-h-20 shrink-0 flex-wrap gap-1 overflow-y-auto border-b border-border px-3 py-2">
              {activeTag && (
                <button
                  onClick={() => setActiveTag(null)}
                  className="badge bg-accent/15 text-accent"
                >
                  Clear
                </button>
              )}
              {tags.slice(0, 24).map((tag) => (
                <button
                  key={tag.tag}
                  onClick={() => setActiveTag(activeTag === tag.tag ? null : tag.tag)}
                  className={`badge ${
                    activeTag === tag.tag
                      ? "bg-accent font-semibold text-[var(--on-gradient)]"
                      : "bg-elevated text-secondary hover:text-primary"
                  }`}
                >
                  {tag.tag} <span className="tnum">{tag.count}</span>
                </button>
              ))}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading ? (
              <p className="px-3 py-3 text-xs text-muted">Loading your vault...</p>
            ) : listError ? (
              <p className="px-3 py-3 text-xs text-danger">{listError}</p>
            ) : visibleNotes.length === 0 ? (
              <p className="px-3 py-3 text-xs text-secondary">
                {searchResults ? "No notes match that search." : "No notes yet."}
              </p>
            ) : (
              visibleNotes.map((note) => (
                <button
                  key={note.id}
                  onClick={() => void selectNote(note.id)}
                  aria-current={note.id === selectedId ? "page" : undefined}
                  className={`flex w-full flex-col gap-1 border-b border-border px-3 py-2 text-left transition-colors hover:bg-hover ${
                    note.id === selectedId ? "bg-accent/10" : ""
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    {note.pinned && <span className="text-accent" aria-label="Pinned">*</span>}
                    <span className="truncate text-[13px] font-medium text-primary">
                      {note.title}
                    </span>
                  </span>
                  {note.snippet && (
                    <span className="line-clamp-2 text-[11px] leading-snug text-muted">
                      {note.snippet}
                    </span>
                  )}
                  <span className="flex items-center gap-1.5 text-[10px] text-muted">
                    <span className="tnum">{formatWhen(note.updated_at)}</span>
                    {note.tags.slice(0, 3).map((tag) => (
                      <span key={tag} className="text-accent">
                        #{tag}
                      </span>
                    ))}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="flex shrink-0 items-center gap-3 border-t border-border px-3 py-2">
            <button
              onClick={() => void exportVault()}
              className="text-[11px] text-secondary hover:text-primary"
            >
              Export
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="text-[11px] text-secondary hover:text-primary disabled:opacity-50"
            >
              {importing ? "Importing..." : "Import"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              data-testid="vault-import-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importVault(file);
              }}
            />
            {stats && (
              <span className="ml-auto text-[10px] text-muted tnum">
                {stats.links} links
              </span>
            )}
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!selectedId ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 19.5V5a2 2 0 0 1 2-2h9l5 5v11.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19.5Z" />
                  <path d="M14 3v6h6" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-primary">Your vault is a writing surface</p>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-secondary">
                  Notes are markdown-ish text with tags, aliases and <code>[[wikilinks]]</code>.
                  The same vault is readable by the AI assistant and by MCP clients.
                </p>
              </div>
              <button
                onClick={() => void createNote()}
                className="btn-gradient rounded-xl px-4 py-2 text-xs font-semibold"
              >
                Write the first note
              </button>
            </div>
          ) : detailLoading && !detail ? (
            <p className="px-4 py-4 text-xs text-muted">Opening note...</p>
          ) : (
            <>
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-4 py-2">
                <input
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setDirty(true);
                  }}
                  aria-label="Note title"
                  placeholder="Note title"
                  className="input-field min-w-0 flex-1 text-sm font-semibold"
                />
                <label className="flex items-center gap-1.5 text-[11px] text-secondary">
                  <input
                    type="checkbox"
                    checked={pinned}
                    onChange={(event) => {
                      setPinned(event.target.checked);
                      setDirty(true);
                    }}
                  />
                  Pin
                </label>
                <button
                  onClick={() => void openHistory()}
                  className="btn bg-elevated border border-border px-2.5 py-1.5 text-[11px]"
                >
                  History
                </button>
                <button
                  onClick={() => void deleteNote()}
                  className="btn bg-elevated border border-border px-2.5 py-1.5 text-[11px] text-danger"
                >
                  Delete
                </button>
                <button
                  onClick={() => void saveNote()}
                  disabled={!dirty || saving}
                  className="btn btn-primary px-3 py-1.5 text-[11px] disabled:opacity-50"
                >
                  {saving ? "Saving..." : dirty ? "Save" : "Saved"}
                </button>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
                <input
                  value={tagInput}
                  onChange={(event) => {
                    setTagInput(event.target.value);
                    setDirty(true);
                  }}
                  aria-label="Tags"
                  placeholder="tags, comma separated"
                  className="input-field w-full text-xs sm:w-56"
                />
                <input
                  value={folder}
                  onChange={(event) => {
                    setFolder(event.target.value);
                    setDirty(true);
                  }}
                  aria-label="Folder"
                  placeholder="folder"
                  className="input-field w-full text-xs sm:w-40"
                />
                {activeNote?.aliases.length ? (
                  <span className="text-[10px] text-muted">
                    aliases: {activeNote.aliases.join(", ")}
                  </span>
                ) : null}
              </div>

              <textarea
                value={body}
                onChange={(event) => {
                  setBody(event.target.value);
                  setDirty(true);
                }}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                    event.preventDefault();
                    void saveNote();
                  }
                }}
                aria-label="Note body"
                placeholder="Write here. Link another note with [[its title]]."
                className="input-field min-h-0 flex-1 resize-none rounded-none border-0 font-mono text-[13px] leading-relaxed"
              />

              <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border bg-surface px-4 py-2 text-[11px] text-muted">
                <span className="tnum">
                  {body.length.toLocaleString()}
                  {stats?.caps?.body_chars ? ` / ${stats.caps.body_chars.toLocaleString()}` : ""}
                </span>
                <span className="tnum">updated {formatWhen(detail?.updated_at ?? null)}</span>
                <span className="tnum">{detail?.revision_count ?? 0} revisions</span>
                {detail?.links.length ? (
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="text-muted">links:</span>
                    {detail.links.slice(0, 6).map((link) => (
                      <button
                        key={link.title}
                        onClick={() => {
                          if (link.note_id) void selectNote(link.note_id);
                        }}
                        disabled={!link.note_id}
                        className={`text-[11px] ${
                          link.note_id ? "text-accent hover:underline" : "text-muted"
                        }`}
                      >
                        {link.title}
                      </button>
                    ))}
                  </span>
                ) : null}
                {detail?.backlinks.length ? (
                  <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="text-muted">backlinks:</span>
                    {detail.backlinks.slice(0, 6).map((link) => (
                      <button
                        key={link.id}
                        onClick={() => void selectNote(link.id)}
                        className="text-[11px] text-accent hover:underline"
                      >
                        {link.title}
                      </button>
                    ))}
                  </span>
                ) : null}
                {searchMode === "semantic" && searchResults ? (
                  <span className="ml-auto badge bg-accent/15 text-accent">semantic</span>
                ) : null}
              </div>
            </>
          )}
        </section>
      </div>

      <Modal isOpen={captureOpen} onClose={() => setCaptureOpen(false)} title="Quick capture">
        <div className="space-y-3">
          <input
            value={captureTitle}
            onChange={(event) => setCaptureTitle(event.target.value)}
            placeholder="Title (optional)"
            aria-label="Capture title"
            className="input-field text-sm"
          />
          <textarea
            value={captureText}
            onChange={(event) => setCaptureText(event.target.value)}
            placeholder="One thought, one line, no formatting needed."
            aria-label="Capture text"
            rows={6}
            className="input-field resize-none text-sm"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setCaptureOpen(false)}
              className="btn bg-elevated border border-border px-3 py-1.5 text-xs"
            >
              Cancel
            </button>
            <button
              onClick={() => void submitCapture()}
              disabled={!captureText.trim()}
              className="btn btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
            >
              Capture
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={templatesOpen} onClose={() => setTemplatesOpen(false)} title="Templates">
        <div className="space-y-3">
          {templates.length === 0 ? (
            <p className="text-xs text-secondary">
              No templates yet. Ask the assistant to create one, then it appears here.
            </p>
          ) : (
            <div className="space-y-1">
              {templates.map((template) => (
                <div
                  key={template.id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-elevated px-3 py-2"
                >
                  <button
                    onClick={() =>
                      void createNote({
                        title: template.name,
                        body: template.body,
                      })
                    }
                    className="flex-1 text-left text-xs text-primary hover:text-accent"
                  >
                    {template.name}
                  </button>
                  <button
                    onClick={() => void deleteTemplate(template.id)}
                    className="text-[11px] text-muted hover:text-danger"
                    aria-label={`Delete template ${template.name}`}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted">
            A template seeds a new note; editing the note never changes the template.
          </p>
        </div>
      </Modal>

      <Modal isOpen={historyOpen} onClose={() => setHistoryOpen(false)} title="Note history">
        <div className="max-h-[60vh] space-y-1 overflow-y-auto">
          {revisions.length === 0 ? (
            <p className="text-xs text-secondary">No earlier revisions for this note yet.</p>
          ) : (
            revisions.map((revision) => (
              <div
                key={revision.id}
                className="flex items-center gap-3 rounded-lg border border-border bg-elevated px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-primary">{revision.title}</p>
                  <p className="text-[10px] text-muted tnum">
                    {formatWhen(revision.created_at)} - {revision.body.length.toLocaleString()} chars
                  </p>
                </div>
                <button
                  onClick={() => void restoreRevision(revision.id)}
                  className="btn bg-surface border border-border px-2.5 py-1 text-[11px]"
                >
                  Restore
                </button>
              </div>
            ))
          )}
        </div>
      </Modal>
    </div>
  );
}
