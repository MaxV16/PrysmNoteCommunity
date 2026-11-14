"use client";

import {
  useEffect,
  useRef,
  useState,
  type FocusEventHandler,
  type KeyboardEventHandler,
  type ReactNode,
  type RefObject,
} from "react";
import { MarkdownToolbar } from "./MarkdownToolbar";
import { MarkdownImagePreview } from "./MarkdownImagePreview";
import { imageSourceFrom, insertImageAtCursor, removeMarkdownImage } from "@/lib/upload";

/** Two lines at rest, never taller than a short note. */
const MIN_HEIGHT = 60;
const MAX_HEIGHT = 320;

interface MarkdownEditorProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Optional external ref (callers that need to restore the caret themselves). */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  variant?: "full" | "inline";
  onBlur?: FocusEventHandler<HTMLTextAreaElement>;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  /** Right-aligned controls in the formatting strip (e.g. a hint or Done). */
  actions?: ReactNode;
  /** Notified when an image upload starts or finishes (callers gate their save). */
  onUploadingChange?: (uploading: boolean) => void;
  className?: string;
  ariaLabel?: string;
}

/**
 * The app's writing surface: prose, not a text field.
 *
 * Design notes worth keeping:
 * - No box. A description is a passage of writing attached to a task, so it sits
 *   directly on the panel like a sheet of paper. Wrapping it in a border while
 *   the one-line inputs beside it are also bordered is what made the old
 *   composer read as boxes nested in boxes.
 * - The margin rule is the one deliberate flourish: a hairline that fades in on
 *   the left edge while you write, like the rule down a notebook page. It marks
 *   the long-form area without drawing another frame around it.
 * - Formatting is progressive: the strip is always in the DOM but only becomes
 *   visible while the editor has focus, so the resting form stays quiet and
 *   showing it costs no render (pure CSS on `group-focus-within`).
 * - The textarea grows with the text, so an empty description is two lines.
 */
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  autoFocus = false,
  textareaRef,
  variant = "full",
  onBlur,
  onKeyDown,
  actions,
  onUploadingChange,
  className,
  ariaLabel,
}: MarkdownEditorProps) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  // Callers may hand in a ref created with `null` in its type, which React's
  // textarea prop rejects; the element contract is identical.
  const ref = (textareaRef ?? localRef) as RefObject<HTMLTextAreaElement>;
  const [uploading, setUploading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  // Grow to fit the text instead of reserving a fixed block.
  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, MIN_HEIGHT), MAX_HEIGHT)}px`;
  }, [ref, value]);

  const handleSource = async (source: ReturnType<typeof imageSourceFrom>) => {
    const ta = ref.current;
    if (!source || !ta) return;
    setImageError(null);
    setUploading(true);
    onUploadingChange?.(true);
    try {
      await insertImageAtCursor(ta, source, onChange);
    } catch (err) {
      setImageError(err instanceof Error ? err.message : "Could not upload that image.");
    } finally {
      setUploading(false);
      onUploadingChange?.(false);
    }
  };

  return (
    <div
      className={`group relative w-full ${className ?? ""}`}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPaste={(e) => {
          const source = imageSourceFrom(e.clipboardData);
          if (!source) return;
          e.preventDefault();
          void handleSource(source);
        }}
        onDragOver={(e) => {
          if (imageSourceFrom(e.dataTransfer)) e.preventDefault();
        }}
        onDrop={(e) => {
          const source = imageSourceFrom(e.dataTransfer);
          if (!source) return;
          e.preventDefault();
          void handleSource(source);
        }}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={2}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        style={{ minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT }}
        className="block w-full resize-none border-0 bg-transparent py-1.5 pr-2 text-sm leading-6 text-primary outline-none placeholder:text-[var(--text-muted)]"
      />
      <MarkdownImagePreview
        text={value}
        className="pr-2 pb-1"
        onRemove={(image) => onChange(removeMarkdownImage(value, image))}
      />
      {(uploading || imageError) && (
        <p className="pb-1">
          {uploading && (
            <span role="status" className="text-[10px] text-secondary">
              Uploading image...
            </span>
          )}
          {imageError && (
            <span role="alert" className="text-[10px] text-danger">
              {imageError}
            </span>
          )}
        </p>
      )}
      <div className="hidden items-center gap-2 pb-0.5 pt-0.5 group-focus-within:flex">
        <MarkdownToolbar
          textareaRef={ref}
          onChange={onChange}
          variant={variant}
          nowrap
          className="-ml-1.5 min-w-0 flex-1"
        />
        {actions && <div className="ml-auto flex shrink-0 items-center gap-2 pr-1">{actions}</div>}
      </div>
    </div>
  );
}
