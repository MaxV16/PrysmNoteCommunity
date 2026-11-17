// Appearance presets: the opt-in "look" layer that sits on top of the theme
// tokens. Themes change colors; appearance changes the shape of the room:
// the background behind a board or a countdown, how task surfaces are drawn,
// and whether panels let the background show through (glass mode).
//
// Everything here is pure and dependency-free so it can be unit-tested without
// a DOM. The provider (`components/layout/AppearanceProvider.tsx`) is the only
// place that touches `document`, and only through dataset + CSS variables.

export type TaskStyleId = "default" | "soft" | "outline" | "glass";
export type SurfacePresetId =
  | "none"
  | "aurora"
  | "mesh"
  | "dots"
  | "grid"
  | "sunset"
  | "ocean"
  | "forest"
  | "custom";

export interface AppearanceConfig {
  /** How a task surface is drawn on the board, in lists and on the timeline. */
  taskStyle: TaskStyleId;
  /** Let panels pick up the workspace background (opt-in translucency). */
  glass: boolean;
  /** Background behind the board view. */
  board: SurfacePresetId;
  /** Background behind the countdown view. */
  countdown: SurfacePresetId;
  /** Optional https image used when a surface is set to "custom". */
  customBoardImage: string;
}

export const APPEARANCE_KEY = "prysm-appearance-v1";
export const APPEARANCE_EVENT = "prysm-appearance-change";

export const TASK_STYLES: { id: TaskStyleId; label: string; hint: string }[] = [
  { id: "default", label: "Default", hint: "The surface you already know." },
  { id: "soft", label: "Soft", hint: "Rounder task cards with a lighter border." },
  { id: "outline", label: "Outline", hint: "Transparent inside, a crisp edge around." },
  { id: "glass", label: "Glass", hint: "Translucent task surfaces over the background." },
];

export interface SurfacePreset {
  label: string;
  /** CSS background-image value, or "none". */
  image: string;
  /** CSS background-size value. */
  size: string;
}

// Decorative layers are mixed from design tokens rather than fixed colors, so
// every preset follows the active theme (dark, light, slate, coffee, ...).
const accentMix = (token: string, percent: number) =>
  `color-mix(in srgb, ${token} ${percent}%, transparent)`;

export const SURFACE_PRESETS: Record<Exclude<SurfacePresetId, "custom">, SurfacePreset> = {
  none: { label: "None", image: "none", size: "auto" },
  aurora: {
    label: "Aurora",
    image: [
      `radial-gradient(120% 90% at 8% 0%, ${accentMix("var(--accent)", 30)} 0%, transparent 58%)`,
      `radial-gradient(90% 80% at 92% 8%, ${accentMix("var(--success)", 22)} 0%, transparent 60%)`,
      `radial-gradient(80% 70% at 50% 110%, ${accentMix("var(--warning)", 18)} 0%, transparent 62%)`,
    ].join(", "),
    size: "cover",
  },
  mesh: {
    label: "Mesh",
    image: [
      `radial-gradient(70% 60% at 15% 20%, ${accentMix("var(--accent)", 26)} 0%, transparent 62%)`,
      `radial-gradient(60% 55% at 85% 15%, ${accentMix("var(--accent-hover)", 24)} 0%, transparent 60%)`,
      `radial-gradient(75% 65% at 70% 95%, ${accentMix("var(--danger)", 14)} 0%, transparent 64%)`,
    ].join(", "),
    size: "cover",
  },
  dots: {
    label: "Dots",
    image: `radial-gradient(${accentMix("var(--text-muted)", 24)} 1px, transparent 1.4px)`,
    size: "18px 18px",
  },
  grid: {
    label: "Grid",
    image: [
      `linear-gradient(${accentMix("var(--border)", 80)} 1px, transparent 1px)`,
      `linear-gradient(90deg, ${accentMix("var(--border)", 80)} 1px, transparent 1px)`,
    ].join(", "),
    size: "28px 28px",
  },
  sunset: {
    label: "Sunset",
    image: [
      `radial-gradient(100% 80% at 50% 115%, ${accentMix("var(--warning)", 34)} 0%, transparent 62%)`,
      `radial-gradient(90% 70% at 12% 0%, ${accentMix("var(--danger)", 20)} 0%, transparent 58%)`,
      `radial-gradient(80% 60% at 92% 10%, ${accentMix("var(--accent)", 18)} 0%, transparent 55%)`,
    ].join(", "),
    size: "cover",
  },
  ocean: {
    label: "Ocean",
    image: [
      `radial-gradient(110% 85% at 20% 110%, ${accentMix("var(--accent)", 32)} 0%, transparent 62%)`,
      `radial-gradient(85% 70% at 85% 0%, ${accentMix("var(--success)", 20)} 0%, transparent 58%)`,
    ].join(", "),
    size: "cover",
  },
  forest: {
    label: "Forest",
    image: [
      `radial-gradient(95% 75% at 10% 10%, ${accentMix("var(--success)", 26)} 0%, transparent 60%)`,
      `radial-gradient(90% 80% at 90% 100%, ${accentMix("var(--success)", 16)} 0%, transparent 62%)`,
    ].join(", "),
    size: "cover",
  },
};

export const SURFACE_PRESET_IDS = Object.keys(SURFACE_PRESETS) as Array<
  Exclude<SurfacePresetId, "custom">
>;

export const DEFAULT_APPEARANCE: AppearanceConfig = {
  taskStyle: "default",
  glass: false,
  board: "none",
  countdown: "none",
  customBoardImage: "",
};

const TASK_STYLE_IDS = new Set<string>(TASK_STYLES.map((style) => style.id));
const SURFACE_IDS = new Set<string>([...SURFACE_PRESET_IDS, "custom"]);

/**
 * Only plain https image URLs are accepted. The value ends up inside
 * `url("...")`, so quotes, parentheses, backslashes and whitespace are refused
 * rather than escaped: a rejected URL is cheaper than a CSS injection.
 */
export function isSafeImageUrl(value: string): boolean {
  if (!value || value.length > 500) return false;
  if (!/^https:\/\/[^\s"'()\\<>]+$/i.test(value)) return false;
  return true;
}

/**
 * Validate an unknown value (parsed JSON, a stored entry, a pasted document)
 * into a complete config. Unknown or invalid fields fall back to the default
 * and are reported, so the caller can show what was ignored instead of
 * silently applying half a config.
 */
export function parseAppearance(input: unknown): {
  config: AppearanceConfig;
  errors: string[];
} {
  const errors: string[] = [];
  const config: AppearanceConfig = { ...DEFAULT_APPEARANCE };
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { config, errors: ["Appearance must be a JSON object."] };
  }
  const raw = input as Record<string, unknown>;
  // Accept `{ appearance: {...} }` so an exported document can be re-imported
  // as-is, even when it also carries unrelated metadata.
  const body =
    raw.appearance && typeof raw.appearance === "object" && !Array.isArray(raw.appearance)
      ? (raw.appearance as Record<string, unknown>)
      : raw;

  if (typeof body.taskStyle === "string" && TASK_STYLE_IDS.has(body.taskStyle)) {
    config.taskStyle = body.taskStyle as TaskStyleId;
  } else if (body.taskStyle !== undefined) {
    errors.push(`Unknown task style: ${String(body.taskStyle)}`);
  }

  if (typeof body.glass === "boolean") {
    config.glass = body.glass;
  } else if (body.glass !== undefined) {
    errors.push("glass must be true or false.");
  }

  for (const surface of ["board", "countdown"] as const) {
    const value = body[surface];
    if (typeof value === "string" && SURFACE_IDS.has(value)) {
      config[surface] = value as SurfacePresetId;
    } else if (value !== undefined) {
      errors.push(`Unknown ${surface} background: ${String(value)}`);
    }
  }

  if (typeof body.customBoardImage === "string") {
    if (body.customBoardImage === "") {
      config.customBoardImage = "";
    } else if (isSafeImageUrl(body.customBoardImage)) {
      config.customBoardImage = body.customBoardImage;
    } else {
      errors.push("The custom background must be a plain https image URL.");
    }
  } else if (body.customBoardImage !== undefined) {
    errors.push("customBoardImage must be a string.");
  }

  if (config.board === "custom" && !config.customBoardImage) {
    errors.push("A custom board background needs an https image URL.");
    config.board = "none";
  }

  return { config, errors };
}

/** Parse a pasted JSON document. Throws a readable error for invalid JSON. */
export function parseAppearanceJson(text: string): {
  config: AppearanceConfig;
  errors: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  return parseAppearance(parsed);
}

/** The preset CSS for one surface, including the custom image escape hatch. */
export function surfaceStyle(
  preset: SurfacePresetId,
  customImage: string
): { image: string; size: string } {
  if (preset === "custom" && isSafeImageUrl(customImage)) {
    return { image: `url("${customImage}")`, size: "cover" };
  }
  return SURFACE_PRESETS[preset === "custom" ? "none" : preset];
}

/** Serialise a config for the "Export" button (stable key order, readable). */
export function serialiseAppearance(config: AppearanceConfig): string {
  return JSON.stringify({ appearance: config }, null, 2);
}

/** CSS variables the provider writes onto `:root`. */
export function appearanceVars(config: AppearanceConfig): Record<string, string> {
  const board = surfaceStyle(config.board, config.customBoardImage);
  const countdown = surfaceStyle(config.countdown, config.customBoardImage);
  return {
    "--surface-board-image": board.image,
    "--surface-board-size": board.size,
    "--surface-countdown-image": countdown.image,
    "--surface-countdown-size": countdown.size,
  };
}

export function loadAppearance(): AppearanceConfig {
  if (typeof window === "undefined") return { ...DEFAULT_APPEARANCE };
  try {
    const stored = window.localStorage.getItem(APPEARANCE_KEY);
    if (!stored) return { ...DEFAULT_APPEARANCE };
    return parseAppearance(JSON.parse(stored)).config;
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(config: AppearanceConfig): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(APPEARANCE_KEY, JSON.stringify(config));
  } catch {
    // Storage can be full or blocked (private mode); appearance is cosmetic,
    // so the in-memory application below still runs for this session.
  }
  window.dispatchEvent(new Event(APPEARANCE_EVENT));
}

/** Apply a config to the document root. Cosmetic only, never throws. */
export function applyAppearance(config: AppearanceConfig): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.taskStyle = config.taskStyle;
  root.dataset.glass = config.glass ? "true" : "false";
  const vars = appearanceVars(config);
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
}
