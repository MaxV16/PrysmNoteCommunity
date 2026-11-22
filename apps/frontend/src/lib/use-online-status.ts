"use client";
import { useState, useEffect } from "react";

/**
 * Read the browser's connectivity flag, treating "unknown" as online.
 *
 * `navigator.onLine` only exists in a real browser. Node 22 (which renders the
 * server HTML) defines a global `navigator` without `onLine`, so a bare
 * `typeof navigator !== "undefined"` check is true during SSR and
 * `navigator.onLine` is `undefined` - falsy, which used to render the offline
 * banner into every server-rendered page and made hydration mismatch on every
 * load (React error #418). An unknown flag must mean "online": the server and
 * the first client render then agree, and the real value arrives from the
 * `online` / `offline` events after mount.
 */
function readOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return typeof navigator.onLine === "boolean" ? navigator.onLine : true;
}

export function useOnlineStatus() {
  const [online, setOnline] = useState<boolean>(readOnline);
  useEffect(() => {
    setOnline(readOnline());
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  return online;
}
