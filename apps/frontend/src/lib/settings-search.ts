/**
 * Setting search index.
 *
 * Deliberately a plain array of strings, not a library: the whole index is a
 * few kilobytes, it is built once at module load, and a keystroke costs one
 * `indexOf` per entry. No fuzzy matching, no dependency, no worker. Since the
 * index is static there is nothing to invalidate and nothing to fetch.
 *
 * `keys` is the "smart" part: the words a person actually types for that
 * setting (synonyms, products, and the odd misspelling-free abbreviation) so
 * "alerts" finds Notifications and "byok" finds the provider keys.
 */

export type SettingsTabId =
  | "account"
  | "premium"
  | "features"
  | "appearance"
  | "preferences"
  | "integrations"
  | "widgets"
  | "vault"
  | "advanced";

export interface SettingsEntry {
  /** Destination tab. */
  tab: SettingsTabId;
  /** What the person is looking for, in their words. */
  title: string;
  /** Where it lives, shown under the title. */
  hint: string;
  /** Extra search words, never shown. */
  keys: string;
}

const ENTRIES: SettingsEntry[] = [
  // Account
  { tab: "account", title: "Display name", hint: "Account", keys: "profile name user rename" },
  { tab: "account", title: "Email address", hint: "Account", keys: "login account mail change" },
  { tab: "account", title: "Change password", hint: "Account > Security", keys: "reset password credentials sign in" },
  { tab: "account", title: "Sign out", hint: "Settings sidebar", keys: "logout log out exit session" },
  { tab: "account", title: "Onboarding tour", hint: "Account > Help", keys: "tour guide walkthrough replay help" },

  // Premium
  { tab: "premium", title: "Plan and billing", hint: "Premium", keys: "subscription upgrade downgrade invoice receipt billing stripe price plan team company" },
  { tab: "premium", title: "Trial and AI mode", hint: "Premium", keys: "trial free premium prysmai ai mode tokens usage" },

  // Features
  { tab: "features", title: "Calendar view", hint: "Features", keys: "timeline calendar month view module toggle" },
  { tab: "features", title: "Kanban board", hint: "Features", keys: "kanban board columns status drag module toggle" },
  { tab: "features", title: "Habits", hint: "Features", keys: "habit tracker streak daily module toggle" },
  { tab: "features", title: "Voice dictation", hint: "Features", keys: "voice speech dictation microphone transcribe module toggle" },
  { tab: "features", title: "Smart lists", hint: "Features", keys: "today next 7 days all tasks completed sidebar smart list show hide" },
  { tab: "features", title: "Sidebar modules", hint: "Features", keys: "sidebar modules hide show timeline vault watchlist finance focus countdown quadrant sticky notes" },

  // Appearance
  { tab: "appearance", title: "Task style", hint: "Appearance", keys: "task card shape soft outline glass style board list timeline look" },
  { tab: "appearance", title: "Glass mode", hint: "Appearance", keys: "glass translucent transparent frosted panels blur background" },
  { tab: "appearance", title: "Board background", hint: "Appearance", keys: "board kanban background preset aurora mesh dots grid sunset ocean forest custom image wallpaper" },
  { tab: "appearance", title: "Countdown background", hint: "Appearance", keys: "countdown timer background preset wallpaper custom image" },
  { tab: "appearance", title: "Import or export appearance", hint: "Appearance", keys: "appearance json import export share style config theme look" },

  // Preferences
  { tab: "preferences", title: "Notifications", hint: "Preferences", keys: "alerts desktop browser push system notification reminders permission" },
  { tab: "preferences", title: "Reminder time", hint: "Preferences > Notifications", keys: "reminder default time in app alert" },
  { tab: "preferences", title: "Email reminders", hint: "Preferences > Notifications", keys: "email reminders due alerts digest daily summary mail" },
  { tab: "preferences", title: "Sound alerts", hint: "Preferences > Notifications", keys: "sound ping audio notification noise" },
  { tab: "preferences", title: "Completion animations", hint: "Preferences > Notifications", keys: "confetti celebration animation reward" },
  { tab: "preferences", title: "Week starts on", hint: "Preferences > Date and time", keys: "week start monday sunday calendar locale" },
  { tab: "preferences", title: "Time format", hint: "Preferences > Date and time", keys: "time 12 hour 24 hour clock format" },
  { tab: "preferences", title: "Date format", hint: "Preferences > Date and time", keys: "date format dd mm yyyy locale regional" },
  { tab: "preferences", title: "Timezone", hint: "Preferences > Date and time", keys: "timezone time zone utc gmt local region device" },
  { tab: "preferences", title: "Theme", hint: "Preferences > Appearance", keys: "theme dark light color scheme appearance night mode tokyo coffee slate solarized github" },
  { tab: "preferences", title: "Accent color", hint: "Preferences > Appearance", keys: "accent color highlight brand palette" },
  { tab: "preferences", title: "Custom theme tokens", hint: "Preferences > Appearance", keys: "custom theme import export tokens css json" },
  { tab: "preferences", title: "Font family", hint: "Preferences > Appearance", keys: "font typeface typography family serif sans mono" },
  { tab: "preferences", title: "Background", hint: "Preferences > Appearance", keys: "background image texture pattern wallpaper" },
  { tab: "preferences", title: "Interface size", hint: "Preferences > Appearance", keys: "interface size scale zoom density ui" },
  { tab: "preferences", title: "Font size", hint: "Preferences > Appearance", keys: "font size text bigger smaller readability" },

  // Integrations
  { tab: "integrations", title: "Google Calendar", hint: "Integrations", keys: "google calendar connect sync events import gcal" },
  { tab: "integrations", title: "GitHub", hint: "Integrations", keys: "github repos issues pull requests connect sync developer" },
  { tab: "integrations", title: "Slack", hint: "Integrations", keys: "slack messages channel digest connect team chat" },
  { tab: "integrations", title: "AI Connect (MCP)", hint: "Integrations", keys: "mcp claude cursor vscode kilo ai connect personal access token pat client tools" },
  { tab: "integrations", title: "Finance settings", hint: "Integrations", keys: "finance money budget currency ledger payments debts income expense" },
  { tab: "integrations", title: "Siri shortcuts", hint: "Integrations", keys: "siri shortcut apple ios voice assistant" },
  { tab: "integrations", title: "Teams and collaboration", hint: "Integrations > Collaborate", keys: "team company collaborate members invite share projects plan seats" },

  // Widgets
  { tab: "widgets", title: "Desktop widgets", hint: "Widgets", keys: "widget floating window dashboard sticky desktop always on top" },
  { tab: "widgets", title: "Widget cards", hint: "Widgets", keys: "calendar mini view task counter habit progress widget cards" },

  // Vault
  { tab: "vault", title: "Vault overview", hint: "Vault", keys: "vault notes notebook stats links count" },
  { tab: "vault", title: "Semantic search", hint: "Vault", keys: "semantic search embeddings meaning ai search vector similarity notes" },
  { tab: "vault", title: "Search modes", hint: "Vault", keys: "text search semantic search mode toggle literal exact words" },
  { tab: "vault", title: "Vault export and import", hint: "Vault", keys: "vault export import backup json notes archive" },
  { tab: "vault", title: "Wikilinks and backlinks", hint: "Vault", keys: "wikilink backlink link notes graph references" },

  // Advanced
  { tab: "advanced", title: "AI provider keys", hint: "Advanced", keys: "api key byok openai gemini deepseek openrouter token provider model" },
  { tab: "advanced", title: "Keyboard shortcuts", hint: "Advanced", keys: "shortcut hotkey keybinding keys reference" },
  { tab: "advanced", title: "Export all data", hint: "Advanced", keys: "export backup download json data" },
  { tab: "advanced", title: "Import data", hint: "Advanced", keys: "import restore backup json csv ics upload" },
  { tab: "advanced", title: "Clear AI chat cache", hint: "Advanced > More", keys: "cache clear reset ai chat history storage" },
  { tab: "advanced", title: "Debug information", hint: "Advanced > More", keys: "debug version build environment api url about" },
  { tab: "advanced", title: "Delete account", hint: "Advanced > Danger zone", keys: "danger zone delete account remove data irreversible" },
];

interface IndexedEntry {
  entry: SettingsEntry;
  title: string;
  haystack: string;
}

const INDEX: IndexedEntry[] = ENTRIES.map((entry) => ({
  entry,
  title: entry.title.toLowerCase(),
  haystack: `${entry.title} ${entry.hint} ${entry.keys}`.toLowerCase(),
}));

/**
 * Rank entries for a query. Every token must appear somewhere, so a second word
 * narrows instead of widening. Matching in the title outranks a keyword hit,
 * which outranks the destination hint.
 */
export function searchSettings(query: string, limit = 8): SettingsEntry[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const scored: { entry: SettingsEntry; score: number }[] = [];
  for (const item of INDEX) {
    let score = 0;
    let matchedAll = true;
    for (const token of tokens) {
      const inTitle = item.title.indexOf(token);
      const inHaystack = item.haystack.indexOf(token);
      if (inHaystack === -1) {
        matchedAll = false;
        break;
      }
      if (inTitle !== -1) {
        score += inTitle === 0 || item.title[inTitle - 1] === " " ? 6 : 4;
      } else {
        score += 2;
      }
    }
    if (!matchedAll) continue;
    // A whole-query title hit beats a scatter of keyword hits.
    if (item.title.indexOf(tokens.join(" ")) !== -1) score += 5;
    scored.push({ entry: item.entry, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((hit) => hit.entry);
}

/** Total number of indexed settings, used by the empty state copy. */
export const SETTINGS_ENTRY_COUNT = ENTRIES.length;
