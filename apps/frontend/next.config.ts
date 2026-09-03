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
              "script-src 'self' 'unsafe-inline'" + (isProd ? "" : " 'unsafe-eval'"),
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
              "connect-src 'self' https://api.openai.com https://generativelanguage.googleapis.com https://api.deepseek.com https://openrouter.ai https://fonts.googleapis.com https://www.google.com https://speech.google.com https://speech.googleapis.com wss://www.google.com" +
                (isProd ? "" : " http://localhost:8000"),
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
