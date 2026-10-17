import { api } from "@/lib/api";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

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

/** Upload an image and insert markdown at the textarea's current selection. */
export async function insertImageAtCursor(
  textarea: HTMLTextAreaElement,
  file: File,
  onChange: (next: string) => void
): Promise<void> {
  const url = await uploadImage(file);
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? start;
  const alt = (file.name || "image").replace(/\.[^.]+$/, "").trim() || "image";
  const markdown = `![${alt}](${url})`;
  if (typeof textarea.setRangeText === "function") {
    textarea.setRangeText(markdown, start, end, "end");
  } else {
    textarea.value = textarea.value.slice(0, start) + markdown + textarea.value.slice(end);
  }
  onChange(textarea.value);
  textarea.focus();
}

export function imageFrom(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const file of Array.from(data.files)) {
    if (file.type.startsWith("image/")) return file;
  }
  return null;
}
