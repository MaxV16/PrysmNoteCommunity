import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CookieBanner } from "./CookieBanner";

const CONSENT_KEY = "prysm_cookie_consent";

describe("CookieBanner", () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = "";
  });

  it("renders the notice when no consent is stored", () => {
    render(<CookieBanner />);
    expect(
      screen.getByText(/We use only essential cookies to keep you signed in and secure/)
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Got it" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Cookie Policy" })).toBeInTheDocument();
  });

  it("does not render when consent was already given", () => {
    localStorage.setItem(CONSENT_KEY, JSON.stringify({ v: 1, ts: Date.now() }));
    render(<CookieBanner />);
    expect(screen.queryByText(/essential cookies/)).not.toBeInTheDocument();
  });

  it("persists dismissal in localStorage on Got it and hides", () => {
    render(<CookieBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText(/essential cookies/)).not.toBeInTheDocument();
    const stored = localStorage.getItem(CONSENT_KEY);
    expect(stored).toBeTruthy();
    const parsed = JSON.parse(stored!);
    expect(parsed.v).toBe(1);
    expect(typeof parsed.ts).toBe("number");
  });

  it("never sets a cookie", () => {
    render(<CookieBanner />);
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(document.cookie).toBe("");
  });
});
