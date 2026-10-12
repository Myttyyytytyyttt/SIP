// What a dispatcher worker reads beyond the keeper's config (src/worker-config.ts):
// strictly, off unless named, and three refusals only a worker has.

import { Secret } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import { DEFAULT_WORKERS_MAX, DEFAULT_WORKER_SLOTS, WORKER_VARS, keeperEnvOf, readDispatchMode, readWorkerSettings, workerRefusals } from "../src/worker-config.js";

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
    expect(readWorkerSettings({})).toEqual({ settings: { mode: "off", slots: DEFAULT_WORKER_SLOTS, workersMax: DEFAULT_WORKERS_MAX, planRps: 50 } });
  });

  it("take whole numbers in range only, and every problem at once", () => {
    expect(readWorkerSettings({ SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_WORKER_SLOTS: "4", SIP_SOLANA_WORKERS_MAX: "3", SIP_SOLANA_PLAN_RPS: "200" })).toEqual({
      settings: { mode: "shadow", slots: 4, workersMax: 3, planRps: 200 },
    });
    const read = readWorkerSettings({ SIP_SOLANA_DISPATCH: "maybe", SIP_SOLANA_WORKER_SLOTS: "0", SIP_SOLANA_WORKERS_MAX: "2.5", SIP_SOLANA_PLAN_RPS: "-1" });
    expect("problems" in read && read.problems).toHaveLength(4);
  });
});

describe("the keeper's own config, without the worker's names", () => {
  it("hands loadConfig the environment minus exactly these four, so it does not call them misspellings", () => {
    const env = { SIP_SOLANA_DISPATCH: "on", SIP_SOLANA_WORKER_SLOTS: "2", SIP_SOLANA_WORKERS_MAX: "2", SIP_SOLANA_PLAN_RPS: "50", SIP_SOLANA_PROGRAM_ID: "p", OTHER: "x" };
    expect(keeperEnvOf(env)).toEqual({ SIP_SOLANA_PROGRAM_ID: "p", OTHER: "x" });
    expect(env.SIP_SOLANA_DISPATCH).toBe("on");
    expect([...WORKER_VARS].sort()).toEqual(["SIP_SOLANA_DISPATCH", "SIP_SOLANA_PLAN_RPS", "SIP_SOLANA_WORKERS_MAX", "SIP_SOLANA_WORKER_SLOTS"]);
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
