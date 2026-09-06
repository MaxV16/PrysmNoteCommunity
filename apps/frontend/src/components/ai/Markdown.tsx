"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeAssistantMarkdown, stripTextToolCalls } from "@/lib/ai-format";

// Thin, theme-aware wrapper around react-markdown. Renders markdown produced
// by AI replies safely (react-markdown never injects raw HTML). Sloppy model
// output (emphasis with stray spaces, spaces around punctuation) is cleaned up
// first so it renders as real markdown, and any literal "[TOOL_CALLS] name
// {json}" blocks the model wrote are removed so raw tool-call JSON never shows.
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {normalizeAssistantMarkdown(stripTextToolCalls(children))}
      </ReactMarkdown>
    </div>
  );
}
