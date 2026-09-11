import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useGlobalShortcuts } from "./useGlobalShortcuts";
import { useAppStore } from "@/stores/app-store";

vi.mock("@/hooks/useBatchDelete", () => ({
  useBatchDelete: () => ({
    busy: false,
    softDeleteWithUndo: vi.fn().mockResolvedValue(false),
  }),
}));

vi.mock("@/lib/toast-context", () => ({
  useToast: () => ({ showToast: vi.fn() }),
}));

describe("useGlobalShortcuts Ctrl+F handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAppStore.getState().reset();
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  function fireCtrlF() {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", ctrlKey: true, cancelable: true })
    );
  }

  it("lets the native browser find run when there is no in-app search input", () => {
    const preventSpy = vi.spyOn(KeyboardEvent.prototype, "preventDefault");
    renderHook(() => useGlobalShortcuts({}));
    act(() => fireCtrlF());
    expect(preventSpy).not.toHaveBeenCalled();
    preventSpy.mockRestore();
  });

  it("intercepts Ctrl+F and focuses the in-app search when it exists", () => {
    document.body.innerHTML = '<input id="global-search" />';
    const preventSpy = vi.spyOn(KeyboardEvent.prototype, "preventDefault");

    renderHook(() => useGlobalShortcuts({}));
    act(() => fireCtrlF());

    expect(preventSpy).toHaveBeenCalled();
    preventSpy.mockRestore();
  });
});