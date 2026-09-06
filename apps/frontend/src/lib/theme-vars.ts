import type { CustomTheme, ThemeColors } from "@/types/theme";

export const KNOWN_CSS_VARS: ReadonlySet<string> = new Set([
  "--bg-base",
  "--bg-surface",
  "--bg-elevated",
  "--bg-hover",
  "--border",
  "--text-primary",
  "--text-secondary",
  "--text-muted",
  "--accent",
  "--accent-hover",
  "--accent-glow",
  "--grad-from",
  "--grad-via",
  "--grad-to",
  "--on-gradient",
  "--shadow-glow-strong",
  "--danger",
  "--danger-hover",
  "--success",
  "--success-hover",
  "--warning",
  "--warning-hover",
  "--info",
  "--text-info",
  "--ring",
  "--radius-xs",
  "--radius-sm",
  "--radius-md",
  "--radius-lg",
  "--radius-xl",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
  "--shadow-glow",
  "--bg-image",
  "--bg-size",
  "--bg-opacity",
  "--bg-image-display",
  "--font-ui",
]);

const COLOR_RE = /^#?[0-9a-f]{3,8}$|^rgb(a)?\(|^hsl(a)?\(/i;
const SAFE_CSS_RE = /^[A-Za-z0-9 %#(),.+\-]+$/;
const VAR_KEY_RE = /^--[a-z0-9][a-z0-9-]*$/;

const COLOR_KEYS = new Set([
  "base",
  "surface",
  "elevated",
  "hover",
  "border",
  "primary",
  "secondary",
  "muted",
  "accent",
  "accent-hover",
  "danger",
  "success",
  "warning",
] as const);

const SHADOW_KEYS = new Set(["shadow-sm", "shadow-md", "shadow-lg", "accent-glow"] as const);

const OPTIONAL_KEYS = new Set(["on-gradient"] as const);

const REQUIRED_KEYS: string[] = [...COLOR_KEYS, ...SHADOW_KEYS];

const MAX_EXTRA_ENTRIES = 100;
const MAX_VALUE_LENGTH = 500;
const MAX_LABEL_LENGTH = 60;

function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9 \-]/g, "").trim();
  return cleaned && cleaned.length <= MAX_LABEL_LENGTH ? cleaned : "";
}

function sanitizeCssValue(value: string): string {
  const v = value.trim();
  return v.length <= MAX_VALUE_LENGTH && SAFE_CSS_RE.test(v) ? v : "";
}

function isValidStandardValue(key: string, value: string): boolean {
  const trimmed = value.trim();
  if (COLOR_KEYS.has(key as never) || key === "accent-glow") {
    return COLOR_RE.test(trimmed);
  }
  return SAFE_CSS_RE.test(trimmed);
}

export function validateCustomThemeError(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return "Import failed: expected a JSON object";
  }
  const obj = raw as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) {
    const v = obj[key];
    if (typeof v !== "string" || !v.trim()) {
      return `Import failed: field "${key}" is missing or empty`;
    }
    if (!isValidStandardValue(key, v)) {
      return `Import failed: field "${key}" is not a valid color or shadow`;
    }
  }
  for (const key of OPTIONAL_KEYS) {
    const v = obj[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || !v.trim()) {
      return `Import failed: field "${key}" is missing or empty`;
    }
    const trimmed = v.trim();
    const ok = COLOR_RE.test(trimmed);
    if (!ok) {
      return `Import failed: field "${key}" is not a valid color or shadow`;
    }
  }
  if (obj.label !== undefined && typeof obj.label !== "string") {
    return "Import failed: label must be a string";
  }
  if (obj.extra !== undefined) {
    if (!obj.extra || typeof obj.extra !== "object" || Array.isArray(obj.extra)) {
      return "Import failed: extra must be an object of CSS custom properties";
    }
    const extra = obj.extra as Record<string, unknown>;
    const entries = Object.entries(extra);
    if (entries.length > MAX_EXTRA_ENTRIES) {
      return `Import failed: extra has too many variables (max ${MAX_EXTRA_ENTRIES})`;
    }
    for (const [key, value] of entries) {
      if (!VAR_KEY_RE.test(key)) {
        return `Import failed: invalid variable name "${key}"`;
      }
      if (!KNOWN_CSS_VARS.has(key)) {
        return `Import failed: "${key}" is not an allowed variable`;
      }
      if (typeof value !== "string") {
        return `Import failed: "${key}" must be a string`;
      }
      // Extra values drop straight into CSS custom properties, so anything that
      // is not the safe grammar must fail inline rather than being silently
      // discarded (a `;`/`{}` would never run, but the user should see why).
      const trimmed = value.trim();
      if (trimmed.length > MAX_VALUE_LENGTH || !SAFE_CSS_RE.test(trimmed)) {
        return `Import failed: "${key}" is not a safe CSS value`;
      }
    }
  }
  return null;
}

export function validateCustomTheme(raw: unknown): CustomTheme | null {
  const error = validateCustomThemeError(raw);
  if (error) return null;
  const obj = raw as Record<string, unknown>;
  const colors = {} as Record<string, string>;
  for (const key of REQUIRED_KEYS) {
    colors[key] = String(obj[key]).trim();
  }
  for (const key of OPTIONAL_KEYS) {
    const v = obj[key];
    if (v !== undefined) {
      colors[key as string] = String(v).trim();
    }
  }
  const theme: CustomTheme = colors as unknown as ThemeColors;
  if (typeof obj.label === "string") {
    const label = sanitizeLabel(obj.label);
    if (label) theme.label = label;
  }
  if (obj.extra !== undefined) {
    const extra: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj.extra as Record<string, unknown>)) {
      const safe = sanitizeCssValue(value as string);
      if (safe) extra[key] = safe;
    }
    theme.extra = extra;
  }
  return theme;
}