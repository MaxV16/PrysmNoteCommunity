"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { useAIChat } from "@/hooks/useAIChat";
import { ChatMessage } from "./ChatMessage";
import { ChatInput } from "./ChatInput";
import { Spinner } from "@/components/ui/Spinner";
import { useAppStore } from "@/stores/app-store";
import { getItem, setItem } from "@/lib/local-storage";
import { decryptString } from "@/lib/crypto-utils";
import { useUiModule } from "@/lib/ui-module-registry";
import { useApiKeys } from "@/hooks/useApiKeys";
import { useLocalBool } from "@/lib/use-local-bool";
import { api } from "@/lib/api";


const PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "deepseek", label: "DeepSeek" },
];

const CHAT_HISTORY_KEY = "prysm_ai_chat_history";
const ACTIVE_CHAT_KEY = "prysm_ai_active_chat";

interface ChatPanelProps {
  onClose: () => void;
}

interface ChatSession {
  id: string;
  title: string;
  messages: any[];
  timestamp: string;
}

function saveMessages(messages: any[]) {
  setItem(ACTIVE_CHAT_KEY, messages);
}

function loadMessages(): any[] {
  return getItem<any[]>(ACTIVE_CHAT_KEY, []);
}

function loadChatHistory(): ChatSession[] {
  return getItem<ChatSession[]>(CHAT_HISTORY_KEY, []);
}

function saveChatHistory(sessions: ChatSession[]) {
  setItem(CHAT_HISTORY_KEY, sessions);
}

export function ChatPanel({ onClose }: ChatPanelProps) {
  const { chatMessages, sendMessage, isLoading, abort, undoLastAction, hasUndo, loadSession, newChat, clearActiveSession, fetchSessions, usageTokens } = useAIChat();
  const voiceModuleOn = useUiModule("voice");
  const voiceLocalOn = useLocalBool("prysm_feature_voice", true);
  const voiceOn = voiceModuleOn && voiceLocalOn;
  const [chatHistory, setChatHistory] = useState<ChatSession[]>([]);
  const [serverSessions, setServerSessions] = useState<
    { session_id: string; title: string; message_count: number; last_message_at: string; summary?: string | null }[]
  >([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const { keys, fetchKeys } = useApiKeys();

  const LAST_PROVIDER_KEY = "prysm_last_provider";
  const configuredProviders = keys.map((k) => k.provider);

  const [provider, setProvider] = useState("openai");

  useEffect(() => {
    (async () => {
      if (typeof window === "undefined") return;
      // Fetch the user's configured keys; the persisted last-provider only wins
      // when that provider actually still has a key configured.
      const currentKeys = await fetchKeys();
      const configured = new Set(currentKeys.map((k) => k.provider));
      const last = localStorage.getItem(LAST_PROVIDER_KEY);
      if (last && configured.has(last)) {
        setProvider(last);
        return;
      }
      // Otherwise default visibly to the first configured provider, so the
      // dropdown matches the API key the user actually set.
      const firstConfigured = PROVIDERS.find((p) => configured.has(p.value));
      if (firstConfigured) {
        setProvider(firstConfigured.value);
        return;
      }
      // Fall back to a cached key stored in localStorage.
      for (const p of PROVIDERS) {
        const encrypted = localStorage.getItem(`prysm_key_${p.value}`);
        if (encrypted) {
          const decrypted = await decryptString(encrypted);
          if (decrypted) {
            setProvider(p.value);
            return;
          }
        }
      }
      setProvider("openai");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem(LAST_PROVIDER_KEY, provider);
  }, [provider]);

  useEffect(() => {
    if (!hasLoaded) {
      const saved = loadMessages();
      if (saved.length > 0) {
        const store = useAppStore.getState();
        store.setChatMessages(saved);
      }
      setChatHistory(loadChatHistory());
      setHasLoaded(true);
    }
  }, [hasLoaded]);

  useEffect(() => {
    if (hasLoaded && chatMessages.length > 0) {
      saveMessages(chatMessages);
    }
  }, [chatMessages, hasLoaded]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) {
        const store = useAppStore.getState();
        const context: Record<string, unknown> = {};

        if (detail.taskId) {
          const task = store.tasks.find(t => t.id === detail.taskId);
          if (task) {
            context.focused_task = {
              title: task.title,
              description: task.description,
            };
          }
        }
        if (store.navFilter) {
          context.view_filter = store.navFilter;
        }

        const message = detail.prompt || ("Break down: " + detail.title);
        sendMessage(message, provider, Object.keys(context).length > 0 ? context : undefined);
      }
    };
    window.addEventListener("prysm-ai-suggest", handler);
    return () => window.removeEventListener("prysm-ai-suggest", handler);
  }, [sendMessage, provider]);

  const handleNewChat = async () => {
    // Start a new session, leaving prior server sessions in history.
    await newChat();
    // Persist the cleared state so a refresh does not resurrect the previous
    // chat under a brand-new session id.
    saveMessages([]);
  };

  const handleClearCurrent = async () => {
    // Delete the active server session (purging its durable memory), then start
    // fresh — same net effect as hitting X on the session, all server-backed.
    await clearActiveSession();
    saveMessages([]);
  };

  const handleLoadServerSession = async (sessionId: string) => {
    await loadSession(sessionId);
    setHistoryOpen(false);
  };

  const handleLoadSession = (session: ChatSession) => {
    const store = useAppStore.getState();
    store.setChatMessages(session.messages);
    saveMessages(session.messages);
    setHistoryOpen(false);
  };

  const handleDeleteSession = (id: string) => {
    const updated = chatHistory.filter((s) => s.id !== id);
    setChatHistory(updated);
    saveChatHistory(updated);
  };

  const handleDeleteServerSession = async (sessionId: string) => {
    try {
      await api.delete(`/ai/sessions/${sessionId}`);
      setServerSessions((prev) => prev.filter((s) => s.session_id !== sessionId));
    } catch {
      // Non-fatal: leave the item in place.
    }
  };

  useEffect(() => {
    if (historyOpen) {
      fetchSessions().then((sessions) =>
        setServerSessions(
          sessions.map((s) => ({
            session_id: s.session_id,
            title: s.title,
            message_count: s.message_count,
            last_message_at: s.last_message_at,
            summary: s.summary,
          }))
        )
      );
    }
  }, [historyOpen, fetchSessions]);

  const handleSend = useCallback((message: string) => {
    const store = useAppStore.getState();
    const context: Record<string, unknown> = {};
    if (store.navFilter) {
      context.view_filter = store.navFilter;
    }
    sendMessage(message, provider, Object.keys(context).length > 0 ? context : undefined);
  }, [sendMessage, provider]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden border-l border-border bg-surface">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3 bg-surface/80 backdrop-blur-md">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
            </svg>
          </div>
          <h2 className="text-sm font-semibold text-primary">AI Command Center</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="rounded-full border border-border bg-elevated px-3 py-1.5 text-xs text-primary outline-none appearance-none pr-7 cursor-pointer hover:border-accent/40 transition-colors"
            >
              {PROVIDERS.map((p) => {
                const configured = configuredProviders.includes(p.value);
                return (
                  <option key={p.value} value={p.value}>
                    {p.label}{configured ? " ✓" : ""}
                  </option>
                );
              })}
            </select>
            <svg className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </div>
          <div className="relative">
            <button
              onClick={() => setHistoryOpen(!historyOpen)}
              className="rounded-full px-2 py-1 text-[10px] text-secondary hover:bg-hover hover:text-primary transition-colors border border-transparent hover:border-border"
              title="Chat History"
            >
              📋
            </button>
            {historyOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 w-80 max-h-[70vh] overflow-hidden rounded-xl border border-border bg-surface shadow-lg flex flex-col">
                <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted">Chat History</p>
                  <button
                    onClick={handleNewChat}
                    className="rounded-full px-2 py-0.5 text-[10px] text-accent hover:bg-hover transition-colors font-medium"
                    title="Start a new chat"
                  >
                    + New Chat
                  </button>
                </div>
                <div className="overflow-auto p-2 space-y-1">
                  {serverSessions.length === 0 && chatHistory.length === 0 && (
                    <p className="text-xs text-muted px-2 py-3 text-center">No saved chats yet</p>
                  )}
                  {serverSessions.map((s) => (
                    <div key={s.session_id} className="flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-hover transition-colors group">
                      <button
                        onClick={() => handleLoadServerSession(s.session_id)}
                        className="flex-1 text-left min-w-0"
                        title={s.summary || s.title}
                      >
                        <span className="block truncate text-xs text-secondary">{s.title}</span>
                        <span className="block text-[9px] text-muted">
                          {s.message_count} messages · {new Date(s.last_message_at).toLocaleDateString()}
                        </span>
                      </button>
                      <button onClick={() => handleDeleteServerSession(s.session_id)} className="text-[10px] text-muted hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
                    </div>
                  ))}
                  {chatHistory.map((s) => (
                    <div key={s.id} className="flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-hover transition-colors group">
                      <button onClick={() => handleLoadSession(s)} className="flex-1 text-left text-xs text-secondary truncate">{s.title}</button>
                      <button onClick={() => handleDeleteSession(s.id)} className="text-[10px] text-muted hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
                    </div>
                  ))}
                </div>
                <div className="border-t border-border/60 px-3 py-1.5">
                  <button
                    onClick={handleClearCurrent}
                    className="w-full text-left text-[10px] text-danger/80 hover:text-danger transition-colors"
                  >
                    Clear current chat
                  </button>
                </div>
              </div>
            )}
          </div>
          <button
            onClick={handleNewChat}
            className="rounded-full px-2.5 py-1 text-[10px] text-secondary hover:bg-hover hover:text-primary transition-colors border border-transparent hover:border-border"
            title="New Chat"
          >
            +
          </button>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-sm text-secondary hover:bg-hover hover:text-primary transition-colors"
            title="Close"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-4 py-3 space-y-4">
        {chatMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent/10 mb-4 float">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
              </svg>
            </div>
            <p className="text-xs text-secondary leading-relaxed mb-1">
              Your AI-powered task assistant
            </p>
            <p className="text-[10px] text-muted mb-5">
              Create tasks, search, schedule, and get smart suggestions
            </p>
            <div className="w-full space-y-2">
              <p className="text-[10px] uppercase tracking-wider text-muted mb-1 pl-1 text-left">Try asking</p>
              {[
                "\"Schedule GP appointment next Monday at 12pm\"",
                "\"What deadlines are coming up this week?\"",
                "\"Find all tasks tagged urgent\"",
                "\"Break down: Plan product launch\"",
                "\"Show me my schedule conflicts for tomorrow\"",
              ].map((example) => (
                <button
                  key={example}
                  onClick={() => handleSend(example.slice(1, -1))}
                  className="block w-full rounded-2xl bg-elevated px-4 py-2.5 text-xs text-secondary hover:bg-hover hover:text-primary transition-all text-left border border-transparent hover:border-border/50 hover:scale-[1.01]"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}
        {chatMessages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        {usageTokens != null && !isLoading && (
          <div className="flex justify-end px-2">
            <span className="text-[9px] text-muted" title="Estimated prompt + completion tokens for this turn">
              ~{usageTokens.toLocaleString()} tokens used
            </span>
          </div>
        )}
        {isLoading && (
          <div className="flex justify-center py-3">
            <Spinner />
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border px-4 py-3 space-y-2">
        <div className="flex gap-2">
          {isLoading && (
            <button
              onClick={abort}
              className="flex items-center gap-1.5 rounded-full bg-danger/10 px-3 py-1.5 text-xs text-danger hover:bg-danger/20 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
              Stop
            </button>
          )}
          {hasUndo && (
            <button
              onClick={undoLastAction}
              className="flex items-center gap-1.5 rounded-full bg-elevated px-3 py-1.5 text-xs text-secondary hover:text-primary hover:bg-hover transition-colors border border-border"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
              Undo
            </button>
          )}
        </div>
        <ChatInput
          onSend={(msg) => handleSend(msg)}
          disabled={isLoading}
      </div>
    </div>
  );
}
