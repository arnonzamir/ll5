import type { NextConfig } from "next";
import { execSync } from "child_process";

let buildId = "dev";
try {
  buildId = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
} catch (err) {
  // Not in a git repo (Docker build) — use env or fallback
  console.debug("[next.config] git rev-parse failed (expected in Docker):", (err as Error).message);
  buildId = process.env.BUILD_ID ?? "unknown";
}

const nextConfig: NextConfig = {
  output: "standalone",
  env: {
    NEXT_PUBLIC_BUILD_ID: buildId,
  },
};

export default nextConfig;
