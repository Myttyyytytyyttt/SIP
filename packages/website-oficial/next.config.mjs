import path from "node:path";

import { securityHeaders } from "./security-headers.mjs";

/**
 * THE DEV-ONLY PRIVY STUB, and the two conditions that gate it.
 *
 * tools/landing-shot/live-states.mjs photographs the live dashboard in each of
 * its states, which means driving what Privy reports. Aliasing the SDK to a stub
 * is the only way to do that headlessly — and an alias like this reaching a
 * production build would replace real wallet sign-in with a fake that reports
 * whatever a page-injected global says.
 *
 * So it is off unless BOTH are true: this is not a production build, and
 * SIP_WEB_PRIVY_STUB is exactly "1". The stub modules ALSO throw on import under
 * NODE_ENV=production, so neither guard is load-bearing alone.
 * scripts/next-config.test.ts pins this.
 */
export function privyStubAlias(env = process.env) {
  if (env.NODE_ENV === "production" || env.SIP_WEB_PRIVY_STUB !== "1") return {};
  return {
    "@privy-io/react-auth": "./test/stubs/privy-react-auth.ts",
    "@privy-io/react-auth/solana": "./test/stubs/privy-react-auth-solana.ts",
  };
}

const resolveAlias = privyStubAlias(process.env);

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

  // Absent entirely in production: an empty object here would still be a
  // turbopack key in the deployed config.
  ...(Object.keys(resolveAlias).length > 0 ? { turbopack: { resolveAlias } } : {}),
};

export default nextConfig;
