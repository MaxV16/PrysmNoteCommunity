"use client";

import { useState, useEffect } from "react";
import { useAIChat } from "@/hooks/useAIChat";
import { ChatMessage } from "./ChatMessage";
import { ChatInput } from "./ChatInput";
import { Spinner } from "@/components/ui/Spinner";
import { useAppStore } from "@/stores/app-store";

const PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Gemini" },
  { value: "deepseek", label: "DeepSeek" },
];

interface ChatPanelProps {
  onClose: () => void;
}

export function ChatPanel({ onClose }: ChatPanelProps) {
  const { chatMessages, sendMessage, isLoading } = useAIChat();
  const [provider, setProvider] = useState("openai");

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail) {
        const store = useAppStore.getState();
        const context: Record<string, unknown> = {};

        if (detail.taskId) {
          const task = store.tasks.find(t => t.id === detail.taskId);
          if (task) {
            const project = task.project_id
              ? store.projects.find(p => p.id === task.project_id)
              : null;
            context.focused_task = {
              title: task.title,
              description: task.description,
              project_name: project?.name,
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

  const handleNewChat = () => {
    const store = useAppStore.getState();
    store.setChatMessages([]);
    const newId = crypto.randomUUID();
    localStorage.setItem("ai_session_id", newId);
  };

  const handleSend = (message: string) => {
    const store = useAppStore.getState();
    const context: Record<string, unknown> = {};
    if (store.navFilter) {
      context.view_filter = store.navFilter;
    }
    sendMessage(message, provider, Object.keys(context).length > 0 ? context : undefined);
  };

  return (
    <div className="flex flex-col overflow-hidden border-l border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-4 py-3 bg-surface/80 backdrop-blur-md">
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
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
            <svg className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
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
        {isLoading && (
          <div className="flex justify-center py-3">
            <Spinner />
          </div>
        )}
      </div>

      <div className="border-t border-border px-4 py-3">
        <ChatInput onSend={handleSend} disabled={isLoading} />
      </div>
    </div>
  );
}
