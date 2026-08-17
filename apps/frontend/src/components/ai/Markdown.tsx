"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Thin, theme-aware wrapper around react-markdown. Renders markdown produced
// by AI replies safely (react-markdown never injects raw HTML).
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
