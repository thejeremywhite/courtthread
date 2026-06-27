import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // "standalone" emits a self-contained server (.next/standalone) carrying only the traced
  // node_modules — this is what make-portable.bat packages for the thumb-drive build.
  // Harmless to normal `next dev` / `next start`.
  output: "standalone",
  serverExternalPackages: ["sql.js", "adm-zip"],
};

export default nextConfig;
