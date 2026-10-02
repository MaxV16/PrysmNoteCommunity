"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import {
  normalizeAssistantMarkdown,
  protectDateLineBreaks,
  stripTextToolCalls,
} from "@/lib/ai-format";

// Thin, theme-aware wrapper around react-markdown. Renders markdown produced
// by AI replies safely (react-markdown never injects raw HTML). Sloppy model
// output (emphasis with stray spaces, spaces around punctuation) is cleaned up
// first so it renders as real markdown, and any literal "[TOOL_CALLS] name
// {json}" blocks the model wrote are removed so raw tool-call JSON never shows.
// ISO dates get non-breaking hyphens so a date value can never wrap mid-value
// ("2026-" / "09-" / "05") inside the narrow chat bubble.
//
// The AI repair passes only run for AI replies (`ai`). User-authored task
// descriptions and subtasks use the same renderer, and running the word-rejoin
// heuristics over real prose could mangle it. remark-breaks turns single
// newlines into hard breaks so multi-line replies keep the author's line
// structure without relying on `white-space: pre-wrap`.
export function Markdown({ children, ai = false }: { children: string; ai?: boolean }) {
  const source = ai
    ? protectDateLineBreaks(normalizeAssistantMarkdown(stripTextToolCalls(children)))
    : protectDateLineBreaks(children);
  return (
    <div className="markdown-body">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
