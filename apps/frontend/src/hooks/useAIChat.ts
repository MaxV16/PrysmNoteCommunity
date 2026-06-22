"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useAppStore } from "@/stores/app-store";
import type { ChatMessage } from "@/types/ai";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

function getStoredSessionId(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("ai_session_id") || "";
}

function setStoredSessionId(id: string) {
  localStorage.setItem("ai_session_id", id);
}

export function useAIChat() {
  const [isLoading, setIsLoading] = useState(false);
  const { chatMessages, addChatMessage, setChatMessages } = useAppStore();
  const sessionIdRef = useRef<string>(getStoredSessionId());
  const [historyLoaded, setHistoryLoaded] = useState(false);

  useEffect(() => {
    const sid = sessionIdRef.current;
    if (!sid || historyLoaded) return;

    (async () => {
      try {
        const res = await fetch(`${API_URL}/ai/conversations/${sid}`, {
          credentials: "include",
        });
        if (res.ok) {
          const history = await res.json();
          if (history.length > 0) {
            const msgs: ChatMessage[] = history.map((h: { role: string; content: string; created_at: string }) => ({
              id: crypto.randomUUID(),
              role: h.role,
              content: h.content,
              created_at: h.created_at,
            }));
            setChatMessages(msgs);
          }
        }
      } catch {
      } finally {
        setHistoryLoaded(true);
      }
    })();
  }, [historyLoaded, setChatMessages]);

  const sendMessage = useCallback(
    async (content: string, provider = "openai", context?: Record<string, unknown>) => {
      setIsLoading(true);
      if (!sessionIdRef.current) {
        sessionIdRef.current = crypto.randomUUID();
        setStoredSessionId(sessionIdRef.current);
      }
      const sessionId = sessionIdRef.current;

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content,
        created_at: new Date().toISOString(),
      };
      addChatMessage(userMsg);

      const assistantId = crypto.randomUUID();
      addChatMessage({
        id: assistantId,
        role: "assistant",
        content: "",
        created_at: new Date().toISOString(),
      });

      try {
        const res = await fetch(`${API_URL}/ai/chat/stream`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({
            message: content,
            chat_history: chatMessages.slice(-10),
            session_id: sessionId,
            provider,
            ...(context ? { context } : {}),
          }),
        });

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No reader");

        const decoder = new TextDecoder();
        let buf = "";
        let currentEvent = "";
        let currentData = "";

        const updateAssistant = (text: string) => {
          const store = useAppStore.getState();
          const msgs = store.chatMessages.map((m) =>
            m.id === assistantId ? { ...m, content: text } : m
          );
          store.setChatMessages(msgs);
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              currentEvent = line.slice(7).trim();
              currentData = "";
            } else if (line.startsWith("data: ")) {
              currentData = line.slice(6);
            } else if (line === "" && currentEvent) {
              if (currentEvent === "token" && currentData) {
                const store = useAppStore.getState();
                const existing = store.chatMessages.find((m) => m.id === assistantId);
                updateAssistant((existing?.content || "") + currentData);
              } else if (currentEvent === "tool_start" && currentData) {
                updateAssistant("[Tool calls: " + currentData + "]");
              } else if (currentEvent === "tool_results" && currentData) {
              } else if (currentEvent === "done") {
              }
              currentEvent = "";
              currentData = "";
            }
          }
        }
      } catch {
        const store = useAppStore.getState();
        const existing = store.chatMessages.find((m) => m.id === assistantId);
        if (existing && !existing.content) {
          store.setChatMessages(
            store.chatMessages.map((m) =>
              m.id === assistantId
                ? { ...m, content: "Sorry, I encountered an error. Please check your API key." }
                : m
            )
          );
        }
      } finally {
        setIsLoading(false);
      }
    },
    [chatMessages, addChatMessage]
  );

  return { chatMessages, sendMessage, isLoading };
}
