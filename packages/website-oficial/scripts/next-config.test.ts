// THE DEV-ONLY PRIVY STUB MUST NEVER REACH PRODUCTION.
//
// The alias in next.config.mjs replaces wallet sign-in with a stand-in that
// reports whatever a page-injected global says. In a production build that is an
// authentication bypass, so it is gated twice — on NODE_ENV and on an explicit
// flag — and the stub modules throw on import as a third guard. This test pins
// all three, because each one alone is one edit away from being removed.

import { afterEach, describe, expect, it, vi } from "vitest";

import { privyStubAlias } from "../next.config.mjs";

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

describe("the stub modules refuse to load in a production build", () => {
  it("throws on import when NODE_ENV is production, whatever the bundler did", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    await expect(import("../test/stubs/privy-react-auth")).rejects.toThrow(/must never ship/);
    vi.resetModules();
    await expect(import("../test/stubs/privy-react-auth-solana")).rejects.toThrow(/must never ship/);
  });
});
