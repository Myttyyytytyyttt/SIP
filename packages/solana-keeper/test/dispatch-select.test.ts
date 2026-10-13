// THE MIGRATION'S SELECTION: who acts on each vault while the fleet moves to the
// queue (src/dispatch-select.ts, src/handover.ts, src/handover-cli.ts; dispatcher
// ADR §3.12, RT-4, §4.9 rows 12, 20 and 21; plan P3a "migration and selection").
//
// Without a database: the variable, the rule (system, never the mode byte), the
// selector's read and receipt over a scripted runner, its alert, the command
// line, and how bin/keeper.mts is wired — read from its source, as
// test/cuts-wiring.test.ts does, because the sweep is a closure in a top-level
// script. test/dispatch-select-pg.test.ts runs the statements on Postgres 16, and
// test/dispatch-select-keeper.test.ts runs the real keeper against the bench
// chain with a vault on the queue.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Redactor } from "@sip/solana-log";
import { describe, expect, it } from "vitest";
import { describeConfig, loadConfig } from "../src/config.js";
import { DISPATCH_MODES, readDispatchMode } from "../src/cuts.js";
import { CLAIM_SQL } from "../src/dispatch-store.js";
import {
  LEFT_ALONE_LISTED,
  LEGACY_SELECT_ALERT_KEY,
  LEGACY_SELECT_CRITICAL_STREAK,
  LEGACY_SELECT_SQL,
  LegacySelector,
  carryOnlyInMemoryVaults,
  leaveReason,
  leftAloneDetail,
  legacySelectAlert,
  partitionLegacyTurns,
  type LegacyView,
  type NotLegacy,
} from "../src/dispatch-select.js";
import { ENROL_VAULTS_SQL } from "../src/handover.js";
import { HANDOVER_USAGE, parseHandoverArgs } from "../src/handover-cli.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { KEEPER_ROLES, roleProfile, settlesMode } from "../src/role-registry.js";

const source = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const keeper = source("../bin/keeper.mts");
const sweepBody = ((): string => {
  const start = keeper.indexOf("async function sweep(): Promise<void> {");
  expect(start).toBeGreaterThan(-1);
  return keeper.slice(start, keeper.indexOf("\n}\n", start));
})();

const RPC = "https://rpc.example.test";
const DB = "postgres://keeper:pw@db.example.test:5432/sip";
const dry = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ SIP_SOLANA_RPC_URLS: RPC, SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID, ...over });

const VAULTS = {
  profitLegacy: "Vau1tPro11111111111111111111111111111111111",
  volumeQueue: "Vau1tVo1Queue1111111111111111111111111111111",
  draining: "Vau1tDrain111111111111111111111111111111111",
  noRow: "Vau1tNoRow111111111111111111111111111111111",
} as const;

function view(notLegacy: Record<string, NotLegacy>, absentIs: "legacy" | "queue" = "legacy", legacyRows: readonly string[] | null = null): LegacyView {
  return { notLegacy: new Map(Object.entries(notLegacy)), absentIs, legacyRows: legacyRows === null ? null : new Set(legacyRows), readAt: "2026-10-12T20:00:00.000Z" };
}

describe("SIP_SOLANA_DISPATCH", () => {
  it("is off unset or blank, one of off | shadow | on as written, and refuses anything else by shape, never by value", () => {
    for (const raw of [undefined, "", "  "]) expect(readDispatchMode(raw)).toEqual({ mode: "off" });
    expect(DISPATCH_MODES).toEqual(["off", "shadow", "on"]);
    for (const mode of DISPATCH_MODES) expect(readDispatchMode(` ${mode} `)).toEqual({ mode });
    for (const bad of ["On", "ON", "true", "1", "queue", "shadow,on"]) {
      expect(readDispatchMode(bad), bad).toEqual({ problem: expect.stringContaining("SIP_SOLANA_DISPATCH must be one of off, shadow, on") });
    }
    // BY SHAPE: a value that cannot appear in the sentence by accident is not quoted back.
    const read = readDispatchMode("queue-please");
    expect("problem" in read && read.problem).toBe("SIP_SOLANA_DISPATCH must be one of off, shadow, on; it holds a 12-character value.");
  });

  it("is a variable the keeper knows, off by default, and absent from the described config while off", () => {
    const off = loadConfig(dry(), new Redactor());
    expect(off.dispatch).toBe("off");
    expect(describeConfig(off)).not.toHaveProperty("dispatch");
    const on = loadConfig(dry({ SIP_SOLANA_DISPATCH: "on", DATABASE_URL: DB }), new Redactor());
    expect(on.dispatch).toBe("on");
    expect(describeConfig(on)).toMatchObject({ dispatch: "on" });
    expect(on.warnings.join(" ")).not.toMatch(/not a variable this keeper reads/);
    expect(loadConfig(dry({ SIP_SOLANA_DISPATCH: "shadow", DATABASE_URL: DB, SIP_SOLANA_ROLE: "volume" }), new Redactor()).dispatch).toBe("shadow");
  });

  it("refuses to start without DATABASE_URL, where the selection lives, and on an unknown value", () => {
    for (const mode of ["shadow", "on"]) {
      expect(() => loadConfig(dry({ SIP_SOLANA_DISPATCH: mode }), new Redactor()), mode).toThrow(/SIP_SOLANA_DISPATCH is .* DATABASE_URL is not set/);
    }
    expect(() => loadConfig(dry({ SIP_SOLANA_DISPATCH: "yes", DATABASE_URL: DB }), new Redactor())).toThrow(/SIP_SOLANA_DISPATCH must be one of/);
    expect(loadConfig(dry({ SIP_SOLANA_DISPATCH: "off" }), new Redactor()).dispatch).toBe("off");
  });
});

describe("the rule: vault_work.system, and a read that failed acts on nothing", () => {
  it("leaves alone what is draining or on the queue, runs what is legacy or has no row, and leaves everything alone unread", () => {
    const seen = view({ [VAULTS.volumeQueue]: "queue", [VAULTS.draining]: "draining" });
    expect(leaveReason(seen, VAULTS.profitLegacy)).toBeNull();
    expect(leaveReason(seen, VAULTS.noRow)).toBeNull();
    expect(leaveReason(seen, VAULTS.volumeQueue)).toBe("queue");
    expect(leaveReason(seen, VAULTS.draining)).toBe("draining");
    for (const vault of Object.values(VAULTS)) expect(leaveReason(null, vault)).toBe("unread");
  });

  it("under new_vault_system = queue, a vault with no row is not the legacy keepers' — and a legacy row still is", () => {
    const seen = view({ [VAULTS.volumeQueue]: "queue" }, "queue", [VAULTS.profitLegacy]);
    expect(leaveReason(seen, VAULTS.profitLegacy)).toBeNull();
    expect(leaveReason(seen, VAULTS.noRow)).toBe("unenrolled");
    expect(leaveReason(seen, VAULTS.volumeQueue)).toBe("queue");
  });

  it("splits a selection in order, and says why each turn was left", () => {
    const turns = [VAULTS.profitLegacy, VAULTS.volumeQueue, VAULTS.noRow, VAULTS.draining].map((vault, index) => ({ index, vault }));
    const split = partitionLegacyTurns(turns, (turn) => turn.vault, view({ [VAULTS.volumeQueue]: "queue", [VAULTS.draining]: "draining" }));
    expect(split.act.map((turn) => turn.index)).toEqual([0, 2]);
    expect(split.left.map(({ turn, reason }) => [turn.index, reason])).toEqual([
      [1, "queue"],
      [3, "draining"],
    ]);
    expect(partitionLegacyTurns(turns, (turn) => turn.vault, null).act).toEqual([]);
  });

  it("dispatch-select: an on-chain mode change never moves a vault between actors", () => {
    // A FLEET WHOSE OWNERS KEEP CALLING set_policy_v2: every vault through every
    // mode byte the program has, one it might gain and one nobody serves. The
    // actor of each vault — the legacy keepers or not — is the same at every
    // byte, for both roles, because nothing in the rule can see the byte.
    const fleet = [
      { vault: VAULTS.profitLegacy, system: null },
      { vault: VAULTS.volumeQueue, system: "queue" as const },
      { vault: VAULTS.draining, system: "draining" as const },
      { vault: VAULTS.noRow, system: null },
    ];
    const seen = view(Object.fromEntries(fleet.filter((v) => v.system !== null).map((v) => [v.vault, v.system!])));
    const actorsAt = (mode: number) =>
      KEEPER_ROLES.map((role) =>
        partitionLegacyTurns(
          fleet.map((v) => ({ ...v, skimMode: mode, role })),
          (turn) => turn.vault,
          seen,
        ).act.map((turn) => turn.vault),
      );
    const atProfit = actorsAt(0);
    for (const mode of [1, 2, 3, 255]) expect(actorsAt(mode), `mode ${mode}`).toEqual(atProfit);
    expect(atProfit).toEqual([
      [VAULTS.profitLegacy, VAULTS.noRow],
      [VAULTS.profitLegacy, VAULTS.noRow],
    ]);
    // THE RULE TAKES NO MODE AT ALL, and neither file that decides who acts reads one.
    expect(leaveReason.length).toBe(2);
    const selectCode = source("../src/dispatch-select.ts")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
      .join("\n");
    expect(selectCode).not.toMatch(/skim_?mode|skimMode/i);
    // THE QUEUE'S SIDE: a claim takes a vault by its system; the scheduler's
    // enrolment rewrites only the mode byte of a row it already has.
    const claimFilter = CLAIM_SQL.slice(CLAIM_SQL.indexOf("WHERE"), CLAIM_SQL.indexOf("ORDER BY"));
    expect(claimFilter).toContain("system = 'queue'");
    expect(claimFilter).not.toMatch(/skim_mode/);
    const onConflict = ENROL_VAULTS_SQL.slice(ENROL_VAULTS_SQL.indexOf("ON CONFLICT"));
    expect(onConflict).toContain("DO UPDATE SET skim_mode = EXCLUDED.skim_mode");
    expect(onConflict).not.toMatch(/system\s*=/);
  });

  it("names, on /status, what the keeper did not do and why", () => {
    expect(leftAloneDetail("queue", "on")).toMatch(/workers act on this vault, so this keeper neither settles nor invests it/);
    expect(leftAloneDetail("draining", "shadow")).toMatch(/being handed to the dispatcher's queue/);
    expect(leftAloneDetail("unenrolled", "on")).toMatch(/new_vault_system is queue/);
    expect(leftAloneDetail("unread", "shadow")).toMatch(/could not be read this sweep \(SIP_SOLANA_DISPATCH is shadow\): this keeper acts on no vault/);
  });
});

describe("L6a: the legacy profit keeper", () => {
  it("L6a: a VOLUME vault on the queue is never invested by the legacy profit keeper", () => {
    // WHY THE PROFIT KEEPER AT ALL: it settles PROFIT only, and invests EVERY
    // vault whatever its mode — so it turns a VOLUME vault for one reason, to
    // buy for it. Excluding the vault on the volume keeper alone would leave
    // that purchase running beside the queue's.
    const profit = roleProfile("profit");
    expect(profit.invests).toBe(true);
    expect(settlesMode(profit, 1)).toBe(false);

    // THE RULE: a VOLUME vault on the queue is left alone; the PROFIT one beside it is not.
    const selection = [
      { link: { vault: VAULTS.profitLegacy, wallet: "W1", skimMode: 0 } },
      { link: { vault: VAULTS.volumeQueue, wallet: "W2", skimMode: 1 } },
    ];
    const { act, left } = partitionLegacyTurns(selection, (turn) => turn.link.vault, view({ [VAULTS.volumeQueue]: "queue" }));
    expect(act.map((turn) => turn.link.wallet)).toEqual(["W1"]);
    expect(left).toEqual([{ turn: selection[1], reason: "queue" }]);

    // THE WIRING: the only purchase and the only settle in the keeper are inside
    // the loop over `turns`, and under SIP_SOLANA_DISPATCH `turns` is what
    // legacyTurns kept — which is partitionLegacyTurns' `act`.
    expect(keeper.match(/runInvestTick\(/g)).toHaveLength(1);
    expect(keeper.match(/runSettleTick\(/g)).toHaveLength(1);
    const loop = sweepBody.indexOf("for (const { link: door, lane } of turns) {");
    const loopEnd = sweepBody.indexOf("    // THE LOSSES THIS SWEEP LEFT WAITING");
    expect(loop).toBeGreaterThan(-1);
    for (const call of ["runInvestTick(", "runSettleTick(", "createPrivySolanaSigner("]) {
      const at = sweepBody.indexOf(call);
      expect(at, call).toBeGreaterThan(loop);
      expect(at, call).toBeLessThan(loopEnd);
    }
    const assigned = "const turns = legacySelector === null ? selection.turns : await legacyTurns(legacySelector, selection.turns, links, liveAtStart);";
    expect(sweepBody).toContain(assigned);
    expect(sweepBody.match(/const turns = /g)).toHaveLength(1);
    // BEFORE ANY READ FOR A TURN: the vault batch, the degraded read and the Privy book all see only what is kept.
    for (const read of ["readSweepState(connection, program, turns.map", "readVaults(program, turns.map", "const resolving = turns"]) {
      expect(sweepBody.indexOf(read), read).toBeGreaterThan(sweepBody.indexOf(assigned));
    }
    const fn = keeper.slice(keeper.indexOf("async function legacyTurns<"), keeper.indexOf("async function sweep(): Promise<void> {"));
    expect(fn).toContain("const { act, left } = partitionLegacyTurns(selected, (turn) => turn.link.vault, read.ok ? read.view : null);");
    expect(fn).toContain("return act;");
    expect(fn).not.toMatch(/return selected/);
  });

  it("tells /status which wallet was left alone and why, with a route that is never counted as signable", () => {
    const fn = keeper.slice(keeper.indexOf("async function legacyTurns<"), keeper.indexOf("async function sweep(): Promise<void> {"));
    expect(fn).toContain('health.wallets[wallet] = { settle: "LEFT_ALONE", invest: "LEFT_ALONE", signing: route, detail: leftAloneDetail(reason, selector.mode), at };');
    expect(fn).toContain("const route = `not resolved (left alone: ${reason})`;");
    // The signing summary counts "privy" and "local-keypair" as signable and "none…" as unsignable.
    expect("not resolved (left alone: queue)".startsWith("none")).toBe(false);
  });

  it("names the vaults whose loss carry lives only in memory: every carry without a store, and the store's own account with one", () => {
    const fn = keeper.slice(keeper.indexOf("async function legacyTurns<"), keeper.indexOf("async function sweep(): Promise<void> {"));
    expect(fn).toContain(
      "const carryVaults = carryOnlyInMemoryVaults(links, settleCarries, carryStore === null ? null : carryStore.memoryOnlyLinks(settleCarries));",
    );
    expect(fn).toContain("const read = await selector.read({ live, carryVaults, now: Date.now() });");
  });

  it("carryOnlyInMemoryVaults: off counts every carry memory holds; a store names only the links it says Postgres lacks", () => {
    const key = (name: string) => ({ toBase58: () => name });
    const links = [
      { linkAddress: key("L1"), vault: key("V1") },
      { linkAddress: key("L2"), vault: key("V1") },
      { linkAddress: key("L3"), vault: key("V2") },
      { linkAddress: key("L4"), vault: key("V3") },
    ];
    const book = new Map([
      ["L1", new Map([["1:2:3", {}]])],
      ["L2", new Map([["1:5:9", {}]])],
      ["L3", new Map()],
      ["L4", new Map([["1:1:1", {}]])],
    ]);
    // `off`: every vault with a carry in memory, each once.
    expect(carryOnlyInMemoryVaults(links, book, null)).toEqual(["V1", "V3"]);
    // `dual` whose write for L4 failed: only that one; `on` (nothing unwritten): none.
    expect(carryOnlyInMemoryVaults(links, book, new Set(["L4"]))).toEqual(["V3"]);
    expect(carryOnlyInMemoryVaults(links, book, new Set())).toEqual([]);
  });
});

describe("zero change with SIP_SOLANA_DISPATCH unset", () => {
  it("builds no selector, so no statement runs, no receipt is written and every selected turn is turned", () => {
    expect(keeper).toMatch(/const legacySelector: LegacySelector \| null =\n\s+config\.dispatch === "off"\n\s+\? null\n\s+: new LegacySelector\(\{/);
    expect(keeper.match(/new LegacySelector\(/g)).toHaveLength(1);
    // THE ONLY CALLER OF THE READ MODEL'S THROWING STATEMENT is the selector's runner.
    expect(keeper.match(/readModel\.statement\(/g)).toHaveLength(1);
    expect(keeper).toContain("run: (text, values) => readModel.statement(text, values),");
    const callers: string[] = [];
    for (const dir of ["src", "bin"] as const) {
      for (const name of readdirSync(fileURLToPath(new URL(`../${dir}/`, import.meta.url)))) {
        if (/\.(ts|mts)$/.test(name) && /\.statement\(/.test(source(`../${dir}/${name}`))) callers.push(`${dir}/${name}`);
      }
    }
    expect(callers).toEqual(["bin/keeper.mts"]);
  });

  it("adds nothing to /status or the sweep's log line while off", () => {
    expect(keeper).toContain("...(legacySelector === null ? {} : { dispatch: legacySelector.status() }),");
    expect(sweepBody).toContain("...(legacySelector === null ? {} : { leftAlone: legacySelector.status().leftAloneLastSweep }),");
  });
});

describe("LegacySelector: one read and receipt a sweep, over a scripted runner", () => {
  const options = { role: "profit" as const, mode: "on" as const, processId: "p-1", deployment: "dep-9", host: "box", carryStore: "dual" as const };
  const answer = (over: Record<string, unknown> = {}) => [
    { seen: { [VAULTS.volumeQueue]: "queue", [VAULTS.draining]: "draining" }, absent_is: "legacy", read_at: new Date("2026-10-12T20:00:00Z"), legacy_rows: null, ...over },
  ];

  it("sends the one statement with the receipt's values, and answers the view it read", async () => {
    const sent: { text: string; values: readonly unknown[] }[] = [];
    const selector = new LegacySelector({ ...options, run: async (text, values) => (sent.push({ text, values }), answer()) });
    const read = await selector.read({ live: true, carryVaults: [VAULTS.draining, VAULTS.profitLegacy, VAULTS.draining], now: 0 });
    expect(sent).toEqual([{ text: LEGACY_SELECT_SQL, values: ["p-1", "profit", "on", "dep-9", "box", true, [VAULTS.draining, VAULTS.profitLegacy].sort(), "dual"] }]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect([...read.view.notLegacy]).toEqual([
      [VAULTS.volumeQueue, "queue"],
      [VAULTS.draining, "draining"],
    ]);
    expect(read.view).toMatchObject({ absentIs: "legacy", legacyRows: null, readAt: "2026-10-12T20:00:00.000Z" });
    expect(selector.status()).toMatchObject({ reads: 1, failures: 0, consecutiveFailures: 0, notLegacy: { draining: 1, queue: 1 }, absentVaultsAre: "legacy" });
  });

  it("READ AND RECEIPT ARE ONE STATEMENT: the map it stores is the map it returns, on the database's clock", () => {
    expect(LEGACY_SELECT_SQL.match(/;/g)).toBeNull();
    expect(LEGACY_SELECT_SQL).toContain("INSERT INTO sip_solana.legacy_process");
    expect(LEGACY_SELECT_SQL).toContain("RETURNING seen, absent_is, read_at");
    expect(LEGACY_SELECT_SQL).toContain("clock_timestamp()");
    expect(LEGACY_SELECT_SQL).not.toMatch(/\bnow\(\)/);
    expect(LEGACY_SELECT_SQL).toContain("gone_at = NULL");
  });

  it("never throws: a failure is ok:false with its streak, every vault is left alone, and an answer resets the streak", async () => {
    let fail = true;
    const selector = new LegacySelector({
      ...options,
      run: async () => {
        if (fail) throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
        return answer();
      },
    });
    const first = await selector.read({ live: false, carryVaults: [], now: Date.parse("2026-10-12T20:01:00Z") });
    const second = await selector.read({ live: false, carryVaults: [], now: Date.parse("2026-10-12T20:02:00Z") });
    expect(first).toMatchObject({ ok: false, streak: 1 });
    expect(second).toMatchObject({ ok: false, streak: 2, detail: expect.stringContaining("ECONNREFUSED") });
    expect(partitionLegacyTurns([VAULTS.profitLegacy], (v) => v, null).act).toEqual([]);
    expect(selector.status()).toMatchObject({ failures: 2, consecutiveFailures: 2, lastReadAt: null, lastFailure: { at: "2026-10-12T20:02:00.000Z" } });
    fail = false;
    expect((await selector.read({ live: false, carryVaults: [], now: 0 })).ok).toBe(true);
    expect(selector.status()).toMatchObject({ reads: 1, failures: 2, consecutiveFailures: 0 });
  });

  it("reads strictly: an answer it cannot place is a read that failed, and acts on nothing", async () => {
    const bad = [
      [],
      [...answer(), ...answer()],
      answer({ seen: { [VAULTS.volumeQueue]: "worker" } }),
      answer({ seen: ["queue"] }),
      answer({ absent_is: "both" }),
      answer({ absent_is: "queue", legacy_rows: null }),
      answer({ read_at: null }),
    ];
    for (const rows of bad) {
      const read = await new LegacySelector({ ...options, run: async () => rows }).read({ live: true, carryVaults: [], now: 0 });
      expect(read.ok, JSON.stringify(rows)).toBe(false);
    }
    const queue = await new LegacySelector({ ...options, run: async () => answer({ absent_is: "queue", legacy_rows: [VAULTS.profitLegacy] }) }).read({ live: true, carryVaults: [], now: 0 });
    expect(queue.ok && [...(queue.view.legacyRows ?? [])]).toEqual([VAULTS.profitLegacy]);
  });

  it("keeps the last sweep's left-alone turns for /status, the count whole and the list bounded", () => {
    const selector = new LegacySelector({ ...options, run: async () => answer() });
    const left = Array.from({ length: LEFT_ALONE_LISTED + 5 }, (_, i) => ({ wallet: `W${i}`, vault: `V${i}`, reason: "queue" as const }));
    selector.noteLeft(left, ["V2", "V1", "V2"]);
    expect(selector.status()).toMatchObject({ leftAloneLastSweep: LEFT_ALONE_LISTED + 5, carryOnlyInMemory: ["V1", "V2"] });
    expect(selector.status().leftAlone).toHaveLength(LEFT_ALONE_LISTED);
    selector.noteLeft([], []);
    expect(selector.status()).toMatchObject({ leftAloneLastSweep: 0, leftAlone: [], carryOnlyInMemory: [] });
  });

  it("warns on a failed read and pages from the third in a row, under one key", () => {
    expect(legacySelectAlert(1, "x")).toMatchObject({ key: LEGACY_SELECT_ALERT_KEY, severity: "warn" });
    expect(legacySelectAlert(LEGACY_SELECT_CRITICAL_STREAK - 1, "x").severity).toBe("warn");
    expect(legacySelectAlert(LEGACY_SELECT_CRITICAL_STREAK, "x")).toMatchObject({ severity: "critical", detail: "3 sweeps in a row: x" });
    const fn = keeper.slice(keeper.indexOf("async function legacyTurns<"), keeper.indexOf("async function sweep(): Promise<void> {"));
    // THE WARNING IS CLEARED AT THE ESCALATION, or the alerter's dedupe would swallow the critical.
    expect(fn).toMatch(/if \(read\.streak === LEGACY_SELECT_CRITICAL_STREAK\) alerter\.clear\(LEGACY_SELECT_ALERT_KEY\);\n\s+alerter\.fire\(legacySelectAlert\(read\.streak, read\.detail\)\);/);
    expect(fn).toMatch(/if \(read\.ok\) \{\n\s+alerter\.clear\(LEGACY_SELECT_ALERT_KEY\);/);
  });
});

describe("dispatch-handover: the command line", () => {
  const vault = "EFXK995PV49Qz8xPSYMEUDBU5AKRR466JkgsfuGak5iU";

  it("parses every command, and arm's roles and drill flag", () => {
    expect(parseHandoverArgs(["status"])).toEqual({ kind: "status", vault: null });
    expect(parseHandoverArgs(["status", vault])).toEqual({ kind: "status", vault });
    for (const kind of ["drain", "rollback", "release"] as const) expect(parseHandoverArgs([kind, vault])).toEqual({ kind, vault });
    expect(parseHandoverArgs(["arm", vault])).toEqual({ kind: "arm", vault, requiredRoles: KEEPER_ROLES, allowDry: false });
    expect(parseHandoverArgs(["arm", "--all", "--roles=profit", "--allow-dry"])).toEqual({ kind: "arm", vault: "all", requiredRoles: ["profit"], allowDry: true });
    expect(parseHandoverArgs(["arm", "--all", "--roles=none"])).toEqual({ kind: "arm", vault: "all", requiredRoles: [], allowDry: false });
    expect(parseHandoverArgs(["gone", "a", "b"])).toEqual({ kind: "gone", processIds: ["a", "b"] });
    expect(parseHandoverArgs(["gone", "--stale"])).toEqual({ kind: "gone", processIds: "stale" });
    expect(parseHandoverArgs(["new-vaults", "queue"])).toEqual({ kind: "new-vaults", system: "queue" });
    expect(HANDOVER_USAGE).toContain("dispatch-handover arm <vault>|--all [--roles=profit,volume] [--allow-dry]");
  });

  it("refuses before touching anything: an address that is not one, an unknown command or flag, a missing or extra argument", () => {
    const refused: (readonly string[])[] = [
      [],
      ["handover"],
      ["drain"],
      ["drain", "not-a-vault"],
      ["drain", `${vault}x`],
      ["drain", vault, vault],
      ["drain", vault, "--force"],
      ["arm"],
      ["arm", vault, "--all"],
      ["arm", vault, "--roles=profit,profit"],
      ["arm", vault, "--roles=worker"],
      ["arm", vault, "--roles"],
      ["arm", vault, "--roles="],
      ["arm", vault, "--roles=none,profit"],
      ["gone"],
      ["gone", "a", "--stale"],
      ["new-vaults", "draining"],
    ];
    for (const argv of refused) expect(() => parseHandoverArgs(argv), argv.join(" ")).toThrow();
  });
});
