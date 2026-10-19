"use client";

import { Markdown } from "@/components/ai/Markdown";
import { markdownImages } from "@/lib/upload";

/**
 * Live thumbnail strip for images embedded in the markdown being edited.
 * A textarea only shows the raw `![alt](url)` source, so without this an image
 * appears to vanish while the editor is open. Each thumbnail uses the shared
 * Markdown image renderer, so it is click-to-copy like every other rendered
 * image in the app.
 */
export function MarkdownImagePreview({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const images = markdownImages(text);
  if (images.length === 0) return null;

  return (
    <div className={`flex max-w-full flex-wrap gap-1.5 ${className ?? ""}`}>
      {images.map((image, index) => (
        <div
          key={`${image.url}-${index}`}
          className="max-w-[180px] overflow-hidden rounded-lg border border-border/60 bg-base/40 p-1"
        >
          <Markdown compact>
            {`![${image.alt.replace(/[[\]]/g, "")}](${image.url})`}
          </Markdown>
        </div>
      ))}
    </div>
  );
}
