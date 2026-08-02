"use client";

import { useSyncExternalStore } from "react";

export const MODULE_IDS = [
  "sidebar",
  "aiPanel",
  "stickyNotes",
  "navSection",
  "filterBar",
  "tagList",
  "teamSection",
  "themeSelector",
  "viewTimeline",
  "viewKanban",
  "viewCalendar",
  "viewList",
  "voice",
  "habits",
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];

export type UiModuleState = Record<ModuleId, boolean>;

const ALL_ON = Object.fromEntries(MODULE_IDS.map((id) => [id, true])) as UiModuleState;

let state: UiModuleState = { ...ALL_ON };

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getUiModules(): UiModuleState {
  return { ...state };
}

export function setModuleState(id: ModuleId, value: boolean): void {
  if (state[id] === value) return;
  state = { ...state, [id]: value };
  emit();
}

export function setModuleStates(overrides: Partial<UiModuleState>): void {
  let changed = false;
  const next: UiModuleState = { ...state };
  for (const [id, value] of Object.entries(overrides) as [ModuleId, boolean][]) {
    if (next[id] !== value) {
      next[id] = value;
      changed = true;
    }
  }
  if (!changed) return;
  state = next;
  emit();
}

export function resetUiModules(): void {
  state = { ...ALL_ON };
  emit();
}

export function subscribeToUiModules(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useUiModule(id: ModuleId): boolean {
  return useSyncExternalStore(
    subscribeToUiModules,
    () => state[id] ?? true,
    () => true,
  );
}
