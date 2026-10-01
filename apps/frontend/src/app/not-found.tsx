import type { Metadata } from "next";
import { NotFoundView } from "@/components/ui/NotFoundView";

export const metadata: Metadata = {
  title: "Page not found - Prysm Note",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return <NotFoundView />;
}
