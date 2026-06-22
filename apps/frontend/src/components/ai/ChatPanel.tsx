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
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
            </svg>
          </div>
          <h2 className="text-sm font-semibold text-primary">AI Command Center</h2>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="rounded-md border border-border bg-elevated px-2 py-1 text-xs text-primary outline-none"
          >
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-sm text-secondary hover:bg-hover hover:text-primary transition-colors"
          >
            ✕
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
            <div className="w-full space-y-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted mb-1 pl-1 text-left">Try asking</p>
              {[
                "\"Create a meeting next Thursday at 2pm\"",
                "\"Find all tasks due this week\"",
                "\"Break down: Plan a product launch\"",
              ].map((example) => (
                <button
                  key={example}
                  onClick={() => handleSend(example.slice(1, -1))}
                  className="block w-full rounded-lg bg-elevated px-3 py-2 text-xs text-secondary hover:bg-hover hover:text-primary transition-colors text-left border border-transparent hover:border-border/50"
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
