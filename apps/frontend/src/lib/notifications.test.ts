import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

import { showSystemNotification, notificationsSupported } from "./notifications";

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static requestPermission = vi.fn().mockResolvedValue("granted");
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {}
}

function setServiceWorker(value: unknown) {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value,
  });
}

describe("notifications", () => {
  beforeEach(() => {
    vi.stubGlobal("Notification", FakeNotification);
    FakeNotification.permission = "granted";
    FakeNotification.requestPermission.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setServiceWorker(undefined);
  });

  it("reports support when the Notification API exists", () => {
    expect(notificationsSupported()).toBe(true);
  });

  it("prefers the service worker registration so Android Chrome and Brave can show it", async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined);
    setServiceWorker({ getRegistration: vi.fn().mockResolvedValue({ showNotification }) });

    const ok = await showSystemNotification("Title", "Body");

    expect(ok).toBe(true);
    expect(showNotification).toHaveBeenCalledWith("Title", {
      body: "Body",
      tag: "prysm-reminder",
    });
  });

  it("falls back to the Notification constructor when no registration is available", async () => {
    setServiceWorker({ getRegistration: vi.fn().mockResolvedValue(undefined) });

    const ok = await showSystemNotification("Title", "Body");

    expect(ok).toBe(true);
  });

  it("does not deliver without granted permission", async () => {
    FakeNotification.permission = "default";
    const showNotification = vi.fn().mockResolvedValue(undefined);
    setServiceWorker({ getRegistration: vi.fn().mockResolvedValue({ showNotification }) });

    const ok = await showSystemNotification("Title", "Body");

    expect(ok).toBe(false);
    expect(showNotification).not.toHaveBeenCalled();
  });
});
