"use client";
import { useOnlineStatus } from "@/lib/use-online-status";

export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div className="sticky top-0 z-50 flex items-center justify-center bg-warning/15 px-4 py-2 text-xs font-medium text-warning border-b border-warning/30">
      You are offline. Some features may be unavailable.
    </div>
  );
}
