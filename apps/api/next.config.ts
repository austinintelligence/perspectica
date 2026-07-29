import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  transpilePackages: [
    "@perspectica/analysis",
    "@perspectica/compass",
    "@perspectica/contracts",
    "@perspectica/storage",
    "@perspectica/validation",
  ],
};

export default nextConfig;
