"use client";

import type { ChatMessage as ChatMessageType } from "@/types/ai";
import { Avatar } from "@/components/ui/Avatar";
import { Tooltip } from "@/components/ui/Tooltip";
import { Markdown } from "./Markdown";
import { formatTime as formatTimePref } from "@/lib/dates";

interface ChatMessageProps {
  message: ChatMessageType;
  streaming?: boolean;
  isLast?: boolean;
}

function formatTime(iso: string): string {
  return formatTimePref(iso);
}

export function ChatMessage({ message, streaming, isLast }: ChatMessageProps) {
  const isUser = message.role === "user";

  if (message.role === "tool") {
    return <ToolCallCard message={message} />;
  }

  // NOTE: assistant messages must ALWAYS go through markdown. Historically a
  // streaming "⚙ <tool labels>" placeholder was written into the assistant
  // bubble which made the whole reply (label + summary) render as a round tool
  // pill ("the big circle"). Tool activity now lives on separate role:"tool"
  // bubbles, so no assistant content should ever be hijacked here.

  // The TypingIndicator is only correct for the message currently being
  // streamed: the last assistant message while a stream is actually active.
  // An empty assistant message with no active stream renders as a silent gap
  // instead of an infinite "typing..." (abort/panel-close leaves no bubble
  // behind, but this guard makes the renderer safe regardless).
  const showTyping =
    message.role === "assistant" && !message.content && streaming && isLast;

  // Empty assistant messages render as a silent gap (no bubble, no typing
  // indicator) unless they are the actively-streamed last message.
  const hasBody = showTyping || Boolean(message.content);

  return (
    <div className={`flex gap-2.5 ${isUser ? "justify-end" : "justify-start"} slide-up`}>
      {!isUser && (
        <Avatar name="AI" size="sm" className="shrink-0 mt-0.5 ring-0" />
      )}
      <div className="flex flex-col gap-0.5 max-w-[85%]">
        {hasBody && (
          <div
            className={`rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
              isUser
                ? "gradient-bg text-[var(--on-gradient)] rounded-br-md shadow-glow"
                : "bg-elevated text-primary rounded-bl-md border border-border/50"
            }`}
          >
            {showTyping ? (
              <TypingIndicator />
            ) : isUser ? (
              message.content
            ) : (
              <Markdown>{message.content}</Markdown>
            )}
          </div>
        )}
        <Tooltip content={formatTime(message.created_at)} position={isUser ? "left" : "right"}>
          <span className={`text-[10px] text-muted ${isUser ? "text-right" : "text-left"}`}>
            {formatTime(message.created_at)}
          </span>
        </Tooltip>
      </div>
      {isUser && (
        <Avatar name="You" size="sm" className="shrink-0 mt-0.5 ring-0" />
      )}
    </div>
  );
}

function ToolCallCard({ message }: { message: ChatMessageType }) {
  return (
    <div className="flex justify-center slide-up">
      <div className="flex items-center gap-2 rounded-xl border border-accent/20 bg-elevated/50 px-3 py-2 text-xs text-secondary border-l-2 border-l-accent">
        <span className="text-accent">&#9880;</span>
        <span>{message.content}</span>
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 py-1" data-testid="typing-indicator">
      <span className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "0ms" }} />
      <span className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "150ms" }} />
      <span className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "300ms" }} />
    </div>
  );
}
