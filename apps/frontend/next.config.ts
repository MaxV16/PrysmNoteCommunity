import path from "path";
import fs from "fs";
import type { NextConfig } from "next";

function findEeDir(): string {
  const cwd = process.cwd();
  const localPath = path.resolve(cwd, "..", "..", "ee", "apps", "frontend", "ee");
  const srcEePath = path.resolve(cwd, "src", "ee");
  const eePath = path.resolve(cwd, "ee");

  if (fs.existsSync(path.join(localPath, "components"))) return localPath;
  if (fs.existsSync(path.join(srcEePath, "components"))) return srcEePath;
  if (fs.existsSync(path.join(eePath, "components"))) return eePath;
  return localPath;
}

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
      config.resolve.alias["@/ee"] = findEeDir();
    }
    return config;
  },
};

export default nextConfig;
