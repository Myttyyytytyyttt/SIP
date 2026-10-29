// What a dispatcher worker reads beyond the keeper's config (src/worker-config.ts):
// strictly, off unless named, its deploy gate only when asked for, and the
// refusals only a worker has — three more behind that gate, and exactly
// today's without it.

import { Redactor, Secret } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { loadConfig, readPort } from "../src/config.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import {
  DEFAULT_WORKERS_MAX,
  DEFAULT_WORKER_SLOTS,
  WORKER_VARS,
  keeperEnvOf,
  readDispatchMode,
  readExtraModes,
  readWorkerHealth,
  readWorkerSettings,
  workerRefusals,
  type DispatchMode,
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
    expect(readWorkerSettings({})).toEqual({ settings: { mode: "off", slots: DEFAULT_WORKER_SLOTS, workersMax: DEFAULT_WORKERS_MAX, planRps: 50, extraModes: null, health: null } });
  });

  it("take whole numbers in range only, and every problem at once", () => {
    expect(readWorkerSettings({ SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_WORKER_SLOTS: "4", SIP_SOLANA_WORKERS_MAX: "3", SIP_SOLANA_PLAN_RPS: "200" })).toEqual({
      settings: { mode: "shadow", slots: 4, workersMax: 3, planRps: 200, extraModes: null, health: null },
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
  it("hands loadConfig the environment minus exactly these nine, so it does not call them misspellings — PORT stays, loadConfig reads it too", () => {
    const env = {
      SIP_SOLANA_DISPATCH: "on",
      SIP_SOLANA_WORKER_SLOTS: "2",
      SIP_SOLANA_WORKERS_MAX: "2",
      SIP_SOLANA_PLAN_RPS: "50",
      SIP_SOLANA_WORKER_HEALTH: "on",
      SIP_SOLANA_EXTRA_MODES: "roundup",
      SIP_SOLANA_EXTRA_MODES_VAULTS: "*",
      SIP_SOLANA_EXTRA_MODES_LIVE: "0",
      SIP_SOLANA_EXTRA_MODES_FROM_SLOT: "1",
      SIP_SOLANA_PROGRAM_ID: "p",
      PORT: "8080",
      OTHER: "x",
    };
    expect(keeperEnvOf(env)).toEqual({ SIP_SOLANA_PROGRAM_ID: "p", PORT: "8080", OTHER: "x" });
    expect(env.SIP_SOLANA_DISPATCH).toBe("on");
    expect([...WORKER_VARS].sort()).toEqual([
      "SIP_SOLANA_DISPATCH",
      "SIP_SOLANA_EXTRA_MODES",
      "SIP_SOLANA_EXTRA_MODES_FROM_SLOT",
      "SIP_SOLANA_EXTRA_MODES_LIVE",
      "SIP_SOLANA_EXTRA_MODES_VAULTS",
      "SIP_SOLANA_PLAN_RPS",
      "SIP_SOLANA_WORKERS_MAX",
      "SIP_SOLANA_WORKER_HEALTH",
      "SIP_SOLANA_WORKER_SLOTS",
    ]);
  });
});

describe("SIP_SOLANA_WORKER_HEALTH (the deploy gate, src/worker-health.ts): opt-in", () => {
  const problems = (env: Record<string, string>): readonly string[] => {
    const read = readWorkerSettings(env);
    return "problems" in read ? read.problems : [];
  };
  const healthOf = (env: Record<string, string>): { readonly port: number } | null => {
    const read = readWorkerSettings(env);
    if ("problems" in read) throw new Error(`refused: ${read.problems.join(" | ")}`);
    return read.settings.health;
  };

  it("is no gate when unset, empty or off, whatever PORT holds: every worker has a PORT, so PORT alone is no switch", () => {
    for (const value of [undefined, "", "  ", "off", " off "]) {
      const env = { SIP_SOLANA_DISPATCH: "shadow", PORT: "8080", ...(value === undefined ? {} : { SIP_SOLANA_WORKER_HEALTH: value }) };
      expect(healthOf(env), JSON.stringify(value)).toBeNull();
    }
    // AND WITHOUT THE GATE NOTHING MORE IS ASKED: no PORT, a PORT only loadConfig
    // refuses, SIP_SOLANA_DISPATCH unset — none of them is the gate's to refuse.
    expect(healthOf({ SIP_SOLANA_WORKER_HEALTH: "off" })).toBeNull();
    expect(healthOf({ SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_WORKER_HEALTH: "off", PORT: "80a" })).toBeNull();
    expect(readWorkerHealth({})).toEqual({ health: null });
  });

  it("is a gate on PORT with on", () => {
    expect(healthOf({ SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_WORKER_HEALTH: "on", PORT: "8080" })).toEqual({ port: 8080 });
    expect(healthOf({ SIP_SOLANA_DISPATCH: "on", SIP_SOLANA_WORKER_HEALTH: " on ", PORT: " 3000 " })).toEqual({ port: 3000 });
    expect(readWorkerHealth({ SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_WORKER_HEALTH: "on", PORT: "8080" })).toEqual({ health: { port: 8080 } });
  });

  it("accepts on beside SIP_SOLANA_DISPATCH=off written out: the idle worker that answers 200, the stop that survives pushes", () => {
    expect(readWorkerSettings({ SIP_SOLANA_DISPATCH: "off", SIP_SOLANA_WORKER_HEALTH: "on", PORT: "8080" })).toEqual({
      settings: { mode: "off", slots: DEFAULT_WORKER_SLOTS, workersMax: DEFAULT_WORKERS_MAX, planRps: 50, extraModes: null, health: { port: 8080 } },
    });
    expect(healthOf({ SIP_SOLANA_DISPATCH: " off ", SIP_SOLANA_WORKER_HEALTH: "on", PORT: "8080" })).toEqual({ port: 8080 });
  });

  it("H1: refuses any value but on or off, naming the variable and the value's length, never the value", () => {
    for (const value of ["ON", "Off", "true", "1", "yes", "on,off", "HealthSecretValue"]) {
      const said = problems({ SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_WORKER_HEALTH: value, PORT: "8080" });
      expect(said, value).toEqual([`SIP_SOLANA_WORKER_HEALTH must be on or off (unset is off); it holds a ${value.length}-character value.`]);
    }
    expect(problems({ SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_WORKER_HEALTH: "HealthSecretValue", PORT: "8080" }).join(" ")).not.toContain("HealthSecretValue");
  });

  it("H2: refuses on without a valid PORT, read by loadConfig's own rule (readPort), naming PORT and never its value", () => {
    // NONE AT ALL: a gate with no port to answer on.
    for (const env of [{}, { PORT: "" }, { PORT: "   " }] as Record<string, string>[]) {
      expect(problems({ ...env, SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_WORKER_HEALTH: "on" }), JSON.stringify(env)).toEqual([
        "SIP_SOLANA_WORKER_HEALTH=on answers /health on PORT, and PORT is not set: the port the healthcheck calls, an integer from 1 to 65535.",
      ]);
    }
    // ONE THAT IS NOT A PORT, refused in loadConfig's own words.
    for (const port of ["80a", "0", "65536", "-1", "8080.0", "PortSecretValue"]) {
      const rule = readPort(port);
      expect("problem" in rule, port).toBe(true);
      expect(problems({ SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_WORKER_HEALTH: "on", PORT: port }), port).toEqual([
        `SIP_SOLANA_WORKER_HEALTH=on answers /health on PORT: ${"problem" in rule ? rule.problem : ""}`,
      ]);
    }
    expect(problems({ SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_WORKER_HEALTH: "on", PORT: "PortSecretValue" }).join(" ")).not.toContain("PortSecretValue");
  });

  it("H3: refuses on with SIP_SOLANA_DISPATCH unset or empty: unset reads as off, and a variable lost in an edit would deploy green and idle", () => {
    for (const env of [{}, { SIP_SOLANA_DISPATCH: "" }, { SIP_SOLANA_DISPATCH: "   " }] as Record<string, string>[]) {
      expect(problems({ ...env, SIP_SOLANA_WORKER_HEALTH: "on", PORT: "8080" }), JSON.stringify(env)).toEqual([
        expect.stringContaining("SIP_SOLANA_WORKER_HEALTH=on with SIP_SOLANA_DISPATCH unset or empty: that reads as off"),
      ]);
    }
    // WITHOUT THE GATE THE SAME UNSET DISPATCH IS TODAY'S OFF: nothing refused, and bin/worker.mts exits 0.
    expect(readWorkerSettings({ PORT: "8080" })).toMatchObject({ settings: { mode: "off", health: null } });
    // A DISPATCH THAT IS NOT A MODE is readDispatchMode's refusal, not H3's.
    expect(problems({ SIP_SOLANA_DISPATCH: "maybe", SIP_SOLANA_WORKER_HEALTH: "on", PORT: "8080" })).toEqual([expect.stringContaining("SIP_SOLANA_DISPATCH must be one of")]);
  });

  it("reports its refusals together with every other one, at once", () => {
    expect(problems({ SIP_SOLANA_WORKER_HEALTH: "on", SIP_SOLANA_WORKER_SLOTS: "0", SIP_SOLANA_EXTRA_MODES_LIVE: "1" })).toEqual([
      expect.stringContaining("SIP_SOLANA_WORKER_SLOTS must be"),
      expect.stringContaining("set without SIP_SOLANA_EXTRA_MODES"),
      expect.stringContaining("PORT is not set"),
      expect.stringContaining("SIP_SOLANA_DISPATCH unset or empty"),
    ]);
  });
});

describe("workerRefusals", () => {
  type RefusalConfig = Parameters<typeof workerRefusals>[0];
  const db = new Secret("postgres://127.0.0.1/x", "databaseUrl");
  const webhook = new Secret("https://hooks.example.test/services/T0/B0/WebhookTokenNeverLogged", "alertWebhook");
  const jupiterKey = new Secret("JupiterKeyValueNeverLogged", "jupiterApiKey");
  const JUPITER_CUT: RefusalConfig["cuts"] = new Set(["jupiter-key"]);
  /** None of what the gate's three read: no cut, no Jupiter key, no webhook. */
  const config = (over: Partial<RefusalConfig> = {}): RefusalConfig => ({ armed: false, databaseUrl: db, cuts: new Set(), jupiterApiKey: null, alertWebhook: null, ...over });
  /** Without the health gate: every worker before it, and every worker that does not ask for it. */
  const ungated = (mode: DispatchMode) => ({ mode, health: null });
  /** Behind it (SIP_SOLANA_WORKER_HEALTH=on). */
  const gated = (mode: DispatchMode) => ({ mode, health: { port: 8080 } });

  it("refuses a shadow worker that holds a key: a shadow is a dry run, and a dry run reads no signing secret", () => {
    expect(workerRefusals(config({ armed: true }), ungated("shadow"), {})).toEqual([expect.stringContaining("SIP_SOLANA_DISPATCH=shadow on an armed keeper")]);
    expect(workerRefusals(config(), ungated("shadow"), {})).toEqual([]);
  });

  it("refuses a worker that is `on` and cannot sign, and any worker without its database", () => {
    expect(workerRefusals(config(), ungated("on"), {})).toEqual([expect.stringContaining("SIP_SOLANA_DISPATCH=on needs an armed keeper")]);
    expect(workerRefusals(config({ armed: true }), ungated("on"), {})).toEqual([]);
    expect(workerRefusals(config({ databaseUrl: null }), ungated("shadow"), {})).toEqual([expect.stringContaining("DATABASE_URL is required")]);
  });

  it("refuses a live worker signing through Privy without its signer id or policy id: it could not tell a wallet's seat apart", () => {
    const privy = { privy: {} } as unknown as NonNullable<RefusalConfig["signing"]>;
    expect(workerRefusals(config({ armed: true, signing: privy, privySignerId: null, privyPolicyId: "pol" }), ungated("on"), {})).toEqual([
      expect.stringContaining("without SIP_SOLANA_PRIVY_SIGNER_ID"),
    ]);
    expect(workerRefusals(config({ armed: true, signing: privy, privySignerId: "sig", privyPolicyId: null }), ungated("on"), {})).toEqual([
      expect.stringContaining("without SIP_SOLANA_PRIVY_POLICY_ID"),
    ]);
    expect(workerRefusals(config({ armed: true, signing: privy, privySignerId: "sig", privyPolicyId: "pol" }), ungated("on"), {})).toEqual([]);
    // WITHOUT PRIVY (local keypairs) there is no seat to check.
    expect(workerRefusals(config({ armed: true, signing: { privy: null } as unknown as NonNullable<RefusalConfig["signing"]>, privySignerId: null, privyPolicyId: null }), ungated("on"), {})).toEqual([]);
  });

  describe("behind the health gate, G1–G3: what elsewhere only warns, or says nothing", () => {
    it("G1: refuses a gated worker that is on with the jupiter-key cut and no Jupiter key; with the key, nothing; a gated shadow, keyless by design, is not refused", () => {
      const keyless = config({ armed: true, cuts: JUPITER_CUT, alertWebhook: webhook });
      expect(workerRefusals(keyless, gated("on"), {})).toEqual([
        "SIP_SOLANA_CUTS names jupiter-key without SIP_SOLANA_JUPITER_API_KEY: behind its health gate a worker that is `on` does not " +
          "buy keyless through lite-api.jup.ag, where a buy was refused on a 429 nobody saw (2026-10-27). Set " +
          "SIP_SOLANA_JUPITER_API_KEY on this service, or take jupiter-key out of SIP_SOLANA_CUTS.",
      ]);
      expect(workerRefusals({ ...keyless, jupiterApiKey: jupiterKey }, gated("on"), { SIP_SOLANA_JUPITER_API_KEY: jupiterKey.reveal() })).toEqual([]);
      // A SHADOW CARRIES NO KEY OF ANY KIND (the local shadow starts its workers without one): the same cut, keyless, is its normal.
      expect(workerRefusals(config({ cuts: JUPITER_CUT }), gated("shadow"), {})).toEqual([]);
    });

    it("G2: refuses a gated worker, shadow or on, with the Jupiter key or rate set and no cut, naming each one set and never what it holds; empty is unset", () => {
      for (const mode of ["shadow", "on"] as const) {
        const base = config({ armed: mode === "on", alertWebhook: webhook });
        expect(workerRefusals(base, gated(mode), { SIP_SOLANA_JUPITER_API_KEY: jupiterKey.reveal() }), mode).toEqual([
          expect.stringMatching(/^SIP_SOLANA_JUPITER_API_KEY set without jupiter-key in SIP_SOLANA_CUTS: not used .* or unset it\.$/),
        ]);
        expect(workerRefusals(base, gated(mode), { SIP_SOLANA_JUPITER_CALLS_PER_MINUTE: " 50 " }), mode).toEqual([
          expect.stringMatching(/^SIP_SOLANA_JUPITER_CALLS_PER_MINUTE set without jupiter-key in SIP_SOLANA_CUTS: .* or unset it\.$/),
        ]);
        expect(workerRefusals(base, gated(mode), { SIP_SOLANA_JUPITER_API_KEY: jupiterKey.reveal(), SIP_SOLANA_JUPITER_CALLS_PER_MINUTE: "50" }), mode).toEqual([
          expect.stringMatching(/^SIP_SOLANA_JUPITER_API_KEY and SIP_SOLANA_JUPITER_CALLS_PER_MINUTE set without jupiter-key .* or unset them\.$/),
        ]);
        // EMPTY OR BLANK IS UNSET, as the cut's own reader has it (readJupiterKeySettings).
        expect(workerRefusals(base, gated(mode), { SIP_SOLANA_JUPITER_API_KEY: "", SIP_SOLANA_JUPITER_CALLS_PER_MINUTE: "   " }), mode).toEqual([]);
      }
      expect(workerRefusals(config(), gated("shadow"), { SIP_SOLANA_JUPITER_API_KEY: jupiterKey.reveal() }).join(" ")).not.toContain(jupiterKey.reveal());
      // WITH THE CUT, BOTH ARE ITS OWN: nothing.
      const cut = config({ armed: true, cuts: JUPITER_CUT, jupiterApiKey: jupiterKey, alertWebhook: webhook });
      expect(workerRefusals(cut, gated("on"), { SIP_SOLANA_JUPITER_API_KEY: jupiterKey.reveal(), SIP_SOLANA_JUPITER_CALLS_PER_MINUTE: "500" })).toEqual([]);
    });

    it("G3: refuses a gated worker that is on with no alert webhook; a gated shadow, which sends nothing, may have none", () => {
      expect(workerRefusals(config({ armed: true }), gated("on"), {})).toEqual([
        "SIP_SOLANA_DISPATCH=on without SIP_SOLANA_ALERT_WEBHOOK: behind its health gate a worker that sends does not start with " +
          "nowhere to page — a failed settle or buy would reach only this service's log. Reference it from " +
          "sip-solana-keeper, as the signing secrets.",
      ]);
      expect(workerRefusals(config({ armed: true, alertWebhook: webhook }), gated("on"), {})).toEqual([]);
      expect(workerRefusals(config(), gated("shadow"), {})).toEqual([]);
    });

    it("are said together, after today's, in one start", () => {
      expect(workerRefusals(config({ cuts: JUPITER_CUT }), gated("on"), {})).toEqual([
        expect.stringContaining("SIP_SOLANA_DISPATCH=on needs an armed keeper"),
        expect.stringContaining("SIP_SOLANA_CUTS names jupiter-key without SIP_SOLANA_JUPITER_API_KEY"),
        expect.stringContaining("SIP_SOLANA_DISPATCH=on without SIP_SOLANA_ALERT_WEBHOOK"),
      ]);
    });

    it("WITHOUT THE GATE, EXACTLY TODAY'S: the gate only adds G1–G3, and a keyless cut, an unused key or rate and a missing webhook are refused nowhere else", () => {
      const G = /^(SIP_SOLANA_CUTS names jupiter-key without |SIP_SOLANA_JUPITER_[A-Z_]+ (and SIP_SOLANA_JUPITER_[A-Z_]+ )?set without jupiter-key |SIP_SOLANA_DISPATCH=on without SIP_SOLANA_ALERT_WEBHOOK)/;
      const envs: NodeJS.ProcessEnv[] = [{}, { SIP_SOLANA_JUPITER_API_KEY: "k-value" }, { SIP_SOLANA_JUPITER_CALLS_PER_MINUTE: "50" }];
      let refusedBehind = 0;
      for (const mode of ["shadow", "on"] as const)
        for (const armed of [false, true])
          for (const cuts of [new Set(), JUPITER_CUT] as RefusalConfig["cuts"][])
            for (const jupiterApiKey of [null, jupiterKey])
              for (const alertWebhook of [null, webhook])
                for (const env of envs) {
                  const c = config({ armed, cuts, jupiterApiKey, alertWebhook });
                  const without = workerRefusals(c, ungated(mode), env);
                  const behind = workerRefusals(c, gated(mode), env);
                  expect(without.filter((problem) => G.test(problem))).toEqual([]);
                  expect(without).toEqual(behind.filter((problem) => !G.test(problem)));
                  if (behind.length > without.length) refusedBehind += 1;
                }
      // THE PATTERN IS NOT VACUOUS: the gate does refuse some of these.
      expect(refusedBehind).toBeGreaterThan(0);
      // THE KEYLESS CUT IN PARTICULAR: armed, on, the cut and no key, no webhook — today nothing at all.
      expect(workerRefusals(config({ armed: true, cuts: JUPITER_CUT }), ungated("on"), {})).toEqual([]);
    });

    it("reads what loadConfig read: a keyless cut is no problem and no warning there, an unused rate only a warning", () => {
      const env = {
        SIP_SOLANA_DISPATCH: "shadow",
        SIP_SOLANA_WORKER_HEALTH: "on",
        PORT: "8080",
        SIP_SOLANA_RPC_URLS: "http://127.0.0.1:8899",
        SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
        DATABASE_URL: "postgres://worker:unused@127.0.0.1:5432/db",
      };
      const loaded = (over: Record<string, string>) => {
        const all = { ...env, ...over };
        const read = readWorkerSettings(all);
        if ("problems" in read) throw new Error(read.problems.join(" | "));
        return { all, settings: read.settings, config: loadConfig(keeperEnvOf(all), new Redactor()) };
      };
      // G2: SIP_SOLANA_JUPITER_CALLS_PER_MINUTE without the cut is loadConfig's warning, and this refusal behind the gate.
      const rate = loaded({ SIP_SOLANA_JUPITER_CALLS_PER_MINUTE: "50" });
      expect(rate.config.warnings.join(" ")).toContain("SIP_SOLANA_JUPITER_CALLS_PER_MINUTE: set, and not used");
      expect(workerRefusals(rate.config, rate.settings, rate.all)).toEqual([expect.stringContaining("SIP_SOLANA_JUPITER_CALLS_PER_MINUTE set without jupiter-key")]);
      expect(workerRefusals(rate.config, { ...rate.settings, health: null }, rate.all)).toEqual([]);
      // G1: the cut without a key loads with no key, no problem and no warning about it ...
      const keyless = loaded({ SIP_SOLANA_CUTS: "jupiter-key" });
      expect(keyless.config.jupiterApiKey).toBeNull();
      expect(keyless.config.warnings.join(" ")).not.toContain("JUPITER");
      // ... a gated shadow keeps it; `on` (armed by hand: arming is loadConfig's own test) is refused behind the gate, and only there.
      expect(workerRefusals(keyless.config, keyless.settings, keyless.all)).toEqual([]);
      const on = { ...keyless.config, armed: true, alertWebhook: webhook };
      expect(workerRefusals(on, { ...keyless.settings, mode: "on" }, keyless.all)).toEqual([expect.stringContaining("SIP_SOLANA_CUTS names jupiter-key without")]);
      expect(workerRefusals(on, { mode: "on", health: null }, keyless.all)).toEqual([]);
    });
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
      settings: {
        mode: "shadow",
        slots: DEFAULT_WORKER_SLOTS,
        workersMax: DEFAULT_WORKERS_MAX,
        planRps: 50,
        extraModes: { modes: new Set([3]), vaults: "*", live: false, fromSlot: null },
        health: null,
      },
    });
    expect(readWorkerSettings({ SIP_SOLANA_EXTRA_MODES: "fixed" })).toHaveProperty("problems");
  });
});
