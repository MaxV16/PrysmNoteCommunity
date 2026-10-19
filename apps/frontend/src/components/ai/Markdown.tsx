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
/**
 * Copy an image to the clipboard so it can be pasted into a description,
 * subtask, or another app. Remote images that block a CORS read fall back to
 * copying their URL instead of failing silently.
 */
async function copyImageToClipboard(src: string): Promise<"image" | "url" | null> {
  try {
    if (typeof ClipboardItem === "undefined") throw new Error("Clipboard images unavailable");
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Image request failed with ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) throw new Error("Not an image");
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    return "image";
  } catch {
    try {
      await navigator.clipboard.writeText(src);
      return "url";
    } catch {
      return null;
    }
  }
}

export function Markdown({
  children,
  ai = false,
  compact = false,
}: {
  children: string;
  ai?: boolean;
  /** Inline preview (subtask notes): smaller images and tighter spacing. */
  compact?: boolean;
}) {
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
            const value = typeof src === "string" ? src : undefined;
            const copy = async (img: HTMLImageElement) => {
              if (!value) return;
              const result = await copyImageToClipboard(value);
              img.title =
                result === "image"
                  ? "Image copied"
                  : result === "url"
                    ? "Image link copied"
                    : "Could not copy image";
              window.setTimeout(() => {
                img.title = title ?? "Click to copy image";
              }, 1600);
            };
            return (
              // eslint-disable-next-line @next/next/no-img-element -- user-provided upload URLs cannot use the Next image optimizer
              <img
                src={value}
                alt={alt ?? ""}
                title={title ?? "Click to copy image"}
                role="button"
                tabIndex={0}
                aria-label={alt ? `Copy image: ${alt}` : "Copy image"}
                loading="lazy"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void copy(e.currentTarget);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  e.stopPropagation();
                  void copy(e.currentTarget);
                }}
                className={`${
                  compact ? "my-1 max-h-40" : "my-2 max-h-80"
                } max-w-full cursor-copy rounded-lg border border-border object-contain focus:outline-none focus-visible:ring-2 focus-visible:ring-accent`}
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
