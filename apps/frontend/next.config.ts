import path from "path";
import fs from "fs";
import type { NextConfig } from "next";


const nextConfig: NextConfig = {
  output: "standalone",
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
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              // Cloudflare Web Analytics beacon (static.cloudflareinsights.com)
              // is loaded as an afterInteractive script when
              // NEXT_PUBLIC_CF_ANALYTICS_BEACON is set.
              "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com" +
                (isProd ? "" : " 'unsafe-eval'"),
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              // TMDB hosts: posters/search thumbs/provider logos (image.tmdb.org)
              // + the TMDB attribution logo in the watchlist footer
              // (www.themoviedb.org).
              "img-src 'self' data: blob: https://image.tmdb.org https://www.themoviedb.org",
              "font-src 'self' https://fonts.gstatic.com data:",
              // Browser-side LLM calls go straight to the provider APIs, and the
              // Google Fonts stylesheet is loaded from its CDN. The google.com hosts
              // are required by the browser Web Speech API (SpeechRecognition) for
              // speech-to-text - not by app code - so keep them explicit, no wildcards.
              // Chrome has used https://speech.google.com and wss://www.google.com
              // across versions in addition to www.google.com / speech.googleapis.com.
              // cloudflareinsights.com serves the Web Analytics beacon's beacons
              // (sendBeacon -> https://cloudflareinsights.com/cdn-cgi/rum) once the
              // static.cloudflareinsights.com script is allowed above.
              "connect-src 'self' https://api.openai.com https://generativelanguage.googleapis.com https://api.deepseek.com https://openrouter.ai https://fonts.googleapis.com https://www.google.com https://speech.google.com https://speech.googleapis.com wss://www.google.com https://cloudflareinsights.com" +
                (isProd ? "" : " http://localhost:8000"),
              // Behind Cloudflare's proxy the page origin is always https, but if
              // nginx ever serves plain http (e.g. trailing-slash 307 redirects
              // from a mis-trusted X-Forwarded-Proto), upgrade any subresource
              // request to https - mirrors the backend middleware harden.
              ...(isProd ? ["upgrade-insecure-requests"] : []),
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
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

export default nextConfig;
