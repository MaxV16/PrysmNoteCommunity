"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { useAIChat } from "@/hooks/useAIChat";
import { ChatMessage } from "./ChatMessage";
import { AIHeader } from "./AIHeader";
import { AIHistory, type HistoryServerSession, type HistoryLocalSession } from "./AIHistory";
import { AIEmptyState } from "./AIEmptyState";
import { AIComposer } from "./AIComposer";
import { Spinner } from "@/components/ui/Spinner";
import { useAppStore } from "@/stores/app-store";
import { getItem, setItem } from "@/lib/local-storage";
import { decryptString } from "@/lib/crypto-utils";
import { useApiKeys } from "@/hooks/useApiKeys";
import { api } from "@/lib/api";
import type { WorkspaceView } from "@/components/layout/AppShell";


const PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "openrouter", label: "OpenRouter" },
];

interface AIEntitlement {
  mode: "byok" | "prysmai" | "none";
  allowance: number;
  used: number;
  remaining: number | null;
  blocked: boolean;
}

const CHAT_HISTORY_KEY = "prysm_ai_chat_history";
const ACTIVE_CHAT_KEY = "prysm_ai_active_chat";

interface ChatPanelProps {
  onClose: () => void;
  view?: WorkspaceView;
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

function activeSessionId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("ai_session_id");
}

export function AIPanel({ onClose, view }: ChatPanelProps) {
  const { chatMessages, sendMessage, isLoading, backgroundWorking, turnPhase, abort, undoLastAction, hasUndo, loadSession, newChat, clearActiveSession, fetchSessions, usageTokens } = useAIChat();
  const [chatHistory, setChatHistory] = useState<ChatSession[]>([]);
  const [serverSessions, setServerSessions] = useState<HistoryServerSession[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const { keys, fetchKeys } = useApiKeys();

  const LAST_PROVIDER_KEY = "prysm_last_provider";
  const configuredProviders = keys.map((k) => k.provider);

  const [provider, setProvider] = useState("openai");
  const [entitlement, setEntitlement] = useState<AIEntitlement | null>(null);
  const insertRef = useRef<(text: string) => void>(() => {});

  useEffect(() => {
    api.get<AIEntitlement>("/ai/entitlement").then(setEntitlement).catch(() => {});
  }, []);

  const allProviders = entitlement?.mode === "prysmai"
    ? [{ value: "prysmai", label: "Prysm AI" }, ...PROVIDERS]
    : PROVIDERS;

  useEffect(() => {
    (async () => {
      if (typeof window === "undefined") return;
      const currentKeys = await fetchKeys();
      const configured = new Set(currentKeys.map((k) => k.provider));
      if (entitlement?.mode === "prysmai") {
        setProvider("prysmai");
        return;
      }
      const last = localStorage.getItem(LAST_PROVIDER_KEY);
      if (last && configured.has(last)) {
        setProvider(last);
        return;
      }
      const firstConfigured = PROVIDERS.find((p) => configured.has(p.value));
      if (firstConfigured) {
        setProvider(firstConfigured.value);
        return;
      }
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
  }, [entitlement]);

  useEffect(() => {
    localStorage.setItem(LAST_PROVIDER_KEY, provider);
  }, [provider]);

  useEffect(() => {
    if (!hasLoaded) {
      setChatHistory(loadChatHistory());
      setCurrentSessionId(activeSessionId());
      setHasLoaded(true);
    }
  }, [hasLoaded]);

  useEffect(() => {
    if (hasLoaded && chatMessages.length > 0) {
      // Never persist a streamed-but-aborted empty assistant bubble: only
      // messages with content reach the local active-chat cache.
      saveMessages(chatMessages.filter((m) => m.content));
    }
  }, [chatMessages, hasLoaded]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) {
        const store = useAppStore.getState();
        const context: Record<string, unknown> = {};
        if (detail.taskId) {
          const task = store.tasks.find((t) => t.id === detail.taskId);
          if (task) {
            context.focused_task = { title: task.title, description: task.description };
          }
        }
        if (store.navFilter) context.view_filter = store.navFilter;
        const message = detail.prompt || ("Break down: " + detail.title);
        sendMessage(message, provider, Object.keys(context).length > 0 ? context : undefined);
      }
    };
    window.addEventListener("prysm-ai-suggest", handler);
    return () => window.removeEventListener("prysm-ai-suggest", handler);
  }, [sendMessage, provider]);

  const handleNewChat = async () => {
    await newChat();
    saveMessages([]);
    setCurrentSessionId(null);
  };

  const handleClearCurrent = async () => {
    await clearActiveSession();
    saveMessages([]);
    setCurrentSessionId(null);
  };

  const handleLoadServerSession = async (sessionId: string) => {
    await loadSession(sessionId);
    setCurrentSessionId(sessionId);
    setHistoryOpen(false);
  };

  const handleLoadLocalSession = (session: ChatSession) => {
    const store = useAppStore.getState();
    store.setChatMessages(session.messages);
    saveMessages(session.messages);
    setCurrentSessionId(null);
    setHistoryOpen(false);
  };

  const handleDeleteLocalSession = (id: string) => {
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
    if (store.navFilter) context.view_filter = store.navFilter;
    if (view === "finance") context.active_view = "finance";
    sendMessage(message, provider, Object.keys(context).length > 0 ? context : undefined);
  }, [sendMessage, provider, view]);

  const providerOptions = allProviders.map((p) => ({
    value: p.value,
    label: p.label,
    configured: p.value === "prysmai" ? true : configuredProviders.includes(p.value),
  }));

  const localHistory: HistoryLocalSession[] = chatHistory.map((s) => ({
    id: s.id,
    title: s.title,
    timestamp: s.timestamp,
  }));

  // Free tier: no AI at all (no PrysmAI, no BYOK). Gate the panel with an
  // upgrade prompt; the community build has no gate and always sees BYOK.
  const aiLocked = entitlement?.mode === "none";

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-surface">
      <AIHeader
        provider={provider}
        onProviderChange={setProvider}
        providers={providerOptions}
        onNewChat={handleNewChat}
        onHistoryToggle={() => setHistoryOpen((v) => !v)}
        historyOpen={historyOpen}
        onClose={onClose}
      />

      <AIHistory
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        serverSessions={serverSessions}
        localSessions={localHistory}
        activeSessionId={currentSessionId}
        onLoadServer={handleLoadServerSession}
        onLoadLocal={(id) => {
          const s = chatHistory.find((h) => h.id === id);
          if (s) handleLoadLocalSession(s);
        }}
        onDeleteServer={handleDeleteServerSession}
        onDeleteLocal={handleDeleteLocalSession}
        onNewChat={handleNewChat}
        onClearCurrent={handleClearCurrent}
      />

      {aiLocked ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <div className="gradient-bg flex h-14 w-14 items-center justify-center rounded-2xl text-2xl float shadow-glow">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--on-gradient)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
          </div>
          <p className="text-sm font-semibold text-primary">AI is a paid feature</p>
          <p className="text-xs text-muted">
            Start the 14-day free trial for hosted PrysmAI, or upgrade to any plan for PrysmAI or your own API key.
          </p>
          <a
            href="/settings?tab=premium"
            className="mt-1 rounded-xl btn btn-gradient px-5 py-2.5 text-xs font-semibold shadow-glow"
          >
            Start free trial / View plans
          </a>
        </div>
      ) : (
        <></>
      )}

      {!aiLocked && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {chatMessages.length === 0 ? (
              <div className="flex h-full flex-col">
                <div className="mx-auto max-w-sm rounded-xl border border-border/70 bg-elevated px-4 py-3 text-center text-xs leading-relaxed text-secondary">
                  You are chatting with PrysmAI, an AI assistant. Hosted responses are routed with
                  zero data retention and may use different models depending on your region; you may
                  also connect your own OpenAI, Gemini, DeepSeek, or OpenRouter key in Settings.
                  Do not enter sensitive personal data.
                </div>
                <div className="min-h-0 flex-1">
                  <AIEmptyState onSuggest={handleSend} />
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                {chatMessages.map((msg, idx) => (
                  <ChatMessage
                    key={msg.id}
                    message={msg}
                    streaming={isLoading}
                    isLast={idx === chatMessages.length - 1}
                  />
                ))}
                {provider === "prysmai" && entitlement && (
                  <div className="flex justify-end px-2">
                    <span className="text-[10px] text-muted" title="PrysmAI monthly token allowance">
                      Prysm AI: {entitlement.used.toLocaleString()} / {entitlement.allowance.toLocaleString()} tokens
                      {entitlement.blocked ? " (allowance used up)" : ""}
                    </span>
                  </div>
                )}
                {usageTokens != null && !isLoading && (
                  <div className="flex justify-end px-2">
                    <span className="text-[10px] text-muted" title="Estimated prompt + completion tokens for this turn">
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
            )}
          </div>

          <AIComposer
            onSend={handleSend}
            disabled={isLoading || backgroundWorking}
            isLoading={isLoading}
            hasUndo={hasUndo}
            onAbort={abort}
            onUndo={undoLastAction}
            onRegisterInsert={(insert) => { insertRef.current = insert; }}
          />
          {backgroundWorking && (
            <div className="flex items-center justify-center gap-2 px-4 pb-2">
              <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"></div>
              <span className="text-[11px] text-muted">
                Working in the background{turnPhase === "final" ? " (generating reply)" : " (using tools)"}...
              </span>
            </div>
          )}
          <p className="px-4 pb-2.5 text-center text-[10px] leading-relaxed text-muted">
            PrysmAI is an AI assistant; check important details. Hosted models vary by region and are selected for efficiency and accuracy, with zero data retention. Replies are not retained.
          </p>
        </>
      )}
    </div>
  );
}

export default AIPanel;
