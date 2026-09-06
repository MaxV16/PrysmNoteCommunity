import type { Metadata, Viewport } from "next";
import "./globals.css";
import { DynamicFontLoader } from "@/lib/dynamic-font-loader";
import { AuthProvider } from "@/lib/auth-context";
import { ThemeProvider } from "@/lib/theme-context";
import { ToastProvider } from "@/lib/toast-context";
import { SubscriptionProvider } from "@/lib/subscription-context";
import { UpdateBanner } from "@/components/ui/UpdateBanner";
import { CookieBanner } from "@/components/ui/CookieBanner";
import { DesktopTitlebar } from "@/components/desktop/DesktopTitlebar";
import { CapbridgeInit } from "@/components/capbridge/CapbridgeInit";
import Script from "next/script";

export const metadata: Metadata = {
  title: "Prysm Note",
  description: "AI-powered task management",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/prysm-icon.svg", apple: "/icons/apple-touch-icon.png" },
  themeColor: "#6c5ce7",
  appleWebApp: {
    capable: true,
    title: "Prysm Note",
    statusBarStyle: "black-translucent",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#6c5ce7",
};

// Optional Cloudflare Web Analytics beacon (cookieless, traffic-level). Absent
// by default; the human pastes the beacon URL from the CF dashboard into
// NEXT_PUBLIC_CF_ANALYTICS_BEACON (see deploy/development.md). Nothing renders
// when it is unset, so the community build stays tracker-free.
const CF_ANALYTICS_BEACON = process.env.NEXT_PUBLIC_CF_ANALYTICS_BEACON || "";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- optional Google Fonts primer for the default UI font */}
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body>
        <DesktopTitlebar />
        <CapbridgeInit />
        <ThemeProvider>
          <DynamicFontLoader />
          <AuthProvider>
            <SubscriptionProvider>
              <ToastProvider>
                {children}
                <UpdateBanner />
                <CookieBanner />
              </ToastProvider>
            </SubscriptionProvider>
          </AuthProvider>
        </ThemeProvider>
        {CF_ANALYTICS_BEACON ? (
          <Script
            src={CF_ANALYTICS_BEACON}
            strategy="afterInteractive"
          />
        ) : null}
      </body>
    </html>
  );
}
