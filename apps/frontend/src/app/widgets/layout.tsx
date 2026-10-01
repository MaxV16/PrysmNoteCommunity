import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Widgets",
  robots: { index: false, follow: false },
};

export default function WidgetsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
