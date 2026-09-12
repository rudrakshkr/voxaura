import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root so a stray lockfile in $HOME doesn't confuse tracing.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
