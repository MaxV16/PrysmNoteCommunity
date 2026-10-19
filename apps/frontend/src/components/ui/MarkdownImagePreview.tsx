"use client";

import { Markdown } from "@/components/ai/Markdown";
import { markdownImages, type MarkdownImage } from "@/lib/upload";

/**
 * Live thumbnail strip for images embedded in the markdown being edited.
 * A textarea only shows the raw `![alt](url)` source, so without this an image
 * appears to vanish while the editor is open. Each thumbnail uses the shared
 * Markdown image renderer (click to copy) and can be removed directly with the
 * X button, which edits the underlying source.
 */
export function MarkdownImagePreview({
  text,
  className,
  onRemove,
}: {
  text: string;
  className?: string;
  onRemove?: (image: MarkdownImage) => void;
}) {
  const images = markdownImages(text);
  if (images.length === 0) return null;

  return (
    <div className={`flex max-w-full flex-wrap gap-1.5 ${className ?? ""}`}>
      {images.map((image, index) => (
        <div
          key={`${image.url}-${index}`}
          className="group/imagepreview relative max-w-[180px] overflow-hidden rounded-lg border border-border/60 bg-base/40 p-1"
        >
          <Markdown compact>
            {`![${image.alt.replace(/[[\]]/g, "")}](${image.url})`}
          </Markdown>
          {onRemove && (
            <button
              type="button"
              aria-label={`Remove image ${image.alt}`}
              title="Remove image"
              onMouseDown={(e) => e.preventDefault()}
              onPointerDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRemove(image);
              }}
              className="pointer-coarse:opacity-100 absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-md border border-border bg-surface/95 text-secondary opacity-0 shadow-sm transition-opacity hover:text-danger focus-visible:opacity-100 group-hover/imagepreview:opacity-100"
            >
              <svg
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
