"use client";

import type { ChatMessage as ChatMessageType } from "@/types/ai";
import { Avatar } from "@/components/ui/Avatar";
import { Tooltip } from "@/components/ui/Tooltip";

interface ChatMessageProps {
  message: ChatMessageType;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";

  if (message.role === "tool") {
    return <ToolCallCard message={message} />;
  }

  return (
    <div className={`flex gap-2.5 ${isUser ? "justify-end" : "justify-start"} fade-in`}>
      {!isUser && (
        <Avatar name="AI" size="sm" className="shrink-0 mt-0.5 ring-0" />
      )}
      <div className="flex flex-col gap-0.5 max-w-[85%]">
        <div
          className={`rounded-xl px-3.5 py-2 text-sm leading-relaxed ${
            isUser
              ? "bg-accent text-base rounded-tr-sm"
              : "bg-elevated text-primary rounded-tl-sm"
          }`}
        >
          {message.content ? (
            message.content
          ) : (
            <TypingIndicator />
          )}
        </div>
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
    <div className="flex justify-center fade-in">
      <div className="flex items-center gap-2 rounded-lg border border-border/50 bg-elevated/50 px-3 py-1.5 text-xs text-muted">
        <span className="text-accent">&#9880;</span>
        <span>{message.content}</span>
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 py-1">
      <span className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "0ms" }} />
      <span className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "150ms" }} />
      <span className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: "300ms" }} />
    </div>
  );
}
