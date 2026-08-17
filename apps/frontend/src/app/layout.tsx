import type { Metadata } from "next";
import "./globals.css";
import { DynamicFontLoader } from "@/lib/dynamic-font-loader";
import { AuthProvider } from "@/lib/auth-context";
import { ThemeProvider } from "@/lib/theme-context";
import { ToastProvider } from "@/lib/toast-context";
import { SubscriptionProvider } from "@/lib/subscription-context";
import { UpdateBanner } from "@/components/ui/UpdateBanner";

export const metadata: Metadata = {
  title: "Prysm Note",
  description: "AI-powered task management",
};

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
        <ThemeProvider>
          <DynamicFontLoader />
          <AuthProvider>
            <SubscriptionProvider>
              <ToastProvider>
                {children}
                <UpdateBanner />
              </ToastProvider>
            </SubscriptionProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
