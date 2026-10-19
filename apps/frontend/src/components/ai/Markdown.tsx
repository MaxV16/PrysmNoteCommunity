"use client";

import { useRef } from "react";
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

function CopyImageIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function MarkdownImage({
  src,
  alt,
  title,
  compact,
  onActivate,
  actionLabel,
}: {
  src?: string;
  alt: string;
  title?: string;
  compact: boolean;
  onActivate?: (src: string) => void;
  actionLabel?: string;
}) {
  const imageRef = useRef<HTMLImageElement>(null);

  const copy = async () => {
    if (!src) return;
    const result = await copyImageToClipboard(src);
    const image = imageRef.current;
    if (!image) return;
    image.title =
      result === "image"
        ? "Image copied"
        : result === "url"
          ? "Image link copied"
          : "Could not copy image";
    window.setTimeout(() => {
      image.title = onActivate
        ? actionLabel ?? "Click to edit"
        : title ?? "Click to copy image";
    }, 1600);
  };

  const activate = () => {
    if (onActivate && src) {
      onActivate(src);
      return;
    }
    void copy();
  };

  const defaultTitle = onActivate
    ? actionLabel ?? "Click to edit"
    : title ?? "Click to copy image";

  return (
    <span className="group/image relative inline-block max-w-full align-top">
      {/* eslint-disable-next-line @next/next/no-img-element -- user-provided upload URLs cannot use the Next image optimizer */}
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        title={defaultTitle}
        role="button"
        tabIndex={0}
        aria-label={
          onActivate
            ? alt
              ? `${actionLabel ?? "Edit"}: ${alt}`
              : actionLabel ?? "Edit"
            : alt
              ? `Copy image: ${alt}`
              : "Copy image"
        }
        loading="lazy"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          activate();
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          activate();
        }}
        className={`${
          compact ? "my-1 max-h-40" : "my-2 max-h-80"
        } max-w-full rounded-lg border border-border object-contain focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          onActivate ? "cursor-text" : "cursor-copy"
        }`}
      />
      {onActivate && (
        <button
          type="button"
          aria-label={alt ? `Copy image: ${alt}` : "Copy image"}
          title="Copy image"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void copy();
          }}
          className="pointer-coarse:opacity-100 absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-md border border-border bg-surface/95 text-secondary opacity-0 shadow-sm transition-opacity hover:text-primary focus-visible:opacity-100 group-hover/image:opacity-100"
        >
          <CopyImageIcon />
        </button>
      )}
    </span>
  );
}

export function Markdown({
  children,
  ai = false,
  compact = false,
  onImageActivate,
  imageActionLabel,
}: {
  children: string;
  ai?: boolean;
  /** Inline preview (subtask notes): smaller images and tighter spacing. */
  compact?: boolean;
  /**
   * When set, clicking an image invokes this instead of copying it. Used by
   * task descriptions and subtasks so clicking a picture opens the editor,
   * where it can be changed or deleted. A small copy button still appears on
   * hover so the image stays copyable.
   */
  onImageActivate?: (src: string) => void;
  /** Accessible label for the image activation action, e.g. "Edit description". */
  imageActionLabel?: string;
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
            return (
              <MarkdownImage
                src={typeof src === "string" ? src : undefined}
                alt={alt ?? ""}
                title={title}
                compact={compact}
                onActivate={onImageActivate}
                actionLabel={imageActionLabel}
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
