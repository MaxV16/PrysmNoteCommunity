import { describe, it, expect, beforeEach } from "vitest";
import {
  MODULE_IDS,
  getUiModules,
  setModuleState,
  setModuleStates,
  resetUiModules,
  subscribeToUiModules,
} from "./ui-module-registry";

describe("ui-module-registry", () => {
  beforeEach(() => {
    resetUiModules();
  });

  it("defaults every module to on", () => {
    expect(MODULE_IDS.length).toBeGreaterThan(0);
    for (const id of MODULE_IDS) {
      expect(getUiModules()[id]).toBe(true);
    }
  });

  it("turns a single module off and back on", () => {
    setModuleState("sidebar", false);
    expect(getUiModules().sidebar).toBe(false);
    setModuleState("sidebar", true);
    expect(getUiModules().sidebar).toBe(true);
  });

  it("applies multiple overrides at once", () => {
    setModuleStates({ aiPanel: false, viewKanban: false });
    expect(getUiModules().aiPanel).toBe(false);
    expect(getUiModules().viewKanban).toBe(false);
    expect(getUiModules().sidebar).toBe(true);
  });

  it("returns a copy so callers cannot mutate internal state", () => {
    const before = getUiModules();
    before.sidebar = false;
    expect(getUiModules().sidebar).toBe(true);
  });

  it("skips no-op updates and does not notify subscribers when nothing changes", () => {
    let notifications = 0;
    const unsubscribe = subscribeToUiModules(() => notifications++);
    expect(notifications).toBe(0);

    setModuleState("sidebar", true); // already true
    expect(notifications).toBe(0);

    unsubscribe();
  });

  it("notifies subscribers on change and honors unsubscription", () => {
    let notifications = 0;
    const unsubscribe = subscribeToUiModules(() => notifications++);

    setModuleState("sidebar", false);
    expect(notifications).toBe(1);

    unsubscribe();
    setModuleState("sidebar", true);
    expect(notifications).toBe(1);
  });
});
