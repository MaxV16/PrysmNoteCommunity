import type { Metadata } from "next";
import { NotFoundView } from "@/components/ui/NotFoundView";

export const metadata: Metadata = {
  // The root layout template appends " | Prysm Note", so the segment title must
  // not repeat the brand name (that produced "Page not found - Prysm Note |
  // Prysm Note").
  title: "Page not found",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return <NotFoundView />;
}
