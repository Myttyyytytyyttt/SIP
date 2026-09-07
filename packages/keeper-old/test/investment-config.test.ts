// The gate that decides whether the supervisor may buy.
//
// Three outcomes and they are NOT interchangeable. `DISABLED` means an operator
// did not ask for this and settlement carries on untouched. `OK` means they did.
// `INVALID` means they did and got it wrong — and that must never be softened
// into `DISABLED`, because a half-configured investment path that quietly does
// nothing is precisely the outage this subsystem exists to prevent: a vault
// enabled, funded, and buying nothing, with every log line healthy.

import { describe, expect, it } from "vitest";

import { describeInvestmentConfig, loadInvestmentConfig } from "../src/investment-config.js";

const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const SPY = "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C";
const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  NUVEM_INVEST_POOLS: `${NVDA}:3000:60,${SPY}:500:5`,
  NUVEM_POOL_MANAGER: PM,
  NUVEM_USDG: USDG,
  ...over,
});

describe("deciding whether investing is on", () => {
  /**
   * ABSENCE IS THE SWITCH. A keeper that refused to start because a pool
   * parameter is missing would take SETTLEMENT down for a feature nobody asked
   * it to run.
   */
  it("is off when no pools are listed", () => {
    expect(loadInvestmentConfig({}).kind).toBe("DISABLED");
    expect(loadInvestmentConfig({ NUVEM_INVEST_POOLS: "   " }).kind).toBe("DISABLED");
  });

  it("is on when pools are listed and everything else is present", () => {
    const result = loadInvestmentConfig(env());
    expect(result.kind).toBe("OK");
    if (result.kind !== "OK") return;
    expect(result.config.stockPools.size).toBe(2);
    expect(result.config.stockPools.get(NVDA.toLowerCase())).toEqual({ fee: 3000, tickSpacing: 60 });
    expect(result.config.poolManager).toBe(PM);
  });

  /**
   * CONFIGURED AND WRONG IS AN ERROR, NOT AN "OFF". This is the distinction the
   * whole file exists for: softening it would let an operator who meant to
   * enable investing run for weeks believing they had.
   */
  it("refuses a configuration that is present and incomplete", () => {
    const result = loadInvestmentConfig({ NUVEM_INVEST_POOLS: `${NVDA}:3000:60` });
    expect(result.kind).toBe("INVALID");
    expect(result.kind === "INVALID" && result.problems.join(" ")).toContain("NUVEM_POOL_MANAGER");
  });
});

describe("the pool list", () => {
  it("rejects an entry that is not address:fee:tickSpacing", () => {
    const r = loadInvestmentConfig(env({ NUVEM_INVEST_POOLS: `${NVDA}:3000` }));
    expect(r.kind).toBe("INVALID");
    expect(r.kind === "INVALID" && r.problems[0]).toContain("not <asset>:<fee>:<tickSpacing>");
  });

  it("rejects an entry whose asset is not an address", () => {
    const r = loadInvestmentConfig(env({ NUVEM_INVEST_POOLS: "NVDA:3000:60" }));
    expect(r.kind).toBe("INVALID");
  });

  /**
   * A NON-POSITIVE TICK SPACING NAMES A POOL THAT CANNOT EXIST. The PoolKey
   * hashes to an id nothing lives at, every read returns zero, and the tick
   * reports "the pinned pool is empty" — sending whoever is on call to look at
   * liquidity instead of at one character in an environment variable.
   */
  it("rejects a tick spacing of zero or below", () => {
    for (const bad of ["0", "-60"]) {
      const r = loadInvestmentConfig(env({ NUVEM_INVEST_POOLS: `${NVDA}:3000:${bad}` }));
      expect(r.kind).toBe("INVALID");
      expect(r.kind === "INVALID" && r.problems.join(" ")).toContain("positive whole number");
    }
  });

  /** A duplicate is refused rather than resolved by ordering. */
  it("rejects the same asset twice", () => {
    const r = loadInvestmentConfig(env({ NUVEM_INVEST_POOLS: `${NVDA}:3000:60,${NVDA}:500:10` }));
    expect(r.kind).toBe("INVALID");
    expect(r.kind === "INVALID" && r.problems.join(" ")).toContain("more than once");
  });

  it("normalises the key so lookup does not depend on checksum casing", () => {
    const r = loadInvestmentConfig(env({ NUVEM_INVEST_POOLS: `${NVDA.toLowerCase()}:3000:60` }));
    expect(r.kind).toBe("OK");
    expect(r.kind === "OK" && r.config.stockPools.has(NVDA.toLowerCase())).toBe(true);
  });
});

describe("the tolerance", () => {
  it("defaults to the 50 bps the quote module assumes", () => {
    const r = loadInvestmentConfig(env());
    expect(r.kind === "OK" && r.config.toleranceBps).toBe(50);
  });

  it("refuses a tolerance that is not a sane percentage", () => {
    for (const bad of ["-1", "10000", "1.5", "wide"]) {
      expect(loadInvestmentConfig(env({ NUVEM_INVEST_TOLERANCE_BPS: bad })).kind).toBe("INVALID");
    }
  });

  /** Zero is legal and means "accept exactly the quote", which is a real choice. */
  it("accepts zero", () => {
    const r = loadInvestmentConfig(env({ NUVEM_INVEST_TOLERANCE_BPS: "0" }));
    expect(r.kind === "OK" && r.config.toleranceBps).toBe(0);
  });
});

describe("describing it for the startup log", () => {
  /**
   * "The vault is not buying" and "this keeper was never asked to buy" look
   * identical in a log that only reports what happened, so the startup line
   * says which one is true.
   */
  it("says off, and that settlement is unaffected", () => {
    const text = describeInvestmentConfig(loadInvestmentConfig({}));
    expect(text).toContain("off");
    expect(text).toContain("settlement is unaffected");
  });

  it("says how many pools and what tolerance", () => {
    const text = describeInvestmentConfig(loadInvestmentConfig(env()));
    expect(text).toContain("2 pool(s)");
    expect(text).toContain("50 bps");
    expect(text).toContain("200/4");
  });

  it("names the problems when it is misconfigured", () => {
    const text = describeInvestmentConfig(loadInvestmentConfig({ NUVEM_INVEST_POOLS: `${NVDA}:3000:60` }));
    expect(text).toContain("MISCONFIGURED");
    expect(text).toContain("NUVEM_POOL_MANAGER");
  });
});

describe("share destinations: the yield vault and the desks", () => {
  const SPUSDG = "0xde770c84FE66E063336b31737cFE9790f18c4087";
  const PBTC3X = "0x4472C69d299382F8847ebCE4FC6Ed8e295510E3e";
  const DESK = "0xD92fAE3C5F7fc0d0B56C421FEb6A47Eec3B92fF3";

  it("the legacy yield vault becomes a self-quoting entry", () => {
    const result = loadInvestmentConfig(env({ NUVEM_INVEST_YIELD_VAULT: SPUSDG }));
    expect(result.kind).toBe("OK");
    if (result.kind !== "OK") return;
    expect(result.config.sharesQuoters.get(SPUSDG.toLowerCase())).toBe(SPUSDG);
  });

  it("a desk quotes an asset at a DIFFERENT contract", () => {
    const result = loadInvestmentConfig(env({ NUVEM_INVEST_DESKS: `${PBTC3X}:${DESK}` }));
    expect(result.kind).toBe("OK");
    if (result.kind !== "OK") return;
    expect(result.config.sharesQuoters.get(PBTC3X.toLowerCase())).toBe(DESK);
  });

  it("both together coexist", () => {
    const result = loadInvestmentConfig(
      env({ NUVEM_INVEST_YIELD_VAULT: SPUSDG, NUVEM_INVEST_DESKS: `${PBTC3X}:${DESK}` }),
    );
    expect(result.kind).toBe("OK");
    if (result.kind !== "OK") return;
    expect(result.config.sharesQuoters.size).toBe(2);
  });

  it("refuses a malformed desk entry by name", () => {
    const result = loadInvestmentConfig(env({ NUVEM_INVEST_DESKS: `${PBTC3X}` }));
    expect(result.kind).toBe("INVALID");
    if (result.kind !== "INVALID") return;
    expect(result.problems.join(" ")).toContain("<asset>:<quoter>");
  });

  it("refuses USDG as a desk asset — dollars are the DOLLARS route", () => {
    const result = loadInvestmentConfig(env({ NUVEM_INVEST_DESKS: `${USDG}:${DESK}` }));
    expect(result.kind).toBe("INVALID");
    if (result.kind !== "INVALID") return;
    expect(result.problems.join(" ")).toContain("DOLLARS route");
  });

  it("refuses a duplicate asset, including one already claimed by the yield vault", () => {
    const twice = loadInvestmentConfig(env({ NUVEM_INVEST_DESKS: `${PBTC3X}:${DESK},${PBTC3X}:${DESK}` }));
    expect(twice.kind).toBe("INVALID");
    const clash = loadInvestmentConfig(
      env({ NUVEM_INVEST_YIELD_VAULT: SPUSDG, NUVEM_INVEST_DESKS: `${SPUSDG}:${DESK}` }),
    );
    expect(clash.kind).toBe("INVALID");
  });

  it("names a share env that would be silently ignored without the pools switch", () => {
    // NUVEM_INVEST_DESKS set, NUVEM_INVEST_POOLS not: the old behavior was
    // DISABLED — a mysteriously dead listing. Now it is a named refusal.
    const result = loadInvestmentConfig({ NUVEM_INVEST_DESKS: `${PBTC3X}:${DESK}` });
    expect(result.kind).toBe("INVALID");
    if (result.kind !== "INVALID") return;
    expect(result.problems.join(" ")).toContain("NUVEM_INVEST_DESKS");
    expect(result.problems.join(" ")).toContain("investing switch");
    // And a truly unconfigured keeper still reads as OFF, not broken.
    expect(loadInvestmentConfig({}).kind).toBe("DISABLED");
  });

  it("refuses USDG as the yield vault, the same guard the desks have", () => {
    const result = loadInvestmentConfig(env({ NUVEM_INVEST_YIELD_VAULT: USDG }));
    expect(result.kind).toBe("INVALID");
    if (result.kind !== "INVALID") return;
    expect(result.problems.join(" ")).toContain("DOLLARS route");
  });

  it("refuses an asset routed both as a pool and as a share destination", () => {
    const result = loadInvestmentConfig(env({ NUVEM_INVEST_DESKS: `${NVDA}:${DESK}` }));
    expect(result.kind).toBe("INVALID");
    if (result.kind !== "INVALID") return;
    expect(result.problems.join(" ")).toContain("pick one route");
  });

  it("the startup line names each destination, desk-routed ones with their quoter", () => {
    const result = loadInvestmentConfig(
      env({ NUVEM_INVEST_YIELD_VAULT: SPUSDG, NUVEM_INVEST_DESKS: `${PBTC3X}:${DESK}` }),
    );
    const text = describeInvestmentConfig(result);
    expect(text).toContain("2 share destination(s)");
    expect(text).toContain("via");
  });
});

describe("the pasted-name mistake", () => {
  const PBTC3X = "0x4472C69d299382F8847ebCE4FC6Ed8e295510E3e";
  const DESK = "0xD92fAE3C5F7fc0d0B56C421FEb6A47Eec3B92fF3";

  it("a value that begins with the variable's own name is stripped, not fatal", () => {
    const result = loadInvestmentConfig(
      env({ NUVEM_INVEST_DESKS: `NUVEM_INVEST_DESKS=${PBTC3X}:${DESK}` }),
    );
    expect(result.kind).toBe("OK");
    if (result.kind !== "OK") return;
    expect(result.config.sharesQuoters.get(PBTC3X.toLowerCase())).toBe(DESK);
  });
});
