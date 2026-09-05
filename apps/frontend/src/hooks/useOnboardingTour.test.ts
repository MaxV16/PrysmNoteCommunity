import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useOnboardingTour,
  isNewAccount,
  restartOnboardingTour,
  ONBOARDING_STEPS,
  ONBOARDING_EVENT,
} from "./useOnboardingTour";
import { usePreferencesStore } from "@/stores/preferences-store";
import { PREF_ONBOARDING_DONE } from "@/lib/preferences";

vi.mock("@/lib/preferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/preferences")>();
  return {
    ...actual,
    savePreference: vi.fn().mockResolvedValue(undefined),
  };
});

const mockUser = { id: "u1", email: "a@b.c", display_name: null, email_verified: true, created_at: "" };
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: mockUser, loading: false, logout: vi.fn() }),
}));

function resetState() {
  usePreferencesStore.setState({ prefs: {}, hydrated: true });
}

describe("isNewAccount", () => {
  it("returns true for accounts younger than 30 days", () => {
    expect(isNewAccount(new Date().toISOString())).toBe(true);
  });

  it("returns false for accounts older than 30 days", () => {
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    expect(isNewAccount(old)).toBe(false);
  });

  it("returns false for missing or invalid dates", () => {
    expect(isNewAccount(null)).toBe(false);
    expect(isNewAccount("")).toBe(false);
    expect(isNewAccount("not-a-date")).toBe(false);
  });
});

describe("useOnboardingTour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetState();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("auto-starts for a new account once prefs hydrate", () => {
    mockUser.created_at = new Date().toISOString();
    const { result } = renderHook(() => useOnboardingTour());
    expect(result.current.stepIndex).toBeNull();
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(result.current.stepIndex).toBe(0);
  });

  it("does not auto-start when onboarding_done is set", () => {
    mockUser.created_at = new Date().toISOString();
    usePreferencesStore.setState({ prefs: { [PREF_ONBOARDING_DONE]: true }, hydrated: true });
    const { result } = renderHook(() => useOnboardingTour());
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(result.current.stepIndex).toBeNull();
  });

  it("does not auto-start for accounts older than 30 days", () => {
    mockUser.created_at = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const { result } = renderHook(() => useOnboardingTour());
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(result.current.stepIndex).toBeNull();
  });

  it("restartOnboardingTour opens the tour regardless of account age", () => {
    mockUser.created_at = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const { result } = renderHook(() => useOnboardingTour());
    act(() => {
      restartOnboardingTour();
    });
    expect(result.current.stepIndex).toBe(0);
  });

  it("restart from a route without the tour starts it on the next workspace mount", () => {
    // Settings does not render OnboardingTour, so the restart sets a session
    // flag that the hook consumes when it mounts on the next navigation.
    mockUser.created_at = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    act(() => {
      restartOnboardingTour();
    });
    const { result } = renderHook(() => useOnboardingTour());
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(result.current.stepIndex).toBe(0);
    expect(sessionStorage.getItem("prysm_onboarding_force")).toBeNull();
  });

  it("advances through steps and completes on the last, persisting the pref", () => {
    mockUser.created_at = new Date().toISOString();
    const { result } = renderHook(() => useOnboardingTour());
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(result.current.stepIndex).toBe(0);
    for (let i = 0; i < ONBOARDING_STEPS.length; i++) {
      act(() => {
        result.current.goNext();
      });
    }
    expect(result.current.stepIndex).toBeNull();
    expect(usePreferencesStore.getState().prefs[PREF_ONBOARDING_DONE]).toBe(true);
  });

  it("skip dismisses the tour and records the pref so it does not replay", () => {
    mockUser.created_at = new Date().toISOString();
    const { result } = renderHook(() => useOnboardingTour());
    act(() => {
      vi.advanceTimersByTime(900);
    });
    act(() => {
      result.current.skip();
    });
    expect(result.current.stepIndex).toBeNull();
    expect(usePreferencesStore.getState().prefs[PREF_ONBOARDING_DONE]).toBe(true);
  });

  it("listens for the manual restart event", () => {
    const { result } = renderHook(() => useOnboardingTour());
    act(() => {
      window.dispatchEvent(new Event(ONBOARDING_EVENT));
    });
    expect(result.current.stepIndex).toBe(0);
  });
});