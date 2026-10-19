import { api } from "@/lib/api";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** A file dropped/picked from disk, or an image URL copied from another app. */
export type ImageInsertSource = File | string;

/** Textarea or single-line input that can receive an uploaded image. */
export type ImageInsertTarget = HTMLTextAreaElement | HTMLInputElement;

export interface MarkdownImage {
  alt: string;
  url: string;
  /** Exact markdown source, so a preview can remove precisely this image. */
  markdown: string;
  /** Offset of `markdown` in the source string. */
  start: number;
}

function imageError(file: File): string | null {
  if (!IMAGE_TYPES.has(file.type)) return "Choose a PNG, JPEG, GIF, or WebP image.";
  if (file.size === 0) return "That image is empty.";
  if (file.size > MAX_IMAGE_BYTES) return "Images must be 5 MB or smaller.";
  return null;
}

function absoluteUploadUrl(url: string): string {
  if (/^(https?:|data:|blob:)/i.test(url)) return url;
  // In dev the browser talks to the API origin directly (for example
  // http://localhost:8000/api), so a relative /api/uploads path would hit the
  // Next dev server and 404. In production NEXT_PUBLIC_API_URL is /api and the
  // same-origin URL is exactly what we want.
  const base = process.env.NEXT_PUBLIC_API_URL || "/api";
  if (!/^https?:\/\//i.test(base)) return url;
  return new URL(url, new URL(base).origin).toString();
}

export async function uploadImage(file: File): Promise<string> {
  const error = imageError(file);
  if (error) throw new Error(error);
  const formData = new FormData();
  formData.append("file", file, file.name || "image");
  const result = await api.upload<{ url: string }>("/uploads", formData);
  if (!result?.url) throw new Error("The image upload did not return a link.");
  return absoluteUploadUrl(result.url);
}

function altFromName(name: string | undefined): string {
  return (name || "image").replace(/\.[^.]+$/, "").trim() || "image";
}

function isUploadUrl(url: string): boolean {
  if (url.startsWith("/api/uploads/")) return true;
  try {
    return new URL(url, typeof location !== "undefined" ? location.origin : "http://localhost")
      .pathname.startsWith("/api/uploads/");
  } catch {
    return false;
  }
}

function filenameFromUrl(url: string): string | undefined {
  try {
    const path = new URL(url, typeof location !== "undefined" ? location.origin : "http://localhost")
      .pathname;
    const name = path.split("/").filter(Boolean).pop();
    return name ? decodeURIComponent(name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn a File or an image URL into a private upload URL plus alt text.
 *
 * Copied images are common on the web: `Cmd/Ctrl+C` on an `<img>` puts the
 * image URL in the clipboard HTML rather than a file. We fetch and re-upload
 * those so the saved description never hotlinks a third-party page. Data URLs
 * are uploaded the same way (a pasted screenshot can be huge in markdown), and
 * if a remote image cannot be fetched (CORS) we fall back to using its URL so
 * the paste still attaches something visible.
 */
async function resolveImage(source: ImageInsertSource): Promise<{ url: string; alt: string }> {
  if (typeof source !== "string") {
    const url = await uploadImage(source);
    return { url, alt: altFromName(source.name) };
  }

  const src = source.trim();
  if (!src) throw new Error("That image could not be read.");

  // Already one of our own authenticated uploads: reference it directly.
  if (isUploadUrl(src)) {
    return { url: src, alt: altFromName(filenameFromUrl(src)) };
  }

  const uploadBlob = async (blob: Blob): Promise<string> => {
    if (!blob.type.startsWith("image/")) throw new Error("That clipboard item is not an image.");
    const file = new File([blob], filenameFromUrl(src) || "pasted-image", { type: blob.type });
    return uploadImage(file);
  };

  if (/^data:image\//i.test(src)) {
    const blob = await (await fetch(src)).blob();
    return { url: await uploadBlob(blob), alt: "image" };
  }

  try {
    const res = await fetch(src, { credentials: "omit" });
    if (!res.ok) throw new Error(`Image request failed with ${res.status}`);
    const blob = await res.blob();
    return { url: await uploadBlob(blob), alt: altFromName(filenameFromUrl(src)) };
  } catch (err) {
    // A blob: URL only exists on the page that created it, so it cannot be
    // shown later; surface the error instead of saving a dead link.
    if (/^blob:/i.test(src)) {
      throw err instanceof Error ? err : new Error("That image could not be read.");
    }
    // Remote images that block cross-origin reads still make a valid markdown
    // link, which is better than silently dropping the user's paste.
    return { url: src, alt: altFromName(filenameFromUrl(src)) };
  }
}

/**
 * Upload an image (or reuse a copied image URL) and insert markdown at the
 * textarea's selection. The selection is captured BEFORE the network request,
 * and the result is appended if the user typed while the upload was in flight,
 * so a slow upload can neither lose the image nor overwrite newer text.
 */
export async function insertImageAtCursor(
  textarea: ImageInsertTarget,
  source: ImageInsertSource,
  onChange: (next: string) => void
): Promise<void> {
  const initialValue = textarea.value;
  const start = textarea.selectionStart ?? initialValue.length;
  const end = textarea.selectionEnd ?? start;

  const { url, alt } = await resolveImage(source);
  const markdown = `![${alt}](${url})`;
  const current = textarea.value;
  const at = current === initialValue ? start : current.length;
  const next =
    current === initialValue
      ? current.slice(0, start) + markdown + current.slice(end)
      : current + markdown;

  textarea.value = next;
  const caret = at + markdown.length;
  if (typeof textarea.setSelectionRange === "function") {
    textarea.setSelectionRange(caret, caret);
  }
  onChange(next);
  textarea.focus();
}

function fileFromItems(data: DataTransfer): File | null {
  const items = data.items ? Array.from(data.items) : [];
  for (const item of items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile?.();
    if (file) return file;
  }
  return null;
}

/** First image file in a clipboard/drop payload (files, then items). */
export function imageFrom(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const file of Array.from(data.files ?? [])) {
    if (file.type.startsWith("image/")) return file;
  }
  return fileFromItems(data);
}

function looksLikeImageUrl(value: string): boolean {
  const url = value.trim();
  if (!url) return false;
  if (/^data:image\//i.test(url)) return true;
  if (/^blob:/i.test(url)) return true;
  if (isUploadUrl(url)) return true;
  return /\.(png|jpe?g|gif|webp)(?:[?#]|$)/i.test(url);
}

/**
 * First image URL in a clipboard/drop payload. Covers copying an image element
 * from a browser (`text/html` carries an `<img src>`), copying an image file
 * from Finder/Explorer (`text/uri-list`), and a bare image URL in plain text.
 */
export function imageUrlFrom(data: DataTransfer | null): string | null {
  if (!data || typeof data.getData !== "function") return null;

  const html = data.getData("text/html") || "";
  if (html) {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const src = doc.querySelector("img")?.getAttribute("src")?.trim();
      if (src) return src;
    } catch {
      // Ignore malformed clipboard HTML and try the simpler formats below.
    }
  }

  const uriList = data.getData("text/uri-list") || "";
  for (const line of uriList.split(/\r?\n/)) {
    const value = line.trim();
    if (value && !value.startsWith("#") && looksLikeImageUrl(value)) return value;
  }

  const text = (data.getData("text/plain") || "").trim();
  return looksLikeImageUrl(text) ? text : null;
}

/** First image from a clipboard/drop payload, preferring a real file. */
export function imageSourceFrom(data: DataTransfer | null): ImageInsertSource | null {
  return imageFrom(data) ?? imageUrlFrom(data);
}

const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Images already present in markdown text. Used to keep a live preview under an
 * editor, so an attached image does not visually disappear while the raw
 * markdown source is being edited.
 */
export function markdownImages(text: string): MarkdownImage[] {
  const images: MarkdownImage[] = [];
  if (!text) return images;
  for (const match of text.matchAll(MARKDOWN_IMAGE)) {
    const url = match[2]?.trim();
    if (url) {
      images.push({
        alt: match[1] || "image",
        url,
        markdown: match[0],
        start: match.index ?? 0,
      });
    }
  }
  return images;
}

/** Remove one image exactly as it appears in the source text. */
export function removeMarkdownImage(text: string, image: MarkdownImage): string {
  const start = text.slice(image.start, image.start + image.markdown.length) === image.markdown
    ? image.start
    : text.indexOf(image.markdown);
  if (start < 0) return text;
  const before = text.slice(0, start);
  const after = text.slice(start + image.markdown.length);
  // Collapse the space left at the seam so "one ![x](...) two" becomes
  // "one two", not "one  two", without touching spacing elsewhere.
  const next =
    /[ \t]$/.test(before) && /^[ \t]/.test(after)
      ? before + after.replace(/^[ \t]+/, "")
      : before + after;
  return next.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}
