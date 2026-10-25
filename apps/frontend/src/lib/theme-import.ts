import { KNOWN_CSS_VARS, NON_THEME_CSS_VARS } from "@/lib/theme-vars";

/**
 * Strict, dependency-free parser for importable theme documents.
 *
 * A document is a small JSON object that sets any subset of the app's design
 * tokens. It is intentionally cheap: the whole file is capped at 32 KB, the
 * number of tokens is capped at 200, and every value must fit a conservative
 * CSS grammar. Values are only ever handed to `element.style.setProperty`,
 * never concatenated into a stylesheet, so a rejected value is a hard error
 * rather than a silent drop.
 *
 * Shape:
 *   {
 *     "format": "prysm-theme",   // optional, validated when present
 *     "formatVersion": 1,        // optional, validated when present
 *     "name": "Deep Ocean",      // optional, display only
 *     "author": "you",           // optional, display only
 *     "version": "1.0",          // optional, display only
 *     "vars": { "--accent": "#9B7BFF", "--bg-base": "#07070b" }
 *   }
 *
 * A bare token map (`{ "--accent": "#9B7BFF" }`) is accepted too, so a user can
 * eke out a theme by hand with as little syntax as possible.
 */

export const THEME_DOC_FORMAT = "prysm-theme";
export const THEME_DOC_VERSION = 1;

/** Hard ceilings. All three keep parsing and applying effectively free. */
export const MAX_THEME_DOC_LENGTH = 32 * 1024;
export const MAX_THEME_KEYS = 200;
export const MAX_THEME_VALUE_LENGTH = 120;
export const MAX_THEME_META_LENGTH = 60;

const MAX_REPORTED_ERRORS = 8;

export interface ImportedTheme {
  name?: string;
  author?: string;
  version?: string;
  vars: Record<string, string>;
}

export type ThemeParseResult =
  | { ok: true; theme: ImportedTheme }
  | { ok: false; errors: string[] };

export interface ThemeDescription {
  name: string;
  author?: string;
  version?: string;
  /** Number of tokens the theme overrides. */
  count: number;
  /** Up to six color values, for a compact preview strip. */
  swatches: string[];
}

const DOC_KEYS = new Set(["format", "formatVersion", "name", "author", "version", "vars"]);

const VAR_KEY_RE = /^--[a-z0-9][a-z0-9-]*$/;

// The conservative grammar a value may use: hex colors, rgb()/hsl()/oklch()/
// color-mix() arguments, numbers with units, and keyword values. Nothing that
// can start a new declaration, a new rule, a comment, or a fetch.
const VALUE_CHARS_RE = /^[A-Za-z0-9 %#(),./+-]+$/;

// Rejected as substrings (matched case-insensitively). `url(` and `@import`
// would fetch a remote resource, `;`/`{`/`}` would break out of a declaration,
// and `expression`/`javascript:` are legacy script vectors.
const FORBIDDEN_SEQUENCES = [
  "url(",
  "@",
  ";",
  "{",
  "}",
  "<",
  ">",
  "\\",
  "expression",
  "javascript:",
  "/*",
  "*/",
  "&",
];

const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

// Every CSS function a theme value may call. Anything else (url, image-set,
// element, attr, ...) is rejected with a clear message.
const ALLOWED_FUNCTIONS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "oklch",
  "oklab",
  "lab",
  "lch",
  "hwb",
  "color",
  "color-mix",
  "var",
  "calc",
  "min",
  "max",
  "clamp",
  "cubic-bezier",
  "steps",
  "linear-gradient",
  "radial-gradient",
  "conic-gradient",
  "repeating-linear-gradient",
  "drop-shadow",
  "inset",
]);

const COLOR_VALUE_RE = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|hwb\(|color\()/i;

const SWATCH_PRIORITY = [
  "--accent",
  "--bg-base",
  "--bg-surface",
  "--bg-elevated",
  "--text-primary",
  "--border",
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limited(errors: string[]): string[] {
  if (errors.length <= MAX_REPORTED_ERRORS) return errors;
  const shown = errors.slice(0, MAX_REPORTED_ERRORS);
  shown.push(`and ${errors.length - MAX_REPORTED_ERRORS} more issue(s).`);
  return shown;
}

function fail(error: string): ThemeParseResult {
  return { ok: false, errors: [error] };
}

/**
 * Walk parentheses once: every "(" must belong to an allowlisted function and
 * the parentheses must balance. O(value.length) with a 120 char ceiling.
 */
function checkFunctions(value: string): { ok: boolean; name?: string } {
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "(") {
      let start = i - 1;
      while (start >= 0 && /[A-Za-z-]/.test(value[start])) start -= 1;
      const name = value.slice(start + 1, i).toLowerCase();
      if (!name || !ALLOWED_FUNCTIONS.has(name)) return { ok: false, name: name || undefined };
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth < 0) return { ok: false };
    }
  }
  return { ok: depth === 0 };
}

/**
 * Validate one token value. Returns the trimmed value on success, or a short
 * reason (sentence fragment) on failure so the UI can say exactly what is wrong.
 */
export function sanitizeThemeValue(
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.trim();
  if (!value) return { ok: false, error: "is empty." };
  if (value.length > MAX_THEME_VALUE_LENGTH) {
    return { ok: false, error: `is too long (max ${MAX_THEME_VALUE_LENGTH} characters).` };
  }
  if (CONTROL_CHARS_RE.test(value)) return { ok: false, error: "contains control characters." };

  const lower = value.toLowerCase();
  for (const bad of FORBIDDEN_SEQUENCES) {
    if (lower.includes(bad)) return { ok: false, error: `uses "${bad}", which is not allowed.` };
  }
  if (!VALUE_CHARS_RE.test(value)) {
    return { ok: false, error: "has characters that are not allowed in a theme value." };
  }

  const fn = checkFunctions(value);
  if (!fn.ok) {
    return {
      ok: false,
      error: fn.name
        ? `uses the CSS function "${fn.name}()", which is not allowed.`
        : "has unbalanced parentheses.",
    };
  }
  return { ok: true, value };
}

export function isSafeThemeValue(value: string): boolean {
  return sanitizeThemeValue(value).ok;
}

function readMeta(
  obj: Record<string, unknown>,
  field: "name" | "author" | "version",
  errors: string[],
): string | undefined {
  const value = obj[field];
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value).slice(0, MAX_THEME_META_LENGTH);
  }
  if (typeof value !== "string") {
    errors.push(`"${field}" must be text.`);
    return undefined;
  }
  // Display only, never HTML: strip control characters and angle brackets, then
  // clamp the length so a long name cannot bloat storage or the dialog.
  const cleaned = value.replace(/[\u0000-\u001f\u007f<>]/g, "").trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, MAX_THEME_META_LENGTH);
}

const LEGACY_META_KEYS = new Set(["label", "extra", "name", "author", "version"]);

/**
 * Convert an old palette-shaped theme document into tokens.
 *
 * Returns null when the object is not a legacy palette (so the caller can keep
 * reporting a helpful error), and null when it mixes palette keys with unknown
 * fields, because that is more likely a typo than a theme.
 */
export function convertLegacyThemeDoc(
  raw: Record<string, unknown>,
): { vars: Record<string, string>; name?: string } | null {
  const keys = Object.keys(raw);
  if (!keys.some((key) => key in COLOR_KEY_TO_VAR)) return null;
  if (keys.some((key) => !(key in COLOR_KEY_TO_VAR) && !LEGACY_META_KEYS.has(key))) return null;

  const vars = themeColorsToVars(raw);
  const extra = raw.extra;
  if (isPlainObject(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === "string") vars[key] = value;
    }
  }
  const name =
    typeof raw.label === "string"
      ? raw.label
      : typeof raw.name === "string"
        ? raw.name
        : undefined;
  return { vars, name };
}

/** Parse and validate a theme document. Never throws. */
export function parseThemeDocument(text: string): ThemeParseResult {
  if (typeof text !== "string") return fail("Theme file must be text.");
  if (text.length > MAX_THEME_DOC_LENGTH) {
    return fail(`Theme file is too large (max ${MAX_THEME_DOC_LENGTH / 1024} KB).`);
  }
  const trimmed = text.trim();
  if (!trimmed) return fail("Theme file is empty.");

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return fail("Theme file is not valid JSON.");
  }
  if (!isPlainObject(raw)) return fail("Theme file must be a JSON object.");

  const errors: string[] = [];
  const meta: Record<string, unknown> = {};
  let varsInput: Record<string, unknown>;

  if ("vars" in raw) {
    for (const key of Object.keys(raw)) {
      if (!DOC_KEYS.has(key)) {
        errors.push(`Unknown field "${key}". Allowed fields: format, name, author, version, vars.`);
      }
    }
    if (raw.format !== undefined && raw.format !== THEME_DOC_FORMAT) {
      errors.push(`Unknown format "${String(raw.format)}". Expected "${THEME_DOC_FORMAT}".`);
    }
    if (
      raw.formatVersion !== undefined &&
      raw.formatVersion !== THEME_DOC_VERSION &&
      raw.formatVersion !== String(THEME_DOC_VERSION)
    ) {
      errors.push(
        `Unsupported theme version "${String(raw.formatVersion)}". Expected ${THEME_DOC_VERSION}.`,
      );
    }
    if (!isPlainObject(raw.vars)) {
      errors.push('The "vars" field must be an object of CSS custom properties.');
      return { ok: false, errors: limited(errors) };
    }
    varsInput = raw.vars;
    meta.name = raw.name;
    meta.author = raw.author;
    meta.version = raw.version;
  } else {
    // Legacy palette export (the old ThemeImportExport dialog wrote
    // `{ base, accent, ..., label, extra }`). Accept it so an older download
    // still imports, then run the converted tokens through the same checks.
    const legacy = convertLegacyThemeDoc(raw);
    if (legacy) {
      varsInput = legacy.vars;
      meta.name = legacy.name;
    } else {
      // Bare token map. Every key must be a custom property, otherwise the user
      // probably meant the wrapped shape and we say so instead of guessing.
      const keys = Object.keys(raw);
      if (keys.some((key) => !key.startsWith("--"))) {
        return fail('Expected a "vars" object holding CSS custom properties such as "--accent".');
      }
      varsInput = raw;
    }
  }

  const entries = Object.entries(varsInput);
  if (entries.length === 0) {
    errors.push('Theme has no variables. Add at least one token such as "--accent".');
  }
  if (entries.length > MAX_THEME_KEYS) {
    errors.push(`Theme has too many variables (${entries.length}, max ${MAX_THEME_KEYS}).`);
  }

  const unknown: string[] = [];
  const layoutOnly: string[] = [];
  const vars: Record<string, string> = {};

  for (const [key, value] of entries) {
    if (!VAR_KEY_RE.test(key) || !KNOWN_CSS_VARS.has(key)) {
      unknown.push(key);
      continue;
    }
    if (NON_THEME_CSS_VARS.has(key)) {
      layoutOnly.push(key);
      continue;
    }
    if (typeof value !== "string") {
      errors.push(`"${key}" must be a text value.`);
      continue;
    }
    const safe = sanitizeThemeValue(value);
    if (!safe.ok) {
      errors.push(`"${key}" ${safe.error}`);
      continue;
    }
    vars[key] = safe.value;
  }

  if (unknown.length > 0) {
    errors.push(
      `Unknown token(s): ${unknown.join(", ")}. Allowed names are listed under Appearance in Settings.`,
    );
  }
  if (layoutOnly.length > 0) {
    errors.push(`Layout token(s) cannot be themed: ${layoutOnly.join(", ")}.`);
  }
  if (errors.length > 0) return { ok: false, errors: limited(errors) };

  const theme: ImportedTheme = { vars };
  const name = readMeta(meta, "name", errors);
  const author = readMeta(meta, "author", errors);
  const version = readMeta(meta, "version", errors);
  if (errors.length > 0) return { ok: false, errors: limited(errors) };
  if (name) theme.name = name;
  if (author) theme.author = author;
  if (version) theme.version = version;

  return { ok: true, theme };
}

/**
 * Serialize a theme for export or sharing. Keys are sorted so the same theme
 * always produces byte-identical JSON (and a round trip stays stable).
 */
export function serializeThemeDocument(theme: ImportedTheme): string {
  const doc: Record<string, unknown> = {
    format: THEME_DOC_FORMAT,
    formatVersion: THEME_DOC_VERSION,
  };
  if (theme.name) doc.name = theme.name;
  if (theme.author) doc.author = theme.author;
  if (theme.version) doc.version = theme.version;
  const vars: Record<string, string> = {};
  for (const key of Object.keys(theme.vars).sort()) vars[key] = theme.vars[key];
  doc.vars = vars;
  return JSON.stringify(doc, null, 2);
}

/**
 * Map the `ThemeColors` shape used by the built-in palettes onto token names,
 * so an export always describes the theme that is actually on screen.
 */
const COLOR_KEY_TO_VAR: Record<string, string> = {
  base: "--bg-base",
  surface: "--bg-surface",
  elevated: "--bg-elevated",
  hover: "--bg-hover",
  border: "--border",
  primary: "--text-primary",
  secondary: "--text-secondary",
  muted: "--text-muted",
  accent: "--accent",
  "accent-hover": "--accent-hover",
  danger: "--danger",
  success: "--success",
  warning: "--warning",
  "shadow-sm": "--shadow-sm",
  "shadow-md": "--shadow-md",
  "shadow-lg": "--shadow-lg",
  "accent-glow": "--accent-glow",
  "on-gradient": "--on-gradient",
  "chrome-bg": "--chrome-bg",
  "chrome-border": "--chrome-border",
  "chrome-text": "--chrome-text",
  "chrome-text-secondary": "--chrome-text-secondary",
  "chrome-text-muted": "--chrome-text-muted",
};

export function themeColorsToVars(colors: Record<string, unknown>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, cssVar] of Object.entries(COLOR_KEY_TO_VAR)) {
    const value = colors[key];
    if (typeof value === "string" && value.trim()) vars[cssVar] = value.trim();
  }
  return vars;
}

/** UI metadata for a compact preview. Never rendered as HTML. */
export function describeTheme(theme: ImportedTheme, maxSwatches = 6): ThemeDescription {
  const swatches: string[] = [];
  const push = (value?: string) => {
    if (value && swatches.length < maxSwatches) swatches.push(value);
  };

  for (const key of SWATCH_PRIORITY) push(theme.vars[key]);
  for (const [key, value] of Object.entries(theme.vars)) {
    if (SWATCH_PRIORITY.includes(key)) continue;
    if (COLOR_VALUE_RE.test(value)) push(value);
  }

  return {
    name: theme.name ?? "Custom theme",
    author: theme.author,
    version: theme.version,
    count: Object.keys(theme.vars).length,
    swatches,
  };
}

export interface VarChanges {
  /** Tokens to set now, in document order. */
  set: Array<[string, string]>;
  /** Tokens applied earlier that are not part of the next theme. */
  remove: string[];
}

/**
 * Diff the previously applied token set against the next one. Pure, so the
 * "switching back to a built-in theme leaks no token" contract is unit tested
 * without touching the DOM. Unknown names are never applied.
 */
export function computeVarChanges(
  previous: ReadonlySet<string>,
  next: Record<string, string> | undefined,
): VarChanges {
  const set: Array<[string, string]> = [];
  const nextNames = new Set<string>();
  for (const [name, value] of Object.entries(next ?? {})) {
    if (!KNOWN_CSS_VARS.has(name)) continue;
    set.push([name, value]);
    nextNames.add(name);
  }
  const remove: string[] = [];
  for (const name of previous) {
    if (!nextNames.has(name)) remove.push(name);
  }
  return { set, remove };
}
