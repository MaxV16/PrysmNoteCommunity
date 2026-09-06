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
}

interface Window {
  prysmDesktop?: PrysmDesktopBridge;
}