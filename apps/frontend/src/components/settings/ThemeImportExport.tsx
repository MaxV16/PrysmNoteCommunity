"use client";

import { useRef, useState } from "react";
import { useTheme } from "@/lib/theme-context";
import { validateCustomTheme, validateCustomThemeError } from "@/lib/theme-vars";
import type { CustomTheme } from "@/types/theme";
import { THEMES, DEFAULT_THEME } from "@/types/theme";
import { useToast } from "@/lib/toast-context";
import { Modal } from "@/components/ui/Modal";

interface ThemeImportExportProps {
  variant?: "full" | "menu";
}

export function ThemeImportExport({ variant = "full" }: ThemeImportExportProps) {
  const { themeName, customTheme, setCustomTheme } = useTheme();
  const { showToast } = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const activeColors = customTheme ?? THEMES[themeName]?.colors ?? THEMES[DEFAULT_THEME].colors;

  const buildPayload = (): Record<string, unknown> => {
    const payload: Record<string, unknown> = { ...activeColors };
    if (customTheme?.label) payload.label = customTheme.label;
    if (customTheme?.extra && Object.keys(customTheme.extra).length > 0) {
      payload.extra = customTheme.extra;
    }
    return payload;
  };

  const handleExport = () => {
    const json = JSON.stringify(buildPayload(), null, 2);
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
      await navigator.clipboard.writeText(JSON.stringify(buildPayload(), null, 2));
      showToast("Theme copied to clipboard", "success");
    } catch {
      showToast("Could not access the clipboard", "error");
    }
  };

  const commitImport = (parsed: unknown) => {
    const err = validateCustomThemeError(parsed);
    if (err) {
      setError(err);
      return;
    }
    const theme = validateCustomTheme(parsed) as CustomTheme;
    setCustomTheme(theme);
    setOpen(false);
    setText("");
    setError(null);
    showToast("Theme imported", "success");
  };

  const handleImport = (raw: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setError("Import failed: not valid JSON");
      return;
    }
    commitImport(parsed);
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => handleImport(String(reader.result ?? ""));
    reader.readAsText(file);
    e.target.value = "";
  };

  const trigger = (
    <button
      onClick={() => {
        setOpen(true);
        setError(null);
        setText("");
      }}
      className={variant === "menu"
        ? "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-secondary transition-colors hover:bg-hover hover:text-primary"
        : "btn bg-elevated border border-border text-secondary px-4 py-2 text-sm rounded-xl hover:text-primary"}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M12 3v12M12 3l-4 4M12 3l4 4M5 21h14" />
      </svg>
      {variant === "menu" ? "Import theme…" : "Import Theme"}
    </button>
  );

  return (
    <>
      {variant === "full" ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleExport}
            className="btn bg-elevated border border-border text-secondary px-4 py-2 text-sm rounded-xl hover:text-primary"
          >
            Export Theme
          </button>
          <button
            onClick={handleCopy}
            className="btn bg-elevated border border-border text-secondary px-4 py-2 text-sm rounded-xl hover:text-primary"
          >
            Copy JSON
          </button>
          {trigger}
        </div>
      ) : (
        trigger
      )}

      <Modal isOpen={open} onClose={() => setOpen(false)} title="Import Theme">
        <div className="space-y-4">
          <div>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={handleFile} />
            <button
              onClick={() => fileRef.current?.click()}
              className="btn bg-elevated border border-border text-secondary px-4 py-2 text-sm rounded-xl hover:text-primary"
            >
              Choose JSON file
            </button>
            <p className="mt-1.5 text-[11px] text-muted">Only allowlisted CSS variables are imported.</p>
          </div>
          <div className="divider-gradient" />
          <div>
            <label className="mb-1.5 block text-xs font-medium text-secondary">Or paste theme JSON</label>
            <textarea
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setError(null);
              }}
              placeholder='{"base":"#07070b","label":"My theme",...}'
              rows={5}
              className="input-field resize-none font-mono text-xs leading-relaxed"
            />
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={() => handleImport(text)}
              className="btn btn-gradient px-5 py-2 text-sm rounded-xl"
            >
              Import
            </button>
            <button
              onClick={() => setOpen(false)}
              className="btn bg-elevated border border-border text-secondary px-4 py-2 text-sm rounded-xl"
            >
              Cancel
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}