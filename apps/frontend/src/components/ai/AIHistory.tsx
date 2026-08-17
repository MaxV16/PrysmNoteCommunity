"use client";

import { useEffect } from "react";

export interface HistoryServerSession {
  session_id: string;
  title: string;
  message_count: number;
  last_message_at: string;
  summary?: string | null;
}

export interface HistoryLocalSession {
  id: string;
  title: string;
  timestamp: string;
}

interface AIHistoryProps {
  open: boolean;
  onClose: () => void;
  serverSessions: HistoryServerSession[];
  localSessions: HistoryLocalSession[];
  activeSessionId: string | null;
  onLoadServer: (id: string) => void;
  onLoadLocal: (id: string) => void;
  onDeleteServer: (id: string) => void;
  onDeleteLocal: (id: string) => void;
  onNewChat: () => void;
  onClearCurrent: () => void;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function AIHistory({
  open,
  onClose,
  serverSessions,
  localSessions,
  activeSessionId,
  onLoadServer,
  onLoadLocal,
  onDeleteServer,
  onDeleteLocal,
  onNewChat,
  onClearCurrent,
}: AIHistoryProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const anySessions = serverSessions.length > 0 || localSessions.length > 0;

  return (
    <div className="fixed inset-0 z-40">
      <button
        aria-label="Close chat history"
        className="absolute inset-0 h-full w-full cursor-default bg-black/30"
        onClick={onClose}
        tabIndex={-1}
      />
      <div
        role="dialog"
        aria-label="Chat history"
        className="absolute right-0 top-0 flex h-full w-[20rem] max-w-[86vw] flex-col border-l border-border bg-surface shadow-lg"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h3 className="text-sm font-semibold text-primary">Chat history</h3>
            <p className="text-[11px] text-muted">Continue or start a conversation</p>
          </div>
          <button
            onClick={onNewChat}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-hover"
          >
            New chat
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {!anySessions && (
            <p className="px-3 py-8 text-center text-sm text-muted">No saved chats yet.</p>
          )}

          {serverSessions.length > 0 && (
            <p className="nav-label px-3 pb-1 pt-2">Saved conversations</p>
          )}
          <div className="space-y-0.5">
            {serverSessions.map((s) => {
              const active = s.session_id === activeSessionId;
              return (
                <div
                  key={s.session_id}
                  className={`group relative flex items-start gap-2 rounded-xl px-3 py-2.5 transition-colors ${
                    active ? "bg-accent/10" : "hover:bg-hover"
                  }`}
                >
                  <button
                    onClick={() => onLoadServer(s.session_id)}
                    className="min-w-0 flex-1 text-left"
                    aria-current={active ? "true" : undefined}
                  >
                    <span className="block break-words text-[13px] font-medium leading-snug text-primary">
                      {s.title || "Untitled conversation"}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted">
                      {s.message_count} messages · {fmtDate(s.last_message_at)}
                      {active ? " · current" : ""}
                    </span>
                  </button>
                  <button
                    onClick={() => onDeleteServer(s.session_id)}
                    aria-label={`Delete ${s.title || "conversation"}`}
                    className="mt-0.5 rounded p-1 text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
              );
            })}
          </div>

          {localSessions.length > 0 && (
            <p className="nav-label px-3 pb-1 pt-3">On this device</p>
          )}
          <div className="space-y-0.5">
            {localSessions.map((s) => {
              const active = s.id === activeSessionId;
              return (
                <div
                  key={s.id}
                  className={`group relative flex items-start gap-2 rounded-xl px-3 py-2.5 transition-colors ${
                    active ? "bg-accent/10" : "hover:bg-hover"
                  }`}
                >
                  <button
                    onClick={() => onLoadLocal(s.id)}
                    className="min-w-0 flex-1 text-left"
                    aria-current={active ? "true" : undefined}
                  >
                    <span className="block break-words text-[13px] font-medium leading-snug text-primary">
                      {s.title || "Untitled conversation"}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted">
                      {fmtDate(s.timestamp)}
                      {active ? " · current" : ""}
                    </span>
                  </button>
                  <button
                    onClick={() => onDeleteLocal(s.id)}
                    aria-label={`Delete ${s.title || "conversation"}`}
                    className="mt-0.5 rounded p-1 text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="shrink-0 border-t border-border px-4 py-2.5">
          <button
            onClick={onClearCurrent}
            className="w-full rounded-lg px-3 py-1.5 text-left text-xs text-danger/90 transition-colors hover:bg-danger/10 hover:text-danger"
          >
            Clear current chat
          </button>
        </div>
      </div>
    </div>
  );
}
