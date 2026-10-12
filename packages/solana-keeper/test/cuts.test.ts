// SIP_SOLANA_CUTS and SIP_SOLANA_DISCOVERY_LKG_MS (src/cuts.ts): strict, off
// when unset, and refusing to start on anything this build does not implement.

import { Redactor } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import { ConfigError, describeConfig, loadConfig } from "../src/config.js";
import { CUT_TOKENS, DISCOVERY_LKG_MAX_MS, OPS_TOKENS, readCuts, readDiscoveryLkgMs } from "../src/cuts.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";

const dry = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  SIP_SOLANA_RPC_URLS: "https://rpc.example.test/",
  SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
  ...over,
});

const refusal = (env: NodeJS.ProcessEnv): string => {
  try {
    loadConfig(env, new Redactor());
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  throw new Error("expected a ConfigError");
};

describe("SIP_SOLANA_CUTS", () => {
  it("is empty when unset or blank: today's keeper, request for request", () => {
    for (const raw of [undefined, "", "  "]) expect(readCuts(raw)).toEqual({ cuts: new Set() });
    const config = loadConfig(dry(), new Redactor());
    expect([...config.cuts]).toEqual([]);
    expect(config.discoveryLkgMs).toBe(0);
  });

  it("implements the three non-money cuts of the ADR's L1b, then the money tokens built so far, in rollout order, then the rest of L1a", () => {
    expect(CUT_TOKENS).toEqual(["gpa-v2", "privy-address", "board-timer", "jupiter-key", "rest-skip", "invest-batch", "explicit-send", ...OPS_TOKENS]);
    // EACH OF L1a's REMAINING PIECES ITS OWN TOKEN, so each is its own rollback.
    expect(OPS_TOKENS).toEqual([
      "watchdog-exit",
      "dep-down",
      "warn-digest",
      "claim-flap",
      "privy-burn",
      "jupiter-budget",
      "rpc-fallback",
      "privy-index",
    ]);
    const read = readCuts("jupiter-key");
    expect("cuts" in read && [...read.cuts]).toEqual(["jupiter-key"]);
  });

  it("accepts rest-skip beside the others, and only by its exact name", () => {
    const config = loadConfig(dry({ SIP_SOLANA_CUTS: "gpa-v2,rest-skip" }), new Redactor());
    expect([...config.cuts]).toEqual(["gpa-v2", "rest-skip"]);
    for (const bad of ["rest_skip", "REST-SKIP", "restskip", "rest-skip,rest-skip"]) {
      expect(() => loadConfig(dry({ SIP_SOLANA_CUTS: bad }), new Redactor()), bad).toThrow(ConfigError);
    }
  });

  it("reads every ops token like a cut, and none is on unless named", () => {
    const all = loadConfig(dry({ SIP_SOLANA_CUTS: OPS_TOKENS.join(",") }), new Redactor());
    expect([...all.cuts]).toEqual([...OPS_TOKENS]);
    const none = loadConfig(dry(), new Redactor());
    for (const token of OPS_TOKENS) expect(none.cuts.has(token), token).toBe(false);
    // A NEAR MISS IS REFUSED, NOT IGNORED: the owner reads Railway and believes what it names.
    for (const bad of ["watchdog", "dep_down", "digest", "claimflap", "Privy-Burn"]) {
      expect(refusal(dry({ SIP_SOLANA_CUTS: bad })), bad).toMatch(/SIP_SOLANA_CUTS entry #1 is not a cut this keeper implements/);
    }
  });

  it("reads a comma-separated list, spaces around tokens allowed", () => {
    const read = readCuts(" gpa-v2 , board-timer");
    expect("cuts" in read && [...read.cuts]).toEqual(["gpa-v2", "board-timer"]);
    const config = loadConfig(dry({ SIP_SOLANA_CUTS: "privy-address,gpa-v2" }), new Redactor());
    expect([...config.cuts]).toEqual(["privy-address", "gpa-v2"]);
    expect(describeConfig(config)).toMatchObject({ cuts: ["privy-address", "gpa-v2"], discoveryLkgMs: 0 });
    // A KNOWN VARIABLE: no "not a variable this keeper reads" warning for either.
    const both = loadConfig(dry({ SIP_SOLANA_CUTS: "gpa-v2", SIP_SOLANA_DISCOVERY_LKG_MS: "600000" }), new Redactor());
    expect(both.warnings.join(" ")).not.toMatch(/not a variable this keeper reads/);
  });

  it("REFUSES TO START on a token this build does not implement — a money cut named early included", () => {
    for (const bad of ["lamports-filter", "JUPITER-KEY", "invest_batch", "explicit_send", "rest_skip", "GPA-V2", "gpa_v2", "gpa-v2,", "everything"]) {
      const message = refusal(dry({ SIP_SOLANA_CUTS: bad }));
      expect(message, bad).toMatch(/SIP_SOLANA_CUTS entry #\d+ is not a cut this keeper implements/);
    }
    // BY POSITION AND SHAPE, NEVER BY VALUE.
    expect(refusal(dry({ SIP_SOLANA_CUTS: "gpa-v2,lamports-filter" }))).not.toContain("lamports-filter");
  });

  it("refuses a repeated token, so removing it once is the whole rollback", () => {
    expect(refusal(dry({ SIP_SOLANA_CUTS: "gpa-v2,board-timer,gpa-v2" }))).toContain("SIP_SOLANA_CUTS entry #3 repeats a token");
  });
});

describe("SIP_SOLANA_DISCOVERY_LKG_MS", () => {
  it("is 0 — off — when unset, and reads an integer number of milliseconds up to an hour", () => {
    expect(readDiscoveryLkgMs(undefined)).toEqual({ ms: 0 });
    expect(readDiscoveryLkgMs("0")).toEqual({ ms: 0 });
    expect(readDiscoveryLkgMs(" 600000 ")).toEqual({ ms: 600_000 });
    expect(readDiscoveryLkgMs(String(DISCOVERY_LKG_MAX_MS))).toEqual({ ms: DISCOVERY_LKG_MAX_MS });
    expect(loadConfig(dry({ SIP_SOLANA_DISCOVERY_LKG_MS: "600000" }), new Redactor()).discoveryLkgMs).toBe(600_000);
  });

  it("refuses anything else instead of guessing a limit", () => {
    for (const bad of ["-1", "1.5", "10m", "600000ms", String(DISCOVERY_LKG_MAX_MS + 1), "1e5"]) {
      expect(refusal(dry({ SIP_SOLANA_DISCOVERY_LKG_MS: bad })), bad).toContain("SIP_SOLANA_DISCOVERY_LKG_MS must be 0 (off)");
    }
  });
});
