// Type declarations for the Electron desktop bridge (feature-detected at
// runtime; absent entirely in the browser/PWA, so this never rejects).
interface PrysmDesktopBridge {
  platform: string;
  isDesktop: boolean;
  minimize: () => void;
  maximizeToggle: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizedChanged: (callback: (maximized: boolean) => void) => void;
  /** Windows/Linux only: recolor the native title-bar overlay to match the theme. */
  setTitleBarOverlay?: (options: { color?: string; symbolColor?: string }) => void;
  /** Starts SSO in the system browser (Electron fixes Google's webview block). */
  startSso?: (provider: "google" | "github") => Promise<boolean>;
  /** Starts the passkey ceremony in the system browser (Electron webview limit). */
  startPasskey?: () => Promise<boolean>;
  /** Runs an integration OAuth in the system browser and deep-links back. */
  startIntegrationConnect?: (provider: string, url: string) => Promise<boolean>;
  /** Desktop only: show a real OS notification (task reminders, due alerts). */
  showNotification?: (payload: {
    title: string;
    body?: string;
    silent?: boolean;
  }) => Promise<boolean> | void;
  /**
   * macOS only: triggers the OS microphone consent prompt and resolves true when
   * access is granted. Must be awaited before recording so Electron does not
   * capture a silent track (which transcribes to an empty string).
   */
  requestMicrophoneAccess?: () => Promise<boolean>;
}

interface Window {
  prysmDesktop?: PrysmDesktopBridge;
}