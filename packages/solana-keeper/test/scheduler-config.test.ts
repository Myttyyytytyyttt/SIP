// The scheduler's environment (src/scheduler-config.ts): SIP_SOLANA_DISPATCH
// strict and off by default, no key on the public replica, its own numbers
// strict, and `lamports-filter` accepted here and nowhere else.

import { Keypair } from "@solana/web3.js";
import { Redactor } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import { BROADCAST_ACK, ConfigError, SIGNING_SECRET_VARS, loadConfig } from "../src/config.js";
import { DISPATCH_MODES as LEGACY_DISPATCH_MODES, readCuts, readDispatchMode as readLegacyDispatchMode } from "../src/cuts.js";
import { HELIUS_DEVELOPER_CREDITS_MONTH } from "../src/credit-governor.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { HELIUS_DEVELOPER_RPS } from "../src/rpc-quota.js";
import { KEEPER_ROLES } from "../src/role-registry.js";
import {
  DISPATCH_MODES as SCHEDULER_DISPATCH_MODES,
  SCHEDULER_REFUSED_VARS,
  SCHEDULER_VARS,
  autoArmRuns,
  loadSchedulerConfig,
  readAutoArm,
  readDispatchMode,
  readLegacyRoles,
  readSchedulerCuts,
} from "../src/scheduler-config.js";
import { DISPATCH_MODES as WORKER_DISPATCH_MODES, readDispatchMode as readWorkerDispatchMode } from "../src/worker-config.js";
import { JUPITER_KEYLESS_CALLS_PER_MINUTE } from "../src/sweep-cost.js";

const BASE = {
  SIP_SOLANA_DISPATCH: "shadow",
  SIP_SOLANA_RPC_URLS: "http://127.0.0.1:8899",
  SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
  DATABASE_URL: "postgres://user:pass-for-tests@127.0.0.1:5432/db",
} as const;

const load = (env: Record<string, string>) => loadSchedulerConfig(env, new Redactor());
const problemsOf = (env: Record<string, string>): readonly string[] => {
  try {
    load(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.problems;
    throw error;
  }
  return [];
};

describe("SIP_SOLANA_DISPATCH", () => {
  it("is off unset or blank, exactly off, shadow or on otherwise, and refuses anything else by shape", () => {
    expect(readDispatchMode(undefined)).toEqual({ mode: "off" });
    expect(readDispatchMode("  ")).toEqual({ mode: "off" });
    for (const mode of ["off", "shadow", "on"] as const) expect(readDispatchMode(mode)).toEqual({ mode });
    const refused = readDispatchMode("On");
    expect(refused).toEqual({ problem: expect.stringContaining("must be one of off, shadow, on") });
    expect(JSON.stringify(refused)).not.toContain('"On"');
  });

  it("a configuration loaded with dispatch off is refused: the entry point stops before it", () => {
    expect(problemsOf({ ...BASE, SIP_SOLANA_DISPATCH: "off" })).toEqual([expect.stringContaining("SIP_SOLANA_DISPATCH is off")]);
  });
});

describe("what a scheduler holds", () => {
  it("loads the shared variables through loadConfig, unarmed, with the ADR's defaults for its own numbers", () => {
    const config = load({ ...BASE });
    expect(config.dispatch).toBe("shadow");
    expect(config.base.armed).toBe(false);
    expect(config.base.signing).toBeNull();
    expect(config.base.databaseUrl).not.toBeNull();
    expect(config).toMatchObject({
      planRps: HELIUS_DEVELOPER_RPS,
      workersMax: 2,
      planCreditsPerMonth: HELIUS_DEVELOPER_CREDITS_MONTH,
      jupiterCallsPerMinute: JUPITER_KEYLESS_CALLS_PER_MINUTE,
    });
    expect([...config.cuts]).toEqual([]);
    expect(config.warnings).toEqual([]);
  });

  it("refuses to start with any key, the arming pair, the Jupiter key or a legacy role present — by name, reading none of them", () => {
    for (const name of SCHEDULER_REFUSED_VARS) {
      const secret = name === "SIP_SOLANA_SETTLE_KEY" ? JSON.stringify(Array.from(Keypair.generate().secretKey)) : "do-not-read-this-value";
      const env = new Proxy(
        { ...BASE, [name]: secret },
        {
          get(target, prop) {
            if (prop === name) throw new Error(`${name}'s value was read`);
            return Reflect.get(target, prop);
          },
        },
      );
      const problems = problemsOf(env as unknown as Record<string, string>);
      expect(problems.join(" "), name).toContain(name);
      expect(problems.join(" "), name).not.toContain(secret);
    }
    expect(SIGNING_SECRET_VARS.every((name) => (SCHEDULER_REFUSED_VARS as readonly string[]).includes(name))).toBe(true);
    expect(problemsOf({ ...BASE, SIP_SOLANA_BROADCAST: "1", SIP_SOLANA_ALLOW_BROADCAST: BROADCAST_ACK }).join(" ")).toContain("holds no key");
  });

  it("requires DATABASE_URL, and keeps loadConfig's own refusals (the transaction pooler)", () => {
    const { DATABASE_URL: _gone, ...noDatabase } = BASE;
    expect(problemsOf(noDatabase)).toEqual([expect.stringContaining("DATABASE_URL is required")]);
    expect(problemsOf({ ...BASE, DATABASE_URL: "postgres://u:p@127.0.0.1:6543/db" }).join(" ")).toContain("6543");
  });

  it("reads its own numbers strictly, and warns about a worker's settings it does not read", () => {
    const config = load({ ...BASE, SIP_SOLANA_PLAN_RPS: "200", SIP_SOLANA_WORKERS_MAX: "4", SIP_SOLANA_PLAN_CREDITS_MONTH: "20000000", SIP_SOLANA_JUPITER_CALLS_PER_MINUTE: "60", SIP_SOLANA_POOLS: "x" });
    expect(config).toMatchObject({ planRps: 200, workersMax: 4, planCreditsPerMonth: 20_000_000, jupiterCallsPerMinute: 60 });
    expect(config.warnings.join(" ")).toContain("SIP_SOLANA_POOLS");
    for (const [name, value] of [
      ["SIP_SOLANA_PLAN_RPS", "0"],
      // THE SAME FLOOR AS THE WORKERS': below 11 the scheduler's share leaves them nothing.
      ["SIP_SOLANA_PLAN_RPS", "10"],
      ["SIP_SOLANA_WORKERS_MAX", "65"],
      ["SIP_SOLANA_PLAN_CREDITS_MONTH", "1e7"],
      ["SIP_SOLANA_JUPITER_CALLS_PER_MINUTE", "-3"],
    ] as const) {
      expect(problemsOf({ ...BASE, [name]: value }).join(" "), name).toContain(name);
    }
  });
});

describe("SIP_SOLANA_CUTS on a scheduler", () => {
  it("acts on gpa-v2 and lamports-filter, accepts and names the workers' tokens, refuses an unknown or repeated one", () => {
    const config = load({ ...BASE, SIP_SOLANA_CUTS: "gpa-v2,lamports-filter,rest-skip,watchdog-exit" });
    expect([...config.cuts].sort()).toEqual(["gpa-v2", "lamports-filter"]);
    expect(config.named).toEqual(["gpa-v2", "lamports-filter", "rest-skip", "watchdog-exit"]);
    expect(config.warnings.join(" ")).toContain("rest-skip");
    expect(config.warnings.join(" ")).not.toContain("watchdog-exit");
    expect(readSchedulerCuts("lamports-filter,lamports-filter")).toEqual({ problems: [expect.stringContaining("repeats")] });
    expect(readSchedulerCuts("lamport-filter")).toEqual({ problems: [expect.stringContaining("not a cut")] });
  });

  it("is still refused by the legacy keeper: there `lamports-filter` would do nothing", () => {
    expect(readCuts("lamports-filter")).toEqual({ problems: [expect.stringContaining("not a cut this keeper implements")] });
    expect(() =>
      loadConfig({ SIP_SOLANA_RPC_URLS: BASE.SIP_SOLANA_RPC_URLS, SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID, SIP_SOLANA_CUTS: "lamports-filter" }, new Redactor()),
    ).toThrow(ConfigError);
  });

  it("SIP_SOLANA_DISPATCH means one thing to every process of a fleet: the legacy keeper reads it (its selection), and the scheduler's shared config never does", () => {
    // THE LEGACY KEEPER READS IT since the selection landed (src/dispatch-select.ts): strict, and refused without its database.
    const legacy = loadConfig({ ...BASE, SIP_SOLANA_DISPATCH: "on" }, new Redactor());
    expect(legacy.dispatch).toBe("on");
    expect(legacy.warnings.join(" ")).not.toContain("SIP_SOLANA_DISPATCH");
    expect(() =>
      loadConfig({ SIP_SOLANA_RPC_URLS: BASE.SIP_SOLANA_RPC_URLS, SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID, SIP_SOLANA_DISPATCH: "on" }, new Redactor()),
    ).toThrow(/DATABASE_URL is not set/);
    // THE SCHEDULER'S SHARED CONFIG IS LOADED WITHOUT IT: a scheduler is never a legacy keeper that leaves vaults alone.
    for (const mode of ["shadow", "on"] as const) {
      const config = load({ ...BASE, SIP_SOLANA_DISPATCH: mode });
      expect(config.dispatch).toBe(mode);
      expect(config.base.dispatch).toBe("off");
    }
  });
});

describe("one reader of SIP_SOLANA_DISPATCH for the whole fleet", () => {
  it("the scheduler's and the worker's are src/cuts.ts's own, which the legacy keepers read", () => {
    expect(readDispatchMode).toBe(readLegacyDispatchMode);
    expect(readWorkerDispatchMode).toBe(readLegacyDispatchMode);
    expect(SCHEDULER_DISPATCH_MODES).toBe(LEGACY_DISPATCH_MODES);
    expect(WORKER_DISPATCH_MODES).toBe(LEGACY_DISPATCH_MODES);
  });
});

describe("SIP_SOLANA_AUTO_ARM and SIP_SOLANA_LEGACY_ROLES", () => {
  it("SIP_SOLANA_AUTO_ARM is off unless it says on, and refuses anything else by shape", () => {
    expect(readAutoArm(undefined)).toEqual({ on: false });
    expect(readAutoArm("  ")).toEqual({ on: false });
    expect(readAutoArm("off")).toEqual({ on: false });
    expect(readAutoArm(" on ")).toEqual({ on: true });
    for (const raw of ["ON", "1", "true", "yes", "auto"]) {
      const read = readAutoArm(raw);
      expect(read, raw).toEqual({ problem: expect.stringContaining("SIP_SOLANA_AUTO_ARM must be off or on") });
      expect(JSON.stringify(read), raw).not.toContain(`"${raw}"`);
    }
  });

  it("SIP_SOLANA_LEGACY_ROLES is every role unset — arm's own rule — a list of roles each once, or none; anything else refuses", () => {
    expect(readLegacyRoles(undefined)).toEqual({ roles: KEEPER_ROLES });
    expect(readLegacyRoles(" ")).toEqual({ roles: KEEPER_ROLES });
    expect(readLegacyRoles("profit")).toEqual({ roles: ["profit"] });
    expect(readLegacyRoles("volume")).toEqual({ roles: ["volume"] });
    expect(readLegacyRoles("volume, profit")).toEqual({ roles: ["volume", "profit"] });
    expect(readLegacyRoles("none")).toEqual({ roles: [] });
    for (const raw of ["None", "profit,profit", "none,volume", "worker", "profit,,volume", "all"]) {
      expect(readLegacyRoles(raw), raw).toEqual({ problem: expect.stringContaining("SIP_SOLANA_LEGACY_ROLES must be a comma-separated list of profit, volume") });
    }
  });

  it("are the scheduler's own variables: off and every role by default, read strictly, malformed values refuse to start", () => {
    expect(SCHEDULER_VARS).toEqual(expect.arrayContaining(["SIP_SOLANA_AUTO_ARM", "SIP_SOLANA_LEGACY_ROLES"]));
    const plain = load({ ...BASE, SIP_SOLANA_DISPATCH: "on" });
    expect(plain).toMatchObject({ autoArm: false, legacyRoles: KEEPER_ROLES });
    expect(autoArmRuns(plain)).toBe(false);
    // NEVER HANDED TO loadConfig: no "not a variable this keeper reads" warning.
    const on = load({ ...BASE, SIP_SOLANA_DISPATCH: "on", SIP_SOLANA_AUTO_ARM: "on", SIP_SOLANA_LEGACY_ROLES: "none" });
    expect(on).toMatchObject({ autoArm: true, legacyRoles: [] });
    expect(autoArmRuns(on)).toBe(true);
    expect(on.warnings).toEqual([]);
    expect(problemsOf({ ...BASE, SIP_SOLANA_AUTO_ARM: "true" })).toEqual([expect.stringContaining("SIP_SOLANA_AUTO_ARM")]);
    expect(problemsOf({ ...BASE, SIP_SOLANA_LEGACY_ROLES: "profit,profit" })).toEqual([expect.stringContaining("SIP_SOLANA_LEGACY_ROLES")]);
  });

  it("runs only under SIP_SOLANA_DISPATCH=on, and says so under shadow; roles set with the step off are said to be unread", () => {
    const shadow = load({ ...BASE, SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_AUTO_ARM: "on" });
    expect(shadow.autoArm).toBe(true);
    expect(autoArmRuns(shadow)).toBe(false);
    expect(shadow.warnings.join(" ")).toContain("SIP_SOLANA_AUTO_ARM is on under SIP_SOLANA_DISPATCH=shadow");
    const unread = load({ ...BASE, SIP_SOLANA_DISPATCH: "on", SIP_SOLANA_LEGACY_ROLES: "profit" });
    expect(unread.legacyRoles).toEqual(["profit"]);
    expect(unread.warnings.join(" ")).toContain("SIP_SOLANA_LEGACY_ROLES is set but SIP_SOLANA_AUTO_ARM is off");
  });

  it("none with the step off is still read under on — by the legacy-orphaned alert — and said so; under shadow nothing reads it", () => {
    const retired = load({ ...BASE, SIP_SOLANA_DISPATCH: "on", SIP_SOLANA_LEGACY_ROLES: "none" });
    expect(retired.legacyRoles).toEqual([]);
    expect(retired.warnings.join(" ")).toContain("only the legacy-orphaned alert reads it");
    expect(retired.warnings.join(" ")).not.toContain("nothing on this scheduler reads it");
    const shadow = load({ ...BASE, SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_LEGACY_ROLES: "none" });
    expect(shadow.warnings.join(" ")).toContain("SIP_SOLANA_LEGACY_ROLES is set but SIP_SOLANA_AUTO_ARM is off: nothing on this scheduler reads it");
  });
});
