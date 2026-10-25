"use client";

import { useMemo, useRef, useState } from "react";
import { useTheme } from "@/lib/theme-context";
import { useToast } from "@/lib/toast-context";
import { Modal } from "@/components/ui/Modal";
import type { ThemeColors } from "@/types/theme";
import { DEFAULT_THEME, THEMES } from "@/types/theme";
import {
  MAX_THEME_DOC_LENGTH,
  describeTheme,
  parseThemeDocument,
  serializeThemeDocument,
  themeColorsToVars,
  type ThemeDescription,
} from "@/lib/theme-import";

/**
 * Advanced theme import: sets any allowlisted design token, free for every user.
 *
 * The dialog is deliberately small and the parser does all the work, so there is
 * no CSS parser in the bundle: a theme is a flat JSON map of custom properties.
 * `KNOWN_CSS_VARS` in `src/lib/theme-vars.ts` is the source of truth for names.
 */
export function ThemeTokenImport({ variant = "full" }: { variant?: "full" | "menu" }) {
  const { themeName, customTheme, importCustomTheme } = useTheme();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<ThemeDescription | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const currentColors = useMemo(
    () => (customTheme ?? THEMES[themeName]?.colors ?? THEMES[DEFAULT_THEME].colors) as ThemeColors,
    [customTheme, themeName],
  );

  const currentDocument = useMemo(
    () => ({
      name: customTheme?.label ?? "My Prysm theme",
      vars: {
        ...themeColorsToVars(currentColors as unknown as Record<string, unknown>),
        ...(customTheme?.extra ?? {}),
      },
    }),
    [currentColors, customTheme],
  );

  const reset = () => {
    setText("");
    setErrors([]);
    setPreview(null);
    setDragging(false);
  };

  const inspect = (raw: string) => {
    if (!raw.trim()) {
      setErrors([]);
      setPreview(null);
      return;
    }
    const result = parseThemeDocument(raw);
    if (result.ok) {
      setErrors([]);
      setPreview(describeTheme(result.theme));
    } else {
      setPreview(null);
      setErrors(result.errors);
    }
  };

  const handleText = (raw: string) => {
    setText(raw);
    inspect(raw);
  };

  const readFile = async (file: File) => {
    if (file.size > MAX_THEME_DOC_LENGTH) {
      setErrors([`That file is too large (max ${MAX_THEME_DOC_LENGTH / 1024} KB).`]);
      setPreview(null);
      return;
    }
    if (!/\.json$/i.test(file.name) && file.type !== "application/json") {
      setErrors(["Choose a .json theme file."]);
      setPreview(null);
      return;
    }
    try {
      const raw = await file.text();
      setText(raw);
      inspect(raw);
    } catch {
      setErrors(["Could not read that file."]);
      setPreview(null);
    }
  };

  const handleFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) void readFile(file);
    event.target.value = "";
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void readFile(file);
  };

  const handleImport = () => {
    const result = importCustomTheme(text);
    if (!result.ok) {
      setErrors(result.errors);
      setPreview(null);
      return;
    }
    const description = describeTheme(result.theme);
    showToast(`${description.name} applied, ${description.count} token${description.count === 1 ? "" : "s"}`, "success");
    setOpen(false);
    reset();
  };

  const handleExportDownload = () => {
    const json = serializeThemeDocument(currentDocument);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "prysm-theme.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    showToast("Theme exported as prysm-theme.json", "success");
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(serializeThemeDocument(currentDocument));
      showToast("Theme JSON copied", "success");
    } catch {
      showToast("Could not access the clipboard", "error");
    }
  };

  return (
    <>
      {variant === "menu" ? (
        <button
          onClick={() => {
            reset();
            setOpen(true);
          }}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-secondary transition-colors hover:bg-hover hover:text-primary"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M12 3v12M12 15l-4-4M12 15l4-4M5 21h14" />
          </svg>
          Import theme…
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => {
            reset();
            setOpen(true);
          }}
          className="btn bg-elevated border border-border text-secondary px-4 py-2 text-sm rounded-xl hover:text-primary min-h-11 sm:min-h-9"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 3v12M12 15l-4-4M12 15l4-4M5 21h14" />
          </svg>
          Import theme tokens
        </button>
        <button
          onClick={handleExportDownload}
          className="btn bg-elevated border border-border text-secondary px-4 py-2 text-sm rounded-xl hover:text-primary min-h-11 sm:min-h-9"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 15V3M12 3l-4 4M12 3l4 4M5 21h14" />
          </svg>
          Export theme
        </button>
        </div>
      )}

      <Modal isOpen={open} onClose={() => { setOpen(false); reset(); }} title="Import theme tokens">
        <div className="space-y-4 pb-1">
          <p className="text-xs text-secondary">
            A theme is a small JSON map of CSS custom properties. Any token from the allowlist works: colors
            (<span className="font-mono text-[11px]">--accent</span>,{" "}
            <span className="font-mono text-[11px]">--bg-base</span>,{" "}
            <span className="font-mono text-[11px]">--text-primary</span>), radii, shadows and motion. Layout
            tokens such as <span className="font-mono text-[11px]">--ui-scale</span> stay read-only. The full
            list lives in <span className="font-mono text-[11px]">src/lib/theme-vars.ts</span>.
          </p>

          <div
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={`rounded-xl border border-dashed px-4 py-4 text-center transition-colors ${
              dragging ? "border-accent bg-accent/10" : "border-border bg-elevated"
            }`}
          >
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={handleFile}
            />
            <p className="text-xs text-secondary">Drop a .json theme here, or</p>
            <button
              onClick={() => fileRef.current?.click()}
              className="btn bg-surface border border-border text-secondary mt-2 px-4 py-2 text-xs rounded-xl hover:text-primary min-h-11 sm:min-h-9"
            >
              Choose file
            </button>
          </div>

          <div>
            <label htmlFor="theme-import-text" className="mb-1.5 block text-xs font-medium text-secondary">
              Or paste theme JSON
            </label>
            <textarea
              id="theme-import-text"
              value={text}
              onChange={(event) => handleText(event.target.value)}
              placeholder={'{\n  "name": "Deep Ocean",\n  "vars": { "--accent": "#5AA9FF" }\n}'}
              rows={6}
              spellCheck={false}
              className="input-field w-full min-h-[7rem] resize-y font-mono text-xs leading-relaxed"
            />
          </div>

          {errors.length > 0 && (
            <div className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2" role="alert">
              <p className="text-xs font-semibold text-danger">Theme could not be imported</p>
              <ul className="mt-1 space-y-0.5 text-[11px] text-danger">
                {errors.map((error) => (
                  <li key={error} className="break-words">{error}</li>
                ))}
              </ul>
            </div>
          )}

          {preview && (
            <div className="rounded-xl border border-border bg-elevated px-3 py-2.5">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <p className="min-w-0 truncate text-xs font-semibold text-primary">{preview.name}</p>
                <span className="text-[10px] text-muted">
                  {preview.count} token{preview.count === 1 ? "" : "s"}
                  {preview.author ? ` by ${preview.author}` : ""}
                </span>
              </div>
              {preview.swatches.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {preview.swatches.map((swatch, index) => (
                    <span
                      key={`${swatch}-${index}`}
                      className="h-6 w-6 rounded-md border border-border"
                      style={{ backgroundColor: swatch }}
                      title={swatch}
                    />
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleImport}
              disabled={!text.trim()}
              className="btn btn-primary px-5 py-2 text-sm rounded-xl min-h-11 sm:min-h-9 disabled:opacity-50"
            >
              Import
            </button>
            <button
              onClick={() => { setOpen(false); reset(); }}
              className="btn bg-elevated border border-border text-secondary px-4 py-2 text-sm rounded-xl min-h-11 sm:min-h-9"
            >
              Cancel
            </button>
            <button
              onClick={handleCopy}
              className="btn bg-elevated border border-border text-secondary px-4 py-2 text-sm rounded-xl min-h-11 sm:min-h-9"
            >
              Copy current
            </button>
            <a
              href="/themes/example.json"
              download="prysm-theme-example.json"
              className="btn bg-elevated border border-border text-secondary px-4 py-2 text-sm rounded-xl hover:text-primary min-h-11 sm:min-h-9 inline-flex items-center"
            >
              Example
            </a>
          </div>
        </div>
      </Modal>
    </>
  );
}
