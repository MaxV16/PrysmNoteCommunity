import path from "path";
import fs from "fs";
import type { NextConfig } from "next";


const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
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
              "img-src 'self' data: blob:",
              "font-src 'self' https://fonts.gstatic.com data:",
              // Browser-side LLM calls go straight to the provider APIs, and the
              // Google Fonts stylesheet is loaded from its CDN.
              "connect-src 'self' https://api.openai.com https://generativelanguage.googleapis.com https://api.deepseek.com https://openrouter.ai https://fonts.googleapis.com" +
                (isProd ? "" : " http://localhost:8000"),
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          ...(isProd
            ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
            : []),
        ],
      },
    ];
  },
  webpack: (config) => {
    if (config.resolve?.alias) {
    }
    return config;
  },
};

export default nextConfig;
