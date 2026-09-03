import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePwaInstall } from "./use-pwa-install";

function dispatchBeforeInstallPrompt(outcome: "accepted" | "dismissed") {
  const prompt = vi.fn();
  const userChoice = Promise.resolve({ outcome });
  const evt = new Event("beforeinstallprompt", { cancelable: true });
  Object.defineProperty(evt, "preventDefault", { value: vi.fn() });
  Object.defineProperty(evt, "prompt", { value: prompt });
  Object.defineProperty(evt, "userChoice", { value: userChoice });
  window.dispatchEvent(evt);
  return prompt;
}

describe("usePwaInstall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts with canInstall false", () => {
    const { result } = renderHook(() => usePwaInstall());
    expect(result.current.canInstall).toBe(false);
  });

  it("sets canInstall when beforeinstallprompt fires", () => {
    const { result } = renderHook(() => usePwaInstall());
    act(() => {
      dispatchBeforeInstallPrompt("accepted");
    });
    expect(result.current.canInstall).toBe(true);
  });

  it("promptInstall returns true on accepted and clears the prompt", async () => {
    const { result } = renderHook(() => usePwaInstall());
    const prompt = vi.fn();
    const evt = new Event("beforeinstallprompt", { cancelable: true });
    Object.defineProperty(evt, "preventDefault", { value: vi.fn() });
    Object.defineProperty(evt, "prompt", { value: prompt });
    Object.defineProperty(evt, "userChoice", { value: Promise.resolve({ outcome: "accepted" as const }) });
    act(() => {
      window.dispatchEvent(evt);
    });
    let accepted = false;
    await act(async () => {
      accepted = await result.current.promptInstall();
    });
    expect(accepted).toBe(true);
    expect(prompt).toHaveBeenCalled();
    expect(result.current.canInstall).toBe(false);
  });

  it("promptInstall returns false when no prompt is available", async () => {
    const { result } = renderHook(() => usePwaInstall());
    let accepted = true;
    await act(async () => {
      accepted = await result.current.promptInstall();
    });
    expect(accepted).toBe(false);
  });
});
