import { describe, it, expect, afterEach, vi } from "vitest";
import { openMobileIntegrationConnect, handleMobileUrl } from "./capbridge";

afterEach(() => {
  vi.unstubAllGlobals();
});

function nativeCapacitor(open: ReturnType<typeof vi.fn>) {
  return {
    isNativePlatform: () => true,
    Plugins: {
      App: { addListener: async () => undefined },
      Browser: { open },
    },
  };
}

describe("mobile integration connect hand-off", () => {
  it("is a no-op in a plain browser so the normal redirect runs", async () => {
    expect(
      await openMobileIntegrationConnect("github", "https://prysmnote.com/settings?tab=integrations"),
    ).toBe(false);
  });

  it("opens the app settings url with a mobile marker and nonce in the native app", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("Capacitor", nativeCapacitor(open));
    expect(
      await openMobileIntegrationConnect("github", "https://prysmnote.com/settings?tab=integrations"),
    ).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    const url = (open.mock.calls[0][0] as { url: string }).url;
    expect(url).toContain("https://prysmnote.com/settings?tab=integrations");
    expect(url).toContain("redirect=mobile");
    expect(url).toContain("connect=github");
    expect(url).toMatch(/nonce=[A-Za-z0-9_-]+/);
  });

  it("returns to Settings on the matching integration deep link", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("Capacitor", nativeCapacitor(open));
    const location = {
      origin: "https://prysmnote.com",
      href: "https://prysmnote.com/settings?tab=integrations",
    };
    vi.stubGlobal("location", location);
    await openMobileIntegrationConnect("github", "https://prysmnote.com/settings?tab=integrations");
    const url = (open.mock.calls[0][0] as { url: string }).url;
    const nonce = new URL(url).searchParams.get("nonce");
    handleMobileUrl(`com.prysmnote.app://integration/callback?provider=github&nonce=${nonce}`);
    expect(location.href).toBe("https://prysmnote.com/settings?tab=integrations&connected=github");
  });

  it("ignores an integration deep link whose nonce does not match", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("Capacitor", nativeCapacitor(open));
    const location = {
      origin: "https://prysmnote.com",
      href: "https://prysmnote.com/settings?tab=integrations",
    };
    vi.stubGlobal("location", location);
    await openMobileIntegrationConnect("github", "https://prysmnote.com/settings?tab=integrations");
    handleMobileUrl("com.prysmnote.app://integration/callback?provider=github&nonce=wrong");
    expect(location.href).toBe("https://prysmnote.com/settings?tab=integrations");
  });
});
