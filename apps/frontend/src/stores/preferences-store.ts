import { create } from "zustand";
import {
  loadPreferencesFromServer,
  savePreference,
} from "@/lib/preferences";

interface PreferencesState {
  prefs: Record<string, unknown>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setPreference: (key: string, value: unknown) => void;
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  prefs: {},
  hydrated: false,

  hydrate: async () => {
    const server = await loadPreferencesFromServer();
    set({ prefs: server, hydrated: true });
  },

  setPreference: (key, value) => {
    const prev = get().prefs;
    const prevValue = prev[key];
    // Optimistic local update; the server round-trip happens in the background.
    set({ prefs: { ...prev, [key]: value } });
    void savePreference(key, value).catch(() => {
      // Roll back on failure so the UI never shows an unsaved pref as saved.
      const current = get().prefs;
      if (prevValue === undefined) {
        const { [key]: _removed, ...rest } = current;
        set({ prefs: rest });
      } else {
        set({ prefs: { ...current, [key]: prevValue } });
      }
    });
  },
}));
