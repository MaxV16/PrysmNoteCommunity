import type { Metadata, Viewport } from "next";
import "./globals.css";
import { DynamicFontLoader } from "@/lib/dynamic-font-loader";
import { AuthProvider } from "@/lib/auth-context";
import { ThemeProvider } from "@/lib/theme-context";
import { UiScaleProvider } from "@/lib/ui-scale-context";
import { AppearanceProvider } from "@/components/layout/AppearanceProvider";
import { ToastProvider } from "@/lib/toast-context";
import { SubscriptionProvider } from "@/lib/subscription-context";
import { UpdateBanner } from "@/components/ui/UpdateBanner";
import { OfflineBanner } from "@/components/ui/OfflineBanner";
import { CookieBanner } from "@/components/ui/CookieBanner";
import { DesktopTitlebar } from "@/components/desktop/DesktopTitlebar";
import { CapbridgeInit } from "@/components/capbridge/CapbridgeInit";
import { OG_IMAGE } from "@/lib/seo";
import Script from "next/script";

export const metadata: Metadata = {
  metadataBase: new URL("https://prysmnote.com"),
  applicationName: "Prysm Note",
  category: "productivity",
  title: {
    default: "Prysm Note: AI task manager for plans, notes and habits",
    template: "%s | Prysm Note",
  },
  description:
    "Prysm Note turns what you type or say into tasks, a timeline and notes. An AI task manager with calendar, habits, focus and a linked vault. Start free.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/prysm-icon.png", apple: "/icons/apple-touch-icon.png" },
  appleWebApp: {
    capable: true,
    title: "Prysm Note",
    statusBarStyle: "black-translucent",
  },
  openGraph: {
    type: "website",
    siteName: "Prysm Note",
    title: "Prysm Note: AI task manager for plans, notes and habits",
    description:
      "Turn what you type or say into tasks, a timeline and notes. An AI task manager with habits, focus and a linked vault.",
    url: "/",
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: "Prysm Note: AI task manager for plans, notes and habits",
    description:
      "Turn what you type or say into tasks, a timeline and notes. An AI task manager with habits, focus and a linked vault.",
    images: [OG_IMAGE.url],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#12100E",
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
      <body>
        {/*
          These resource hints and the font stylesheet are rendered inside the
          body tree on purpose: React hoists them into <head> on both the server
          and the client. Hand-writing a <head> element here made Next's
          metadata tags and React's hoisted resources disagree between the SSR
          HTML and the hydrating client, which surfaced as "Minified React error
          #418 ... args[]=HTML" on every page load (and a duplicated stylesheet
          link). Keep them in the React tree, not in a literal <head>.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- optional Google Fonts primer for the default UI font */}
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
          precedence="default"
        />
        <DesktopTitlebar />
        <CapbridgeInit />
        <ThemeProvider>
          <UiScaleProvider>
            <AppearanceProvider>
              <DynamicFontLoader />
              <AuthProvider>
                <SubscriptionProvider>
                  <ToastProvider>
                    <OfflineBanner />
                    {children}
                    <UpdateBanner />
                    <CookieBanner />
                  </ToastProvider>
                </SubscriptionProvider>
              </AuthProvider>
            </AppearanceProvider>
          </UiScaleProvider>
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
