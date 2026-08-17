"use client";

import { useState, useEffect, useCallback } from "react";
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
  const { chatMessages, sendMessage, isLoading, abort, undoLastAction, hasUndo, loadSession, newChat, clearActiveSession, fetchSessions, usageTokens } = useAIChat();
  const [chatHistory, setChatHistory] = useState<ChatSession[]>([]);
  const [serverSessions, setServerSessions] = useState<HistoryServerSession[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const { keys, fetchKeys } = useApiKeys();

  const LAST_PROVIDER_KEY = "prysm_last_provider";
  const configuredProviders = keys.map((k) => k.provider);

  const [provider, setProvider] = useState("openai");

  useEffect(() => {
    (async () => {
      if (typeof window === "undefined") return;
      const currentKeys = await fetchKeys();
      const configured = new Set(currentKeys.map((k) => k.provider));
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
  }, []);

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

  const providerOptions = PROVIDERS.map((p) => ({
    value: p.value,
    label: p.label,
    configured: configuredProviders.includes(p.value),
  }));

  const localHistory: HistoryLocalSession[] = chatHistory.map((s) => ({
    id: s.id,
    title: s.title,
    timestamp: s.timestamp,
  }));

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

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {chatMessages.length === 0 ? (
          <AIEmptyState onSuggest={handleSend} />
        ) : (
          <div className="space-y-4">
            {chatMessages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))}
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
        disabled={isLoading}
        isLoading={isLoading}
        hasUndo={hasUndo}
        onAbort={abort}
        onUndo={undoLastAction}
      />
    </div>
  );
}

export default AIPanel;
