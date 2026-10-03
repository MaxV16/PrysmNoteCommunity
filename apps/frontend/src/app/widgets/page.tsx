"use client";

import Link from "next/link";
import { WidgetDashboard } from "@/components/widgets/WidgetDashboard";

export default function WidgetsPage() {
  return (
    <div className="min-h-dvh bg-base p-4" style={{ fontFamily: "var(--font-ui)" }}>
      <div className="max-w-sm mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-bold text-primary">Prysm Widgets</h1>
          <Link href="/" className="text-xs text-accent hover:underline">Open Main App</Link>
        </div>
        <WidgetDashboard />
      </div>
    </div>
  );
}
