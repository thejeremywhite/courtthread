import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // "standalone" emits a self-contained server (.next/standalone) carrying only the traced
  // node_modules — this is what make-portable.bat packages for the thumb-drive build.
  // Harmless to normal `next dev` / `next start`.
  output: "standalone",
  // Pin the tracing root to the project: without this, building from the local copy
  // (make-portable) makes Next infer a workspace root up in the user profile (stray
  // parent package.json) and nest the standalone output under AppData/Local/....
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ["sql.js", "adm-zip"],
};

export default nextConfig;
