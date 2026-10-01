// The timeline section column has two states: expanded (full labels with a
// collapse chevron) and rail (color dot + chevron + count with an expand
// chevron). It is persisted as `prysm_timeline_sections_rail`; the older
// `prysm_timeline_sections_hidden` key is still read so anyone who had fully
// hidden the column is migrated onto the rail instead of being stranded.
export type TimelineSectionsMode = "expanded" | "rail";

export const SECTIONS_HIDDEN_KEY = "prysm_timeline_sections_hidden";
export const SECTIONS_RAIL_KEY = "prysm_timeline_sections_rail";

export interface SectionsPrefs {
  hidden: boolean;
  rail: boolean;
}

/** Derive the mode from the persisted booleans (a legacy hidden becomes rail). */
export function sectionsModeFromPrefs(prefs: SectionsPrefs): TimelineSectionsMode {
  return prefs.rail || prefs.hidden ? "rail" : "expanded";
}

/** Inverse of `sectionsModeFromPrefs`; hidden is kept false to clear legacy rows. */
export function sectionsPrefsFromMode(mode: TimelineSectionsMode): SectionsPrefs {
  return { hidden: false, rail: mode === "rail" };
}

/**
 * Persist a mode. `hidden` is always written as "0" so a legacy fully-hidden
 * preference is cleared. Missing/unavailable storage is ignored so the
 * in-memory choice still applies.
 */
export function persistSectionsMode(
  mode: TimelineSectionsMode,
  storage?: Pick<Storage, "setItem">,
): void {
  let target = storage;
  if (!target) {
    try {
      target = window.localStorage;
    } catch {
      return;
    }
  }
  if (!target) return;
  const prefs = sectionsPrefsFromMode(mode);
  try {
    target.setItem(SECTIONS_HIDDEN_KEY, prefs.hidden ? "1" : "0");
    target.setItem(SECTIONS_RAIL_KEY, prefs.rail ? "1" : "0");
  } catch {
    /* storage unavailable: keep the in-memory choice */
  }
}

/**
 * Resolve the initial mode from storage. Falls back to the slim rail on a
 * phone (read from matchMedia directly, since `smallScreen` is still false on
 * the first render and would cause a flash/jump).
 */
export function resolveInitialSectionsMode(storage?: Pick<Storage, "getItem">): TimelineSectionsMode {
  let target = storage;
  if (!target) {
    try {
      target = window.localStorage;
    } catch {
      target = undefined;
    }
  }
  let storedHidden: string | null = null;
  let storedRail: string | null = null;
  if (target) {
    try {
      storedHidden = target.getItem(SECTIONS_HIDDEN_KEY);
      storedRail = target.getItem(SECTIONS_RAIL_KEY);
    } catch {
      /* storage unavailable */
    }
  }
  let railDefault = false;
  try {
    railDefault = window.matchMedia("(max-width: 767px)").matches;
  } catch {
    /* matchMedia unavailable */
  }
  return sectionsModeFromPrefs({
    hidden: storedHidden === "1",
    rail: storedRail !== null ? storedRail === "1" : railDefault,
  });
}
