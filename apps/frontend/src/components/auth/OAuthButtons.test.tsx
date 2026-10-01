import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { OAuthButtons } from "./OAuthButtons";

describe("OAuthButtons", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete (window as unknown as { prysmDesktop?: unknown }).prysmDesktop;
  });

  it("renders Continue with Google and GitHub", () => {
    render(<OAuthButtons />);
    expect(screen.getByText("Continue with Google")).toBeTruthy();
    expect(screen.getByText("Continue with GitHub")).toBeTruthy();
  });

  it("redirects to the Google SSO start endpoint on click", async () => {
    const loc = vi.fn();
    Object.defineProperty(window, "location", {
      writable: true,
      value: { href: "" },
    });
    render(<OAuthButtons />);
    fireEvent.click(screen.getByText("Continue with Google"));
    await waitFor(() => {
      expect(window.location.href).toContain("/auth/oauth/google/start");
    });
  });

  it("redirects to the GitHub SSO start endpoint on click", async () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: { href: "" },
    });
    render(<OAuthButtons />);
    fireEvent.click(screen.getByText("Continue with GitHub"));
    await waitFor(() => {
      expect(window.location.href).toContain("/auth/oauth/github/start");
    });
  });

  it("delegates to the Electron bridge (system browser) instead of redirecting", async () => {
    const startSso = vi.fn().mockResolvedValue(true);
    (window as unknown as { prysmDesktop?: unknown }).prysmDesktop = {
      platform: "darwin",
      isDesktop: true,
      startSso,
    };
    Object.defineProperty(window, "location", {
      writable: true,
      value: { href: "unchanged" },
    });
    render(<OAuthButtons />);
    fireEvent.click(screen.getByText("Continue with Google"));
    await waitFor(() => {
      expect(startSso).toHaveBeenCalledWith("google");
    });
    // The desktop flow must not also fire the in-window redirect (Google blocks it).
    expect(window.location.href).toBe("unchanged");
  });
});
