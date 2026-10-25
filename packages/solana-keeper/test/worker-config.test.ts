// What a dispatcher worker reads beyond the keeper's config (src/worker-config.ts):
// strictly, off unless named, and three refusals only a worker has.

import { Secret } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import {
  DEFAULT_WORKERS_MAX,
  DEFAULT_WORKER_SLOTS,
  WORKER_VARS,
  keeperEnvOf,
  readDispatchMode,
  readExtraModes,
  readWorkerSettings,
  workerRefusals,
} from "../src/worker-config.js";
import { MIN_PLAN_RPS, fleetQuotas } from "../src/rpc-quota.js";

describe("SIP_SOLANA_DISPATCH", () => {
  it("is off when unset or empty, and takes exactly off, shadow or on", () => {
    expect(readDispatchMode(undefined)).toEqual({ mode: "off" });
    expect(readDispatchMode("  ")).toEqual({ mode: "off" });
    for (const mode of ["off", "shadow", "on"] as const) expect(readDispatchMode(mode)).toEqual({ mode });
  });

  it("refuses anything else — a guessed mode is one that sends when nobody meant it to — without echoing the value", () => {
    for (const raw of ["ON", "true", "1", "live", "shadow,on"]) {
      const read = readDispatchMode(raw);
      expect("problem" in read).toBe(true);
      expect("problem" in read && read.problem).not.toContain(raw === "1" ? "holds 1" : raw);
    }
  });
});

describe("the worker's numbers", () => {
  it("default to 2 slots, r_max 2 and Developer's 50 requests a second", () => {
    expect(readWorkerSettings({})).toEqual({ settings: { mode: "off", slots: DEFAULT_WORKER_SLOTS, workersMax: DEFAULT_WORKERS_MAX, planRps: 50, extraModes: null } });
  });

  it("take whole numbers in range only, and every problem at once", () => {
    expect(readWorkerSettings({ SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_WORKER_SLOTS: "4", SIP_SOLANA_WORKERS_MAX: "3", SIP_SOLANA_PLAN_RPS: "200" })).toEqual({
      settings: { mode: "shadow", slots: 4, workersMax: 3, planRps: 200, extraModes: null },
    });
    const read = readWorkerSettings({ SIP_SOLANA_DISPATCH: "maybe", SIP_SOLANA_WORKER_SLOTS: "0", SIP_SOLANA_WORKERS_MAX: "2.5", SIP_SOLANA_PLAN_RPS: "-1" });
    expect("problems" in read && read.problems).toHaveLength(4);
  });

  it("refuses a plan too small to leave the workers a share — a worker on 5 a second died at boot building its budget", () => {
    expect(MIN_PLAN_RPS).toBe(11);
    const small = readWorkerSettings({ SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_PLAN_RPS: "5" });
    expect("problems" in small && small.problems.join(" ")).toContain("from 11 to");
    // AT THE FLOOR every worker's share is positive, however many the fleet may run.
    expect(fleetQuotas({ planRps: MIN_PLAN_RPS, liveWorkers: 1, maxWorkers: 64 }).floorRps).toBeGreaterThan(0);
    expect(fleetQuotas({ planRps: MIN_PLAN_RPS - 1, liveWorkers: 1, maxWorkers: 1 }).floorRps).toBe(0);
    expect("settings" in readWorkerSettings({ SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_PLAN_RPS: "11" })).toBe(true);
  });
});

describe("the keeper's own config, without the worker's names", () => {
  it("hands loadConfig the environment minus exactly these eight, so it does not call them misspellings", () => {
    const env = {
      SIP_SOLANA_DISPATCH: "on",
      SIP_SOLANA_WORKER_SLOTS: "2",
      SIP_SOLANA_WORKERS_MAX: "2",
      SIP_SOLANA_PLAN_RPS: "50",
      SIP_SOLANA_EXTRA_MODES: "roundup",
      SIP_SOLANA_EXTRA_MODES_VAULTS: "*",
      SIP_SOLANA_EXTRA_MODES_LIVE: "0",
      SIP_SOLANA_EXTRA_MODES_FROM_SLOT: "1",
      SIP_SOLANA_PROGRAM_ID: "p",
      OTHER: "x",
    };
    expect(keeperEnvOf(env)).toEqual({ SIP_SOLANA_PROGRAM_ID: "p", OTHER: "x" });
    expect(env.SIP_SOLANA_DISPATCH).toBe("on");
    expect([...WORKER_VARS].sort()).toEqual([
      "SIP_SOLANA_DISPATCH",
      "SIP_SOLANA_EXTRA_MODES",
      "SIP_SOLANA_EXTRA_MODES_FROM_SLOT",
      "SIP_SOLANA_EXTRA_MODES_LIVE",
      "SIP_SOLANA_EXTRA_MODES_VAULTS",
      "SIP_SOLANA_PLAN_RPS",
      "SIP_SOLANA_WORKERS_MAX",
      "SIP_SOLANA_WORKER_SLOTS",
    ]);
  });
});

describe("workerRefusals", () => {
  const db = new Secret("postgres://127.0.0.1/x", "databaseUrl");

  it("refuses a shadow worker that holds a key: a shadow is a dry run, and a dry run reads no signing secret", () => {
    expect(workerRefusals({ armed: true, databaseUrl: db }, { mode: "shadow" })).toEqual([expect.stringContaining("SIP_SOLANA_DISPATCH=shadow on an armed keeper")]);
    expect(workerRefusals({ armed: false, databaseUrl: db }, { mode: "shadow" })).toEqual([]);
  });

  it("refuses a worker that is `on` and cannot sign, and any worker without its database", () => {
    expect(workerRefusals({ armed: false, databaseUrl: db }, { mode: "on" })).toEqual([expect.stringContaining("SIP_SOLANA_DISPATCH=on needs an armed keeper")]);
    expect(workerRefusals({ armed: true, databaseUrl: db }, { mode: "on" })).toEqual([]);
    expect(workerRefusals({ armed: false, databaseUrl: null }, { mode: "shadow" })).toEqual([expect.stringContaining("DATABASE_URL is required")]);
  });
});

describe("SIP_SOLANA_EXTRA_MODES* (the per-trade modes, ADR §6.2 M4–M6)", () => {
  const vaultA = Keypair.generate().publicKey.toBase58();
  const vaultB = Keypair.generate().publicKey.toBase58();

  it("is off — no per-trade mode served — when every one of the four is unset or empty", () => {
    expect(readExtraModes({})).toEqual({ extraModes: null });
    expect(readExtraModes({ SIP_SOLANA_EXTRA_MODES: "  " })).toEqual({ extraModes: null });
  });

  it("reads the modes, the vault list or *, LIVE and FROM_SLOT exactly", () => {
    expect(readExtraModes({ SIP_SOLANA_EXTRA_MODES: "roundup,fixed", SIP_SOLANA_EXTRA_MODES_VAULTS: `${vaultA}, ${vaultB}` })).toEqual({
      extraModes: { modes: new Set([2, 3]), vaults: new Set([vaultA, vaultB]), live: false, fromSlot: null },
    });
    expect(
      readExtraModes({ SIP_SOLANA_EXTRA_MODES: "fixed", SIP_SOLANA_EXTRA_MODES_VAULTS: "*", SIP_SOLANA_EXTRA_MODES_LIVE: "1", SIP_SOLANA_EXTRA_MODES_FROM_SLOT: "450000000" }),
    ).toEqual({ extraModes: { modes: new Set([3]), vaults: "*", live: true, fromSlot: 450_000_000n } });
    expect(readExtraModes({ SIP_SOLANA_EXTRA_MODES: "roundup", SIP_SOLANA_EXTRA_MODES_VAULTS: vaultA, SIP_SOLANA_EXTRA_MODES_LIVE: "0" })).toMatchObject({ extraModes: { live: false } });
  });

  it("refuses to start on anything else, every problem at once, without echoing a value", () => {
    const problems = (env: Record<string, string>) => {
      const read = readExtraModes(env);
      return "problems" in read ? read.problems : [];
    };
    // An unknown mode and a repeated one.
    expect(problems({ SIP_SOLANA_EXTRA_MODES: "roundup,volume,roundup", SIP_SOLANA_EXTRA_MODES_VAULTS: "*" })).toHaveLength(2);
    // No vault list: serving every vault must be said, never defaulted.
    expect(problems({ SIP_SOLANA_EXTRA_MODES: "roundup" })).toEqual([expect.stringContaining("SIP_SOLANA_EXTRA_MODES_VAULTS is required")]);
    // A vault that is not an address.
    expect(problems({ SIP_SOLANA_EXTRA_MODES: "fixed", SIP_SOLANA_EXTRA_MODES_VAULTS: `${vaultA},not-a-vault` })).toEqual([expect.stringContaining("entry #2 is not a base58 vault address")]);
    // LIVE must be 0 or 1, and 1 needs the served-from slot.
    expect(problems({ SIP_SOLANA_EXTRA_MODES: "fixed", SIP_SOLANA_EXTRA_MODES_VAULTS: "*", SIP_SOLANA_EXTRA_MODES_LIVE: "true" })).toEqual([expect.stringContaining("must be 0 or 1")]);
    expect(problems({ SIP_SOLANA_EXTRA_MODES: "fixed", SIP_SOLANA_EXTRA_MODES_VAULTS: "*", SIP_SOLANA_EXTRA_MODES_LIVE: "1" })).toEqual([expect.stringContaining("needs SIP_SOLANA_EXTRA_MODES_FROM_SLOT")]);
    expect(problems({ SIP_SOLANA_EXTRA_MODES: "fixed", SIP_SOLANA_EXTRA_MODES_VAULTS: "*", SIP_SOLANA_EXTRA_MODES_FROM_SLOT: "-5" })).toEqual([expect.stringContaining("must be a slot")]);
    expect(problems({ SIP_SOLANA_EXTRA_MODES: "fixed", SIP_SOLANA_EXTRA_MODES_VAULTS: "*", SIP_SOLANA_EXTRA_MODES_FROM_SLOT: "18446744073709551616" })).toEqual([expect.stringContaining("must be a slot")]);
    // Any of the other three without the modes would do nothing: refused.
    expect(problems({ SIP_SOLANA_EXTRA_MODES_LIVE: "1" })).toEqual([expect.stringContaining("set without SIP_SOLANA_EXTRA_MODES")]);
    expect(problems({ SIP_SOLANA_EXTRA_MODES_VAULTS: "*", SIP_SOLANA_EXTRA_MODES_FROM_SLOT: "1" })).toEqual([expect.stringContaining("SIP_SOLANA_EXTRA_MODES_VAULTS, SIP_SOLANA_EXTRA_MODES_FROM_SLOT set without")]);
    for (const problem of problems({ SIP_SOLANA_EXTRA_MODES: "secretvalue", SIP_SOLANA_EXTRA_MODES_VAULTS: "*" })) expect(problem).not.toContain("secretvalue");
  });

  it("reaches readWorkerSettings, whose refusal it joins", () => {
    expect(readWorkerSettings({ SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_EXTRA_MODES: "fixed", SIP_SOLANA_EXTRA_MODES_VAULTS: "*" })).toEqual({
      settings: { mode: "shadow", slots: DEFAULT_WORKER_SLOTS, workersMax: DEFAULT_WORKERS_MAX, planRps: 50, extraModes: { modes: new Set([3]), vaults: "*", live: false, fromSlot: null } },
    });
    expect(readWorkerSettings({ SIP_SOLANA_EXTRA_MODES: "fixed" })).toHaveProperty("problems");
  });
});
