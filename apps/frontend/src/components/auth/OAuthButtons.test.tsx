import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OAuthButtons } from "./OAuthButtons";

describe("OAuthButtons", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders Continue with Google and GitHub", () => {
    render(<OAuthButtons />);
    expect(screen.getByText("Continue with Google")).toBeTruthy();
    expect(screen.getByText("Continue with GitHub")).toBeTruthy();
  });

  it("redirects to the Google SSO start endpoint on click", () => {
    const loc = vi.fn();
    Object.defineProperty(window, "location", {
      writable: true,
      value: { href: "" },
    });
    render(<OAuthButtons />);
    fireEvent.click(screen.getByText("Continue with Google"));
    expect(window.location.href).toContain("/auth/oauth/google/start");
  });

  it("redirects to the GitHub SSO start endpoint on click", () => {
    Object.defineProperty(window, "location", {
      writable: true,
      value: { href: "" },
    });
    render(<OAuthButtons />);
    fireEvent.click(screen.getByText("Continue with GitHub"));
    expect(window.location.href).toContain("/auth/oauth/github/start");
  });
});
