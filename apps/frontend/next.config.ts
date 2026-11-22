import path from "path";
import fs from "fs";
import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";


const nextConfig: NextConfig = {
  output: "standalone",
  // The framework version is not useful to clients and only helps fingerprint
  // the stack, so do not advertise it.
  poweredByHeader: false,
  // Serve future raster content as modern formats first. Icons deliberately
  // stay PNG (favicon/apple-touch/PWA): WebP is not a valid <link rel="icon">
  // for every browser.
  images: {
    formats: ["image/avif", "image/webp"],
  },
  // Strict type/ESLint checks on production builds (CI + deploy), so a TS or
  // lint error fails the build instead of shipping. Local `next dev` keeps the
  // lenient settings for fast iteration (M5).
  typescript: {
    ignoreBuildErrors: process.env.NODE_ENV !== "production",
  },
  eslint: {
    ignoreDuringBuilds: process.env.NODE_ENV !== "production",
  },
  async headers() {
    const isProd = process.env.NODE_ENV === "production";
    return [
      {
        source: "/(.*)",
        headers: [
          // The Content-Security-Policy is NOT set here: it needs a per-request
          // script nonce, so `src/middleware.ts` issues it (and setting it in
          // both places would send two policies, which browsers intersect).
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
          ...(isProd
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
            : []),
        ],
      },
    ];
  },
};

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

export default withBundleAnalyzer(nextConfig);
