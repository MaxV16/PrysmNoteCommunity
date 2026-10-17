"use client";

import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
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
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        urlTransform={(url) => (url.startsWith("data:image/") ? url : defaultUrlTransform(url))}
        components={{
          img({ src, alt, title }) {
            return (
              // eslint-disable-next-line @next/next/no-img-element -- user-provided upload URLs cannot use the Next image optimizer
              <img
                src={typeof src === "string" ? src : undefined}
                alt={alt ?? ""}
                title={title}
                loading="lazy"
                className="my-2 max-h-80 max-w-full rounded-lg border border-border object-contain"
              />
            );
          },
          a({ href, title, children }) {
            return (
              <a
                href={href}
                title={title}
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline underline-offset-2 hover:text-accent-hover"
              >
                {children}
              </a>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
