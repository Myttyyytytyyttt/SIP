import path from "node:path";

import { securityHeaders } from "./security-headers.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // One policy, on every response. Lives in security-headers.mjs so a guard
  // can read the same object the server sends.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders() }];
  },

  // Emits .next/standalone with a self-contained server.js, which is what
  // this package's Dockerfile copies into the runtime image.
  output: "standalone",

  // MUST be the repo root and MUST be top-level in Next 15/16; without it the
  // standalone trace drops anything reached through a pnpm symlink outside
  // this directory. It also relocates the entrypoint to
  // standalone/packages/website-oficial/server.js, which the Dockerfile detects.
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),

  // @sip/solana-core ships TypeScript source with no build step, and it reads
  // the committed sip_vault IDL from @sip/solana-program. Next compiles both as
  // app code; without this the first import of the core fails the build.
  transpilePackages: ["@sip/solana-core", "@sip/solana-program"],

  reactStrictMode: true,

  // Never let a type error reach a deployed image.
  typescript: { ignoreBuildErrors: false },
};

export default nextConfig;
