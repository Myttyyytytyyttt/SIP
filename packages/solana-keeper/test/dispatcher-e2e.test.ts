// THE DISPATCHER END TO END, IN THE SHADOW WORLD (plan §3.3.1 "local-shadow
// harness", §3.3.2's setup at bench scale): the real entry points as child
// processes — bin/scheduler.mts, two bin/worker.mts with two slots each, and the
// operator's bin/dispatch-handover.mts — over one throwaway Postgres 16 and the
// bench's chain stub on the loopback (src/bench/chain-stub.ts, the stub the
// parity runs and test/dispatch-select-keeper.test.ts use).
//
// ONE FULL CYCLE, AS P3b WILL RUN IT:
//   1. `dispatch-handover new-vaults queue` (a shadow's database, which no legacy
//      keeper uses), then the scheduler's discovery: four links listed into
//      keeper_link, each vault enrolled 'draining' — never straight to the queue;
//   2. `dispatch-handover arm --all --roles=none --allow-dry`, twice: the first
//      records the processed height, the second moves every vault once the
//      finalized height has passed it by 150 blocks;
//   3. the scheduler's full pass makes them due, the two workers claim them and
//      run their jobs keyless and dry: every would-be send gated as a 'shadow'
//      intent, nothing sent (the stub records no sendTransaction);
//   4. THE TAKEOVER: the first worker to gate a send is frozen before it can
//      resolve it (its RPC path stops answering the confirmed height) and then
//      killed, holding its vault with an open shadow intent. Its lease lapses
//      (moved back by SQL: the 45 seconds a dead holder leaves, without waiting
//      them). The other worker claims the vault, finds the intent open below the
//      finalized height and waits (WAITING_INTENT), plans nothing; once the
//      finalized height passes the intent's last valid height it goes on, and
//      every intent it gates on that vault carries a plan floor at or above it.
//      The overlap audit reads zero rows.
//   5. SIGTERM: the survivor and the scheduler stop cleanly (exit 0, rows closed).
//
// The chain's heights are the test's (getBlockHeight, and getEpochInfo's
// blockHeight, are answered here, not by the stub, which models no height): they
// climb ten blocks a second from below the stub's one blockhash's last valid
// height (400 100 000) and jump where a step needs time to pass.
//
// RUN ONLY WITH A THROWAWAY DATABASE ON THE LOOPBACK (KEEPER_TEST_PG_URL), as the
// other *-pg tests; without it the block is skipped. Nothing leaves the machine:
// every child runs with `env -i`, no key, no SIP_SOLANA_BROADCAST, and
// scripts/bench-offline.mts refuses any fetch that is not to the loopback.

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BenchChain } from "../src/bench/chain-stub.js";
import { benchKey, buildFleet, rentExempt, VAULT_SPACE, vaultBytes, type BenchLink } from "../src/bench/fleet.js";
import { DispatchStore } from "../src/dispatch-store.js";
import { HANDOVER_WAIT_BLOCKS } from "../src/handover.js";
import { SIP_PROGRAM_ID } from "../src/idl.js";

const URL_RAW = process.env["KEEPER_TEST_PG_URL"];
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const usable = ((): boolean => {
  if (URL_RAW === undefined || URL_RAW.trim() === "") return false;
  const host = new URL(URL_RAW).hostname;
  if (!LOOPBACK.has(host)) throw new Error("KEEPER_TEST_PG_URL must point at the loopback; it names another host");
  return true;
})();

const KEEPER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_SQL = readFileSync(resolve(KEEPER_DIR, "sql/sip_solana.sql"), "utf8");
const S = "sip_solana";
/** The scheduler's tick: the shortest the config accepts. */
const TICK_MS = 5_000;
/** The stub's one blockhash's last valid height (src/bench/chain-stub.ts, CURRENT_SLOT): every shadow intent's. */
const STUB_LAST_VALID = 400_100_000;
/** Where the heights start: below it, so an intent left open is one that "could still land". */
const HEIGHT_START = 400_097_000;
/** confirmed − finalized, as on mainnet (~32 blocks). */
const FINALITY_GAP = 32;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function freePort(): Promise<number> {
  return await new Promise((done, fail) => {
    const probe = createSocketServer();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => done(port));
    });
  });
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Four links, two of them hot (one PROFIT, one VOLUME): both settle modules gate a would-be settle. */
function mixedChain(): { chain: BenchChain; fleet: readonly BenchLink[] } {
  const PublicKeyCtor = benchKey("x").constructor as new (s: string) => BenchLink["vault"];
  const program = new PublicKeyCtor(SIP_PROGRAM_ID);
  const chain = new BenchChain({ programId: program, crank: benchKey("crank"), skimMode: 0 });
  const fleet = buildFleet({ links: 4, hotRatio: 0.5, hotTxCount: 3, programId: program, seed: 11 });
  chain.setFleet(fleet);
  const accounts = (chain as unknown as { accounts: Map<string, unknown> }).accounts;
  for (const link of fleet) {
    if (link.index % 2 === 1) {
      accounts.set(link.vault.toBase58(), {
        data: vaultBytes({ owner: benchKey(`owner:${link.index}`), skimMode: 1, skimBps: 2_000, volumeBps: 200 }),
        owner: program,
        lamports: rentExempt(VAULT_SPACE),
        executable: false,
      });
    }
  }
  return { chain, fleet };
}

/** The chain's heights, the test's to move. */
class Heights {
  confirmed = HEIGHT_START;
  #timer: ReturnType<typeof setInterval> | null = null;
  get finalized(): number {
    return this.confirmed - FINALITY_GAP;
  }
  start(): void {
    this.#timer = setInterval(() => (this.confirmed += 1), 100);
  }
  jumpTo(confirmed: number): void {
    this.confirmed = Math.max(this.confirmed, confirmed);
  }
  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
  }
}

interface Call {
  readonly path: string;
  readonly method: string;
  readonly params: string;
}

/**
 * The stub served on the loopback, one path per process (/sched, /worker-a,
 * /worker-b, /handover) so each process's requests can be told apart. Heights
 * are answered here. THE FREEZE: the first worker path to ask the CONFIRMED
 * height — which a worker asks only to resolve an intent it has just gated —
 * gets no answer from then on, for that question.
 */
class RpcStub {
  readonly calls: Call[] = [];
  readonly heights = new Heights();
  readonly chain = mixedChain().chain;
  frozen: string | null = null;
  #held: ServerResponse[] = [];
  #server: Server | null = null;
  port = 0;

  async listen(): Promise<void> {
    this.#server = createServer((request, response) => void this.#serve(request, response));
    await new Promise<void>((done) => this.#server!.listen(0, "127.0.0.1", done));
    this.port = (this.#server.address() as { port: number }).port;
    this.heights.start();
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}/${path}`;
  }

  async close(): Promise<void> {
    this.heights.stop();
    for (const response of this.#held) response.destroy();
    this.#server?.closeAllConnections();
    await new Promise<void>((done) => (this.#server === null ? done() : this.#server.close(() => done())));
  }

  async #serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? "/").replace(/^\//, "");
    const payload = JSON.parse(await body(request)) as unknown;
    let freeze = false;
    const answer = (one: unknown): unknown => {
      const call = one as { id?: unknown; method?: unknown; params?: unknown };
      const method = String(call.method);
      const params = Array.isArray(call.params) ? (call.params as unknown[]) : [];
      this.calls.push({ path, method, params: JSON.stringify(params) });
      if (method === "getBlockHeight") {
        const commitment = (params[0] as { commitment?: unknown } | undefined)?.commitment ?? "finalized";
        if (commitment === "confirmed" && path.startsWith("worker-")) {
          this.frozen ??= path;
          if (this.frozen === path) freeze = true;
        }
        return { jsonrpc: "2.0", id: call.id ?? null, result: commitment === "finalized" ? this.heights.finalized : this.heights.confirmed };
      }
      if (method === "getEpochInfo") {
        // THE PLAN FLOOR'S ONE ANSWER (TakeoverChain.finalizedPoint): the stub's epoch and slot, at the test's heights.
        const commitment = (params[0] as { commitment?: unknown } | undefined)?.commitment ?? "finalized";
        const stub = this.chain.handle(method, params).result as Record<string, unknown>;
        return { jsonrpc: "2.0", id: call.id ?? null, result: { ...stub, blockHeight: commitment === "finalized" ? this.heights.finalized : this.heights.confirmed } };
      }
      const result = this.chain.handle(method, params);
      return result.error === undefined ? { jsonrpc: "2.0", id: call.id ?? null, result: result.result ?? null } : { jsonrpc: "2.0", id: call.id ?? null, error: result.error };
    };
    const out = Array.isArray(payload) ? payload.map(answer) : answer(payload);
    if (freeze) {
      this.#held.push(response);
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(out));
  }
}

/** A child process of the package, `env -i`, offline but for the loopback: ONE process, so a SIGKILL kills the worker. */
class Child {
  log = "";
  exited: number | null = null;
  readonly #child: ChildProcess;

  constructor(
    readonly name: string,
    entry: string,
    env: Record<string, string>,
    args: readonly string[] = [],
  ) {
    this.#child = spawn(
      "/usr/bin/env",
      [
        "-i",
        `PATH=${dirname(process.execPath)}:/usr/bin:/bin`,
        `HOME=${process.env["HOME"] ?? "/tmp"}`,
        ...Object.entries(env).map(([name, value]) => `${name}=${value}`),
        // NODE ITSELF, with tsx as a loader: the tsx CLI runs the script in a
        // child of its own and relays SIGTERM, but nothing can relay SIGKILL —
        // a killed `tsx` would leave the worker running, beating its leases.
        process.execPath,
        "--import",
        "tsx",
        "--import",
        resolve(KEEPER_DIR, "scripts/bench-offline.mts"),
        entry,
        ...args,
      ],
      { cwd: KEEPER_DIR, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.#child.stdout!.on("data", (chunk: Buffer) => (this.log += chunk.toString("utf8")));
    this.#child.stderr!.on("data", (chunk: Buffer) => (this.log += chunk.toString("utf8")));
    this.#child.on("exit", (code, signal) => (this.exited = code ?? (signal === "SIGKILL" ? 137 : -1)));
  }

  kill(signal: NodeJS.Signals): void {
    if (this.exited === null) this.#child.kill(signal);
  }

  async exit(timeoutMs = 30_000): Promise<number> {
    const started = Date.now();
    while (this.exited === null && Date.now() - started < timeoutMs) await sleep(100);
    if (this.exited === null) throw new Error(`${this.name} did not exit within ${timeoutMs} ms:\n${this.log.slice(-3_000)}`);
    return this.exited;
  }

  tail(): string {
    return `── ${this.name} (exit ${this.exited ?? "running"}) ──\n${this.log.slice(-2_500)}`;
  }
}

describe.skipIf(!usable)("the dispatcher end to end, shadow world (needs KEEPER_TEST_PG_URL on the loopback)", () => {
  const database = `keeper_dispatch_e2e_${process.pid}_${Date.now()}`;
  let admin: pg.Pool;
  let db: pg.Pool;
  let databaseUrl: string;
  const rpc = new RpcStub();
  const children: Child[] = [];
  const { fleet } = mixedChain();
  const vaults = fleet.map((link) => link.vault.toBase58()).sort();

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL_RAW!, max: 1 });
    admin.on("error", () => undefined);
    await admin.query(`CREATE DATABASE ${database}`);
    const parsed = new URL(URL_RAW!);
    parsed.pathname = `/${database}`;
    parsed.searchParams.set("sslmode", "disable");
    databaseUrl = parsed.toString();
    db = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    db.on("error", () => undefined);
    await db.query(SCHEMA_SQL);
    await rpc.listen();
  });

  afterAll(async () => {
    for (const child of children) child.kill("SIGKILL");
    await rpc.close();
    await db?.end().catch(() => undefined);
    if (admin !== undefined) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  });

  const shared = (path: string): Record<string, string> => ({
    SIP_SOLANA_RPC_URLS: rpc.url(path),
    SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
    DATABASE_URL: databaseUrl,
    SIP_SOLANA_DISPATCH: "shadow",
  });

  const start = (name: string, entry: string, env: Record<string, string>): Child => {
    const child = new Child(name, entry, env);
    children.push(child);
    return child;
  };

  /** The operator's command, to its end. */
  const handover = async (...args: string[]): Promise<{ code: number; log: string }> => {
    const child = new Child(`dispatch-handover ${args.join(" ")}`, "bin/dispatch-handover.mts", { SIP_SOLANA_RPC_URLS: rpc.url("handover"), DATABASE_URL: databaseUrl }, args);
    const code = await child.exit(60_000);
    return { code, log: child.log };
  };

  const query = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> => (await db.query<T>(text, values)).rows;

  const waitFor = async (what: string, test: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> => {
    const started = Date.now();
    for (;;) {
      if (await test()) return;
      const dead = children.find((child) => child.exited !== null && !child.name.startsWith("dispatch-handover") && !expectedExits.has(child.name));
      if (dead !== undefined) throw new Error(`${dead.name} exited ${dead.exited} while waiting for ${what}:\n${children.map((c) => c.tail()).join("\n")}`);
      if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}:\n${await snapshot()}\n${children.map((c) => c.tail()).join("\n")}`);
      await sleep(200);
    }
  };
  const expectedExits = new Set<string>();
  /** What the queue and the intents hold, for a failure's message. */
  const snapshot = async (): Promise<string> => {
    const work = await query(
      `SELECT vault_addr, system, holder, (lease_until < clock_timestamp()) AS lapsed, round(extract(epoch FROM due_at - clock_timestamp()))::int AS due_in_s,
              fence::text, attempts, parked_reason, last_outcome, last_holder, lane FROM ${S}.vault_work ORDER BY vault_addr`,
    );
    const intents = await query(`SELECT id::text, vault_addr, kind, fence::text, worker_id, state, plan_cleared_height::text, resolved_height::text, resolved_at FROM ${S}.send_intent ORDER BY id`);
    return `vault_work:\n${work.map((row) => JSON.stringify(row)).join("\n")}\nsend_intent:\n${intents.map((row) => JSON.stringify(row)).join("\n")}\nheights: confirmed ${rpc.heights.confirmed}, finalized ${rpc.heights.finalized}; frozen ${rpc.frozen}`;
  };

  it(
    "scheduler + two workers + the handover over one Postgres: discovery enrols draining, arm moves to the queue, jobs gate shadow intents and send nothing, and a worker killed mid-job is taken over without overlap",
    async () => {
      // ── 1. a shadow's database: new vaults go to the queue (through 'draining') ──
      const flag = await handover("new-vaults", "queue");
      expect(flag.code, flag.log).toBe(0);

      const scheduler = start("scheduler", "bin/scheduler.mts", { ...shared("sched"), SIP_SOLANA_SWEEP_MS: String(TICK_MS), PORT: String(await freePort()) });
      await waitFor("the scheduler's discovery", async () => (await query(`SELECT 1 FROM ${S}.vault_work`)).length === vaults.length);
      expect(await query(`SELECT vault_addr, system FROM ${S}.vault_work ORDER BY vault_addr`)).toEqual(vaults.map((vault_addr) => ({ vault_addr, system: "draining" })));
      expect(await query(`SELECT count(*)::int AS n FROM ${S}.keeper_link WHERE gone_at IS NULL`)).toEqual([{ n: fleet.length }]);
      // NOTHING DRAINING IS EVER MADE DUE OR CLAIMED: no worker runs yet, and none could take it.
      expect(await new DispatchStore(db, "probe").claim(4)).toEqual([]);

      // ── 2. the handover: arm records the height, then moves once 150 blocks are final ──
      const first = await handover("arm", "--all", "--roles=none", "--allow-dry");
      expect(first.code, first.log).toBe(1);
      const recorded = await query<{ h: string }>(`SELECT DISTINCT handover_height::text AS h FROM ${S}.vault_work`);
      expect(recorded).toHaveLength(1);
      rpc.heights.jumpTo(Number(recorded[0]!.h) + Number(HANDOVER_WAIT_BLOCKS) + FINALITY_GAP + 5);
      const second = await handover("arm", "--all", "--roles=none", "--allow-dry");
      expect(second.code, second.log).toBe(0);
      expect(await query(`SELECT DISTINCT system FROM ${S}.vault_work`)).toEqual([{ system: "queue" }]);
      expect(rpc.heights.finalized).toBeLessThan(STUB_LAST_VALID - 1_000);

      // ── 3. two workers, two slots each ──────────────────────────────────────────
      const workerA = start("worker-a", "bin/worker.mts", { ...shared("worker-a"), SIP_SOLANA_WORKER_SLOTS: "2" });
      const workerB = start("worker-b", "bin/worker.mts", { ...shared("worker-b"), SIP_SOLANA_WORKER_SLOTS: "2" });
      const byPath = new Map([
        ["worker-a", workerA],
        ["worker-b", workerB],
      ]);
      await waitFor("both workers' rows", async () => (await query(`SELECT 1 FROM ${S}.worker WHERE kind = 'worker'`)).length === 2);

      // THE FREEZE: the first worker to gate a send hangs resolving it, holding its vault with an open shadow intent.
      await waitFor("a worker frozen with an open shadow intent", async () => {
        if (rpc.frozen === null) return false;
        return (await query(`SELECT 1 FROM ${S}.send_intent WHERE resolved_at IS NULL`)).length > 0;
      });
      const victimPath = rpc.frozen!;
      const victim = byPath.get(victimPath)!;
      const survivor = victimPath === "worker-a" ? workerB : workerA;
      const [open] = await query<{ vault_addr: string; fence: string; worker_id: string; kind: string; state: string; last_valid_block_height: string }>(
        `SELECT vault_addr, fence::text, worker_id, kind, state, last_valid_block_height::text FROM ${S}.send_intent WHERE resolved_at IS NULL ORDER BY id LIMIT 1`,
      );
      expect(open).toMatchObject({ state: "shadow", last_valid_block_height: String(STUB_LAST_VALID) });
      const taken = open!.vault_addr;
      const victimId = open!.worker_id;
      expect(await query(`SELECT holder FROM ${S}.vault_work WHERE vault_addr = $1`, [taken])).toEqual([{ holder: victimId }]);

      // ── 4. THE TAKEOVER: the holder dies; its lease runs out ────────────────────
      expectedExits.add(victim.name);
      victim.kill("SIGKILL");
      expect(await victim.exit()).toBe(137);
      await db.query(`UPDATE ${S}.vault_work SET lease_until = clock_timestamp() - interval '1 second' WHERE holder = $1`, [victimId]);
      const survivorId = (await query<{ worker_id: string }>(`SELECT worker_id FROM ${S}.worker WHERE kind = 'worker' AND worker_id <> $1`, [victimId]))[0]!.worker_id;

      // THE SUCCESSOR WAITS: the intent can still land (finalized below its last valid height), so it plans nothing.
      await waitFor(
        "the survivor waiting out the open intent",
        async () =>
          (await query(`SELECT 1 FROM ${S}.vault_work WHERE vault_addr = $1 AND last_holder = $2 AND last_outcome = 'WAITING_INTENT'`, [taken, survivorId])).length > 0,
      );
      expect(await query(`SELECT count(*)::int AS n FROM ${S}.send_intent WHERE vault_addr = $1 AND worker_id = $2`, [taken, survivorId])).toEqual([{ n: 0 }]);
      expect(await query(`SELECT resolved_at FROM ${S}.send_intent WHERE vault_addr = $1 AND worker_id = $2`, [taken, victimId])).toEqual([{ resolved_at: null }]);

      // TIME PASSES: the finalized height goes past the intent's last valid height, and the survivor goes on.
      rpc.heights.jumpTo(STUB_LAST_VALID + FINALITY_GAP + 50);
      await waitFor(
        "the survivor's own gate on the taken vault",
        async () => (await query(`SELECT 1 FROM ${S}.send_intent WHERE vault_addr = $1 AND worker_id = $2`, [taken, survivorId])).length > 0,
        90_000,
      );
      const after = await query<{ worker_id: string; fence: string; state: string; plan_cleared_height: string | null; resolved_at: Date | null }>(
        `SELECT worker_id, fence::text, state, plan_cleared_height::text, resolved_at FROM ${S}.send_intent WHERE vault_addr = $1 ORDER BY id`,
        [taken],
      );
      const victims = after.filter((row) => row.worker_id === victimId);
      const successors = after.filter((row) => row.worker_id === survivorId);
      // THE VICTIM'S INTENT IS OVER (expired at its height, still a shadow row), and every successor's plan cleared it.
      expect(victims.every((row) => row.state === "shadow" && row.resolved_at !== null)).toBe(true);
      expect(successors.length).toBeGreaterThan(0);
      for (const row of successors) {
        expect(BigInt(row.fence)).toBeGreaterThan(BigInt(open!.fence));
        expect(row.state).toBe("shadow");
        expect(BigInt(row.plan_cleared_height ?? "-1")).toBeGreaterThanOrEqual(BigInt(STUB_LAST_VALID));
      }

      // ── every vault turned, nothing sent, no overlap ────────────────────────────
      await waitFor(
        "every vault completed by a job",
        async () => (await query(`SELECT 1 FROM ${S}.vault_work WHERE last_outcome IS NOT NULL AND last_holder IS NOT NULL`)).length === vaults.length,
      );
      expect(await new DispatchStore(db, "auditor").overlapAudit()).toEqual([]);
      expect(await query(`SELECT DISTINCT state FROM ${S}.send_intent`)).toEqual([{ state: "shadow" }]);
      expect(rpc.calls.filter((call) => call.method === "sendTransaction" || call.method === "sendRawTransaction")).toEqual([]);
      // EACH VAULT SETTLED BY THE MODULE OF ITS OWN MODE: the PROFIT hot vault gated its would-be settle; the
      // VOLUME hot one answered what the legacy volume keeper answers on this fleet (NO_PROFIT: the bench's
      // transactions carry no venue volume to charge), and gated nothing.
      const [hotProfit, hotVolume] = [fleet.find((l) => l.txAbove > 0 && l.index % 2 === 0)!, fleet.find((l) => l.txAbove > 0 && l.index % 2 === 1)!];
      const settled = (await query<{ vault_addr: string }>(`SELECT DISTINCT vault_addr FROM ${S}.send_intent WHERE kind = 'settle'`)).map((row) => row.vault_addr);
      expect(settled).toEqual([hotProfit.vault.toBase58()]);
      expect((await query<{ last_outcome: string }>(`SELECT last_outcome FROM ${S}.vault_work WHERE vault_addr = $1`, [hotVolume.vault.toBase58()]))[0]!.last_outcome).toMatch(/^settle NO_PROFIT/);
      await waitFor("a job of each module in the workers' logs", async () => /"module":"PROFIT"/.test(workerA.log + workerB.log) && /"module":"VOLUME"/.test(workerA.log + workerB.log));

      // THE SCHEDULER HANDED THE SURVIVOR ITS QUOTA, and its rows are the fleet's.
      await waitFor("the survivor's quota", async () => (await query(`SELECT 1 FROM ${S}.worker WHERE worker_id = $1 AND quota_at IS NOT NULL`, [survivorId])).length > 0);
      expect(await query(`SELECT count(*)::int AS n FROM ${S}.worker WHERE kind = 'scheduler'`)).toEqual([{ n: 1 }]);
      expect((await query<{ scheduler_id: string | null }>(`SELECT scheduler_id FROM ${S}.fleet`))[0]!.scheduler_id).toMatch(/^scheduler-/);
      // EVERY PROCESS SPOKE ONLY ON ITS OWN PATH, and the scheduler listed the program.
      expect(new Set(rpc.calls.map((call) => call.path))).toEqual(new Set(["sched", "handover", "worker-a", "worker-b"]));
      expect(rpc.calls.some((call) => call.path === "sched" && call.method.startsWith("getProgramAccounts"))).toBe(true);

      // ── 5. SIGTERM: the survivor and the scheduler stop cleanly ─────────────────
      expectedExits.add(survivor.name);
      expectedExits.add(scheduler.name);
      survivor.kill("SIGTERM");
      expect(await survivor.exit(), survivor.tail()).toBe(0);
      expect(await query(`SELECT count(*)::int AS n FROM ${S}.vault_work WHERE holder = $1`, [survivorId])).toEqual([{ n: 0 }]);
      expect(await query(`SELECT stopped_at IS NOT NULL AS stopped FROM ${S}.worker WHERE worker_id = $1`, [survivorId])).toEqual([{ stopped: true }]);
      scheduler.kill("SIGTERM");
      expect(await scheduler.exit(), scheduler.tail()).toBe(0);
    },
    240_000,
  );
});
