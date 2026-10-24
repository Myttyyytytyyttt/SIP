import path from "node:path";

import htmlBots from "next/dist/shared/lib/router/utils/html-bots.js";

import { securityHeaders } from "./security-headers.mjs";

/**
 * THE CRAWLERS THAT GET A SHARED CARD'S METADATA IN <head> (10-22). Next 16
 * streams the metadata of a page rendered per request — /c/<token> is one —
 * into <body> for any client outside its list of "HTML-limited" bots, and a
 * link preview reads <head> only. X, Facebook, LinkedIn, Slack, Discord and
 * WhatsApp are on Next's list, and Telegram matches it by its "(like
 * TwitterBot)"; Mastodon's fetcher and Bluesky's (Cardyb) are not. So the list
 * is Next's own, read from Next, plus those two: a setting here replaces it.
 */
export const HTML_LIMITED_BOTS = new RegExp(`${htmlBots.HTML_LIMITED_BOT_UA_RE.source}|Mastodon|Bluesky|Cardyb`, "i");

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

/**
 * THE DEV-ONLY BLOB STUB (10-23), the same way: the short share links' store
 * (src/lib/share-store.ts) is a private Vercel Blob store that exists only in
 * production, and no proof may reach a real one. With SIP_WEB_BLOB_STUB exactly
 * "1", outside a production build, @vercel/blob is a stand-in that keeps each
 * record as a file in SIP_WEB_BLOB_STUB_DIR (test/stubs/vercel-blob.ts), which
 * itself throws on import under NODE_ENV=production.
 */
export function blobStubAlias(env = process.env) {
  if (env.NODE_ENV === "production" || env.SIP_WEB_BLOB_STUB !== "1") return {};
  return { "@vercel/blob": "./test/stubs/vercel-blob.ts" };
}

const resolveAlias = { ...privyStubAlias(process.env), ...blobStubAlias(process.env) };

/**
 * THE COMMIT THIS BUNDLE IS BUILT FROM, baked in as SIP_BUILD_COMMIT so a tab
 * can tell when the server runs a newer one (src/lib/build-version.ts,
 * GET /api/version). Vercel's VERCEL_GIT_COMMIT_SHA is a public git commit
 * id, nothing secret; anything that is not one — no variable, a local build —
 * is "dev", which never announces an update. The same rule as
 * build-version.ts's commitOf, in plain JavaScript because Next loads this
 * file without a TypeScript loader.
 */
export function buildCommitOf(env = process.env) {
  const raw = typeof env.VERCEL_GIT_COMMIT_SHA === "string" ? env.VERCEL_GIT_COMMIT_SHA.trim() : "";
  return /^[0-9a-f]{7,40}$/i.test(raw) ? raw.toLowerCase() : "dev";
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  // One policy, on every response. Lives in security-headers.mjs so a guard
  // can read the same object the server sends.
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders() },
      // THE DOCS' CLIPS ARE KEPT FOR A YEAR, WITHOUT ASKING AGAIN (10-22,
      // measured). public/ is served "max-age=0", so every visit asked again for
      // the poster and for each range of the loop, a round trip each before the
      // loop played. Safe only because every URL a docs page uses carries its
      // file's version (?v=, src/lib/docs/clips.ts), which check:clips checks
      // before every build: a re-rendered clip gets a new address. And only a
      // URL that carries one: a bare /docs/clips/ address, which no page uses,
      // keeps public/'s default, so it can never pin an old file for a year.
      // Nothing outside /docs/clips/ changes: /landing/* keeps public/'s default.
      {
        source: "/docs/clips/:file*",
        has: [{ type: "query", key: "v", value: "[0-9a-f]{8}" }],
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      // THE SHARE CARD'S PLATES, THE SAME WAY (10-22): the dialog asks for a
      // plate's still, thumb and loop on every open, and the video export for its
      // MP4. Every URL it uses carries its file's version (src/lib/share-plates.ts),
      // which check:plates checks before every build.
      {
        source: "/share/:file*",
        has: [{ type: "query", key: "v", value: "[0-9a-f]{8}" }],
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      // A SHARED CARD'S PAGE IS NOT FOR A SEARCH RESULT (10-22): one person's
      // dated moment. Its metadata says so too, but metadata streamed into
      // <body> is not read by every crawler; a header always is. Links followed.
      { source: "/c/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, follow" }] },
      // A SHORT LINK'S PAGE IS KEPT AT VERCEL'S CDN FOR A YEAR (10-23): a code is
      // one card forever (src/lib/share-code.ts), so its page need not ask the
      // Blob store again on every visit — the store's reads are what is scarce.
      // Next sends a page rendered per request as "private, no-store", which
      // browsers keep obeying; this header is for Vercel's CDN alone, which
      // never forwards it. Best effort, and nothing rests on it: the CDN's
      // cache is per deployment (each deploy starts it empty) and may let a
      // page go sooner, and then the page renders per visit, as a long link's,
      // with the record still read once per instance (src/lib/share-store.ts).
      // Exactly 8 characters: a long /c/<token> and /c/example are not matched.
      // The header rides on every status, but Vercel's CDN keeps only 200, 404,
      // 410, 301, 302, 307 and 308 (its "cacheable response criteria"): so a
      // 404 — a code no card was kept under — may be kept, and the 500 "try
      // again" page of a store that did not answer never is (review, 10-23).
      { source: "/c/:code([0-9A-Za-z]{8})", headers: [{ key: "Vercel-CDN-Cache-Control", value: "max-age=31536000" }] },
    ];
  },

  htmlLimitedBots: HTML_LIMITED_BOTS,

  // A SHARED CARD'S PICTURE IS DRAWN AT RUN TIME (/c/<token>/card.png) from
  // files outside public/ — the fonts and the plates' first frames
  // (components/share-og.tsx). A standalone build carries only what is traced,
  // and a path read through process.cwd() is not, so the folder is named here.
  outputFileTracingIncludes: {
    "/c/[token]/card.png": ["./assets/share-og/**/*"],
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

  // The bundle's own identity, inlined at build time: the one value that must
  // be frozen into it (buildCommitOf above).
  env: { SIP_BUILD_COMMIT: buildCommitOf(process.env) },

  // Never let a type error reach a deployed image.
  typescript: { ignoreBuildErrors: false },

  // Absent entirely in production: an empty object here would still be a
  // turbopack key in the deployed config.
  ...(Object.keys(resolveAlias).length > 0 ? { turbopack: { resolveAlias } } : {}),
};

export default nextConfig;
