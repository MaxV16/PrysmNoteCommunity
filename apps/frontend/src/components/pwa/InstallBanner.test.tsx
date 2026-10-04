import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { InstallBanner } from "./InstallBanner";

const hook = vi.hoisted(() => ({
  canInstall: true,
  isStandalone: false,
  promptInstall: vi.fn(async () => true),
}));

const browser = vi.hoisted(() => ({ os: "android", native: true }));

vi.mock("@/hooks/use-pwa-install", () => ({
  usePwaInstall: () => ({
    canInstall: hook.canInstall,
    promptInstall: hook.promptInstall,
    isStandalone: hook.isStandalone,
  }),
}));

vi.mock("@/lib/browser", () => ({
  BROWSER_LABEL: { chrome: "Chrome" },
  detectOS: () => browser.os,
  detectBrowser: () => "chrome",
  installGuide: () => ({ title: "Install steps", steps: ["Step one"] }),
  supportsNativePrompt: () => browser.native,
}));

describe("InstallBanner", () => {
  beforeEach(() => {
    cleanup();
    window.localStorage.clear();
    hook.canInstall = true;
    hook.isStandalone = false;
    browser.os = "android";
    browser.native = true;
  });

  it("shows the install prompt when an install is available", () => {
    render(<InstallBanner />);
    expect(screen.getByText("Install Prysm Note on this device for quick access.")).toBeTruthy();
  });

  it("does not show when no install is available", () => {
    hook.canInstall = false;
    browser.os = "desktop";
    browser.native = false;
    render(<InstallBanner />);
    expect(screen.queryByText(/Install Prysm Note/)).toBeNull();
  });

  it("remembers that it was shown so it does not nag again", () => {
    render(<InstallBanner />);
    expect(screen.getByText("Install Prysm Note on this device for quick access.")).toBeTruthy();
    expect(window.localStorage.getItem("prysm_pwa_install_seen")).toBe("1");

    cleanup();
    render(<InstallBanner />);
    expect(screen.queryByText(/Install Prysm Note/)).toBeNull();
  });

  it("persists dismissal", () => {
    render(<InstallBanner />);
    fireEvent.click(screen.getByLabelText("Dismiss install prompt"));
    expect(window.localStorage.getItem("prysm_pwa_install_seen")).toBe("1");
  });

  it("still opens the guide for an explicit ?install=1 request after being shown before", () => {
    window.localStorage.setItem("prysm_pwa_install_seen", "1");
    render(<InstallBanner autoOpenGuide />);
    expect(screen.getByText("Install steps")).toBeTruthy();
  });
});
