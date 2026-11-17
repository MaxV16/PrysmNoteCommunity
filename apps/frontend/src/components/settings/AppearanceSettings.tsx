"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_APPEARANCE,
  SURFACE_PRESET_IDS,
  SURFACE_PRESETS,
  TASK_STYLES,
  isSafeImageUrl,
  loadAppearance,
  parseAppearanceJson,
  saveAppearance,
  serialiseAppearance,
  surfaceStyle,
  type AppearanceConfig,
  type SurfacePresetId,
} from "@/lib/appearance";

function SurfacePicker({
  value,
  customImage,
  onChange,
  label,
}: {
  value: SurfacePresetId;
  customImage: string;
  onChange: (next: SurfacePresetId) => void;
  label: string;
}) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {[...SURFACE_PRESET_IDS, "custom" as const].map((preset) => {
        const style = surfaceStyle(preset, customImage);
        const active = value === preset;
        return (
          <button
            key={preset}
            type="button"
            aria-pressed={active}
            aria-label={`${label}: ${preset === "custom" ? "Custom image" : SURFACE_PRESETS[preset].label}`}
            onClick={() => onChange(preset)}
            className={`rounded-xl border-2 p-1.5 text-left transition-colors ${
              active ? "border-accent bg-accent/10" : "border-border bg-elevated hover:border-accent/40"
            }`}
          >
            <span
              aria-hidden
              className="block h-10 w-full rounded-lg border border-border bg-base"
              style={{
                backgroundImage: style.image,
                backgroundSize: style.size,
                backgroundPosition: "center",
              }}
            />
            <span
              className={`mt-1 block truncate text-[10px] font-semibold ${
                active ? "text-accent" : "text-secondary"
              }`}
            >
              {preset === "custom" ? "Custom" : SURFACE_PRESETS[preset].label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Appearance lives in the Customization group next to Features. It is free for
 * every plan: a preset background, a task surface style and glass mode cost no
 * server work and one localStorage entry, so there is nothing to meter.
 */
export function AppearanceSettings() {
  const [config, setConfig] = useState<AppearanceConfig>(DEFAULT_APPEARANCE);
  const [hydrated, setHydrated] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [imageDraft, setImageDraft] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const stored = loadAppearance();
    setConfig(stored);
    setImageDraft(stored.customBoardImage);
    setHydrated(true);
  }, []);

  // Every change is applied and persisted together, so what the workspace
  // shows right now is exactly what the next session restores.
  useEffect(() => {
    if (!hydrated) return;
    saveAppearance(config);
  }, [config, hydrated]);

  const update = (patch: Partial<AppearanceConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
    setNotice(null);
  };

  const importDocument = (text: string) => {
    setErrors([]);
    setNotice(null);
    try {
      const { config: next, errors: problems } = parseAppearanceJson(text);
      setConfig(next);
      setImageDraft(next.customBoardImage);
      setErrors(problems);
      setNotice(problems.length === 0 ? "Appearance imported." : "Imported, with notes below.");
    } catch (err) {
      setErrors([err instanceof Error ? err.message : "Could not read that file."]);
    }
  };

  const exportDocument = () => {
    const blob = new Blob([serialiseAppearance(config)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "prysm-appearance.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="card space-y-5 p-6">
      <div className="flex items-center gap-4">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-accent/15">
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </div>
        <div>
          <h2 className="text-lg font-bold text-primary">Appearance</h2>
          <p className="text-sm text-muted">
            Backgrounds, glass mode and task surface styles. Free on every plan.
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-secondary">Task style</h3>
          <p className="mt-0.5 text-xs text-muted">
            Shapes tasks on the board, in lists and on the timeline.
          </p>
        </div>
        <div className="flex flex-wrap gap-1 rounded-full bg-elevated p-0.5">
          {TASK_STYLES.map((style) => {
            const active = config.taskStyle === style.id;
            return (
              <button
                key={style.id}
                type="button"
                aria-pressed={active}
                title={style.hint}
                onClick={() => update({ taskStyle: style.id })}
                className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
                  active
                    ? "bg-accent font-semibold text-[var(--on-gradient)]"
                    : "text-secondary hover:text-primary"
                }`}
              >
                {style.label}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-muted">
          {TASK_STYLES.find((style) => style.id === config.taskStyle)?.hint}
        </p>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-xl border border-border bg-elevated px-4 py-3">
        <div>
          <p className="text-sm font-medium text-primary">Glass mode</p>
          <p className="text-xs text-muted">
            Panels pick up the background behind them. Off keeps surfaces solid and cheapest to paint.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={config.glass}
          aria-label="Glass mode"
          onClick={() => update({ glass: !config.glass })}
          className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
            config.glass ? "bg-accent" : "bg-border"
          }`}
        >
          <span
            className={`absolute top-0.5 h-4 w-4 rounded-full bg-surface transition-all ${
              config.glass ? "left-[18px]" : "left-0.5"
            }`}
          />
        </button>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-secondary">Board background</h3>
        <SurfacePicker
          label="Board background"
          value={config.board}
          customImage={config.customBoardImage}
          onChange={(next) => update({ board: next })}
        />
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-secondary">
          Countdown background
        </h3>
        <SurfacePicker
          label="Countdown background"
          value={config.countdown}
          customImage={config.customBoardImage}
          onChange={(next) => update({ countdown: next })}
        />
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-secondary">Custom image</h3>
        <p className="text-xs text-muted">
          Used by a surface set to Custom. A plain https image URL only.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="input-field flex-1 text-xs"
            value={imageDraft}
            onChange={(e) => setImageDraft(e.target.value)}
            placeholder="https://example.com/background.jpg"
            aria-label="Custom background image URL"
          />
          <button
            type="button"
            onClick={() => {
              if (!imageDraft) {
                update({ customBoardImage: "", board: config.board === "custom" ? "none" : config.board });
                setErrors([]);
                return;
              }
              if (!isSafeImageUrl(imageDraft)) {
                setErrors(["The custom background must be a plain https image URL."]);
                return;
              }
              setErrors([]);
              update({ customBoardImage: imageDraft });
            }}
            className="btn bg-elevated border border-border px-4 py-1.5 text-xs text-secondary hover:text-primary"
          >
            Use image
          </button>
        </div>
      </div>

      <div className="space-y-2 border-t border-border pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-secondary">
          Import or export
        </h3>
        <p className="text-xs text-muted">
          One JSON document carries every appearance field, so a look can be moved between
          devices or shared.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={exportDocument}
            className="btn bg-elevated border border-border px-4 py-1.5 text-xs text-secondary hover:text-primary"
          >
            Export JSON
          </button>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="btn bg-elevated border border-border px-4 py-1.5 text-xs text-secondary hover:text-primary"
          >
            Import file
          </button>
          <button
            type="button"
            onClick={() => {
              setConfig({ ...DEFAULT_APPEARANCE });
              setImageDraft("");
              setErrors([]);
              setNotice("Appearance reset to the defaults.");
            }}
            className="btn bg-elevated border border-border px-4 py-1.5 text-xs text-secondary hover:text-primary"
          >
            Reset
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              if (file.size > 32 * 1024) {
                setErrors(["That file is larger than 32 KB."]);
                return;
              }
              const reader = new FileReader();
              reader.onload = () => importDocument(String(reader.result ?? ""));
              reader.onerror = () => setErrors(["Could not read that file."]);
              reader.readAsText(file);
            }}
          />
        </div>
        <textarea
          className="input-field min-h-[76px] w-full font-mono text-[11px]"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder='{"appearance":{"board":"aurora","glass":true}}'
          aria-label="Paste appearance JSON"
        />
        <button
          type="button"
          disabled={!importText.trim()}
          onClick={() => importDocument(importText)}
          className="btn btn-primary px-4 py-1.5 text-xs disabled:opacity-60"
        >
          Apply pasted JSON
        </button>
        {notice && (
          <p role="status" className="text-[11px] text-success">
            {notice}
          </p>
        )}
        {errors.length > 0 && (
          <ul role="alert" className="space-y-1">
            {errors.map((error) => (
              <li key={error} className="text-[11px] text-danger">
                {error}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
