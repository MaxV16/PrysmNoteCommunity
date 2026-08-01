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
  webpack: (config) => {
    if (config.resolve?.alias) {
    }
    return config;
  },
};

export default nextConfig;
