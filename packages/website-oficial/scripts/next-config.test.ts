// THE DEV-ONLY PRIVY STUB MUST NEVER REACH PRODUCTION.
//
// The alias in next.config.mjs replaces wallet sign-in with a stand-in that
// reports whatever a page-injected global says. In a production build that is an
// authentication bypass, so it is gated twice — on NODE_ENV and on an explicit
// flag — and the stub modules throw on import as a third guard. This test pins
// all three, because each one alone is one edit away from being removed.

import { afterEach, describe, expect, it, vi } from "vitest";

import htmlBots from "next/dist/shared/lib/router/utils/html-bots.js";

import { HTML_LIMITED_BOTS, buildCommitOf, privyStubAlias } from "../next.config.mjs";
import { securityHeaders } from "../security-headers.mjs";

const PRIVY = "@privy-io/react-auth";
const PRIVY_SOLANA = "@privy-io/react-auth/solana";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("when the stub alias is applied", () => {
  it("is applied in development WITH the flag, for both entry points", () => {
    const alias = privyStubAlias({ NODE_ENV: "development", SIP_WEB_PRIVY_STUB: "1" });
    expect(Object.keys(alias).sort()).toEqual([PRIVY, PRIVY_SOLANA]);
    expect(alias[PRIVY]).toContain("test/stubs/privy-react-auth");
  });

  it("is NEVER applied in production, whatever the flag says", () => {
    expect(privyStubAlias({ NODE_ENV: "production", SIP_WEB_PRIVY_STUB: "1" })).toEqual({});
    expect(privyStubAlias({ NODE_ENV: "production" })).toEqual({});
  });

  it("is not applied without the flag, so a plain `next dev` uses the real SDK", () => {
    expect(privyStubAlias({ NODE_ENV: "development" })).toEqual({});
    expect(privyStubAlias({ NODE_ENV: "development", SIP_WEB_PRIVY_STUB: "0" })).toEqual({});
    expect(privyStubAlias({ NODE_ENV: "test", SIP_WEB_PRIVY_STUB: "true" })).toEqual({});
  });
});

describe("the config itself", () => {
  it("carries no turbopack alias at all when the stub is off", async () => {
    vi.resetModules();
    vi.stubEnv("SIP_WEB_PRIVY_STUB", "");
    const config = (await import("../next.config.mjs")).default;
    expect(config.turbopack).toBeUndefined();
  });
});

/**
 * THE HEADERS THE CONFIG ADDS (10-22): the security policy on every path, and a
 * year-long cache on the docs' clips alone, whose URLs carry their file's
 * version (src/lib/docs/clips.ts). Anything else cached that way would keep a
 * changed file from ever reaching a browser that has the old one.
 */
describe("the headers the config adds", () => {
  it("sends the security headers on every path", async () => {
    const config = (await import("../next.config.mjs")).default;
    expect((await config.headers())[0]).toEqual({ source: "/:path*", headers: securityHeaders() });
  });

  it("caches the docs' clips and the share card's plates for a year, immutable, only at a versioned URL, and nothing else", async () => {
    const config = (await import("../next.config.mjs")).default;
    const cached = (await config.headers()).filter((rule) => rule.headers.some((header) => header.key.toLowerCase() === "cache-control"));
    expect(cached).toEqual([
      {
        source: "/docs/clips/:file*",
        // The ?v= every docs page's clip URL carries (src/lib/docs/clips.ts): a bare address keeps public/'s default.
        has: [{ type: "query", key: "v", value: "[0-9a-f]{8}" }],
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        source: "/share/:file*",
        // The ?v= every plate URL carries (src/lib/share-plates.ts), checked by check:plates.
        has: [{ type: "query", key: "v", value: "[0-9a-f]{8}" }],
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
    ]);
  });
});

/**
 * A SHARED CARD (owner, 10-22: "Enlace con vista previa"): its page is never
 * indexed, every link-preview crawler gets its metadata in <head>, and its
 * picture's fonts and plates reach a standalone build.
 */
describe("the shared card's pages", () => {
  it("say noindex, follow in a header on every /c/ path", async () => {
    const config = (await import("../next.config.mjs")).default;
    expect((await config.headers()).filter((rule) => rule.source.startsWith("/c/"))).toEqual([{ source: "/c/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex, follow" }] }]);
  });

  it("give their metadata in <head> to Next's own HTML-limited bots, and to Mastodon's and Bluesky's — not to a browser", async () => {
    const config = (await import("../next.config.mjs")).default;
    expect([config.htmlLimitedBots.source, config.htmlLimitedBots.flags]).toEqual([HTML_LIMITED_BOTS.source, "i"]);
    expect(HTML_LIMITED_BOTS.source.startsWith(htmlBots.HTML_LIMITED_BOT_UA_RE.source)).toBe(true);
    for (const agent of [
      "Twitterbot/1.0",
      "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
      "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
      "TelegramBot (like TwitterBot)",
      "WhatsApp/2.23.20.0",
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
      "http.rb/5.1.1 (Mastodon/4.2.0; +https://mastodon.social/) Bot",
      "Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)",
    ]) {
      expect(HTML_LIMITED_BOTS.test(agent), agent).toBe(true);
    }
    expect(HTML_LIMITED_BOTS.test("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36")).toBe(false);
  });

  it("carry the picture's fonts and plates into the traced build, for the one route that draws at run time", async () => {
    const config = (await import("../next.config.mjs")).default;
    expect(config.outputFileTracingIncludes).toEqual({ "/c/[token]/card.png": ["./assets/share-og/**/*"] });
  });
});

describe("the stub modules refuse to load in a production build", () => {
  it("throws on import when NODE_ENV is production, whatever the bundler did", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    await expect(import("../test/stubs/privy-react-auth")).rejects.toThrow(/must never ship/);
    vi.resetModules();
    await expect(import("../test/stubs/privy-react-auth-solana")).rejects.toThrow(/must never ship/);
  });
});

/**
 * THE BUNDLE'S COMMIT (diagnosis 10-09, D5): baked in so a tab can tell when
 * the server runs a newer build (src/lib/build-version.ts). Only a real commit
 * id gets in; anything else is "dev", which never announces an update.
 */
describe("the build commit inlined into the bundle", () => {
  it("is Vercel's commit id, lowercased", () => {
    expect(buildCommitOf({ VERCEL_GIT_COMMIT_SHA: " 4533733ABCDEF " })).toBe("4533733abcdef");
    expect(buildCommitOf({ VERCEL_GIT_COMMIT_SHA: "4533733abcdef0123456789abcdef0123456789a" })).toBe("4533733abcdef0123456789abcdef0123456789a");
  });

  it("is 'dev' without one, or with anything that is not a commit id", () => {
    expect(buildCommitOf({})).toBe("dev");
    expect(buildCommitOf({ VERCEL_GIT_COMMIT_SHA: "" })).toBe("dev");
    expect(buildCommitOf({ VERCEL_GIT_COMMIT_SHA: "main" })).toBe("dev");
    expect(buildCommitOf({ VERCEL_GIT_COMMIT_SHA: "abc123" })).toBe("dev");
    expect(buildCommitOf({ VERCEL_GIT_COMMIT_SHA: "${secret}" })).toBe("dev");
  });

  it("reaches the config as SIP_BUILD_COMMIT, the name src/lib/build-version.ts reads", async () => {
    vi.resetModules();
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "feb0a63");
    const config = (await import("../next.config.mjs")).default;
    expect(config.env).toEqual({ SIP_BUILD_COMMIT: "feb0a63" });
  });
});
