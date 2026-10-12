// THE REAL LEGACY KEEPER, WITH A VAULT ON THE QUEUE (dispatcher ADR §3.12, RT-4;
// §4.9 rows 12 and 20): bin/keeper.mts itself, in a child process, dry, against
// the bench's chain stub on the loopback (src/bench/chain-stub.ts, the stub the
// ceiling bench and the parity runs use) and a throwaway Postgres 16.
//
// A mixed fleet of six links: even ones PROFIT, odd ones VOLUME. One VOLUME vault
// is put on the queue; the other two VOLUME vaults stay with the legacy keepers,
// and they are the control — the profit keeper DOES turn a legacy VOLUME vault,
// to invest it, so the queue's vault being absent from every request is the
// selection's doing and not the fleet's shape.
//
// RUN ONLY WITH A THROWAWAY DATABASE ON THE LOOPBACK (KEEPER_TEST_PG_URL), as the
// other *-pg tests; without it the block is skipped. Nothing leaves the machine:
// the child runs with `env -i`, no key and no SIP_SOLANA_BROADCAST, and
// scripts/bench-offline.mts refuses any fetch that is not to the loopback.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BenchChain } from "../src/bench/chain-stub.js";
import { benchKey, buildFleet, rentExempt, VAULT_SPACE, vaultBytes, type BenchLink } from "../src/bench/fleet.js";
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
const SWEEP_MS = 5_000;
const SWEEPS = 2;

interface Run {
  readonly calls: readonly { readonly method: string; readonly params: string }[];
  readonly status: Record<string, unknown>;
  readonly log: string;
}

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

/** The mixed fleet of the parity runs: odd links' vaults are VOLUME. */
function mixedChain(): { chain: BenchChain; fleet: readonly BenchLink[] } {
  const PublicKeyCtor = benchKey("x").constructor as new (s: string) => BenchLink["vault"];
  const program = new PublicKeyCtor(SIP_PROGRAM_ID);
  const chain = new BenchChain({ programId: program, crank: benchKey("crank"), skimMode: 0 });
  const fleet = buildFleet({ links: 6, hotRatio: 2 / 6, hotTxCount: 3, programId: program, seed: 7 });
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

/** One dry keeper of `role` over the mixed fleet, until it has swept SWEEPS times and gone quiet. */
async function runKeeper(role: "profit" | "volume", databaseUrl: string): Promise<Run> {
  const { chain } = mixedChain();
  const calls: { method: string; params: string; at: number }[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const payload = JSON.parse(await body(request)) as unknown;
      const answer = (one: unknown): unknown => {
        const call = one as { id?: unknown; method?: unknown; params?: unknown };
        const params = Array.isArray(call.params) ? call.params : [];
        calls.push({ method: String(call.method), params: JSON.stringify(params), at: Date.now() });
        const result = chain.handle(String(call.method), params);
        return result.error === undefined ? { jsonrpc: "2.0", id: call.id ?? null, result: result.result ?? null } : { jsonrpc: "2.0", id: call.id ?? null, error: result.error };
      };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)));
    })();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const rpcPort = (server.address() as { port: number }).port;
  const statusPort = await freePort();
  const child = spawn(
    "/usr/bin/env",
    [
      "-i",
      `PATH=${dirname(process.execPath)}:/usr/bin:/bin`,
      `HOME=${process.env["HOME"] ?? "/tmp"}`,
      `SIP_SOLANA_RPC_URLS=http://127.0.0.1:${rpcPort}`,
      `SIP_SOLANA_PROGRAM_ID=${SIP_PROGRAM_ID}`,
      `SIP_SOLANA_SWEEP_MS=${SWEEP_MS}`,
      `PORT=${statusPort}`,
      `SIP_SOLANA_ROLE=${role}`,
      `DATABASE_URL=${databaseUrl}`,
      "SIP_SOLANA_DISPATCH=on",
      "node_modules/.bin/tsx",
      "--import",
      resolve(KEEPER_DIR, "scripts/bench-offline.mts"),
      "bin/keeper.mts",
    ],
    { cwd: KEEPER_DIR, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout!.on("data", (chunk: Buffer) => (log += chunk.toString("utf8")));
  child.stderr!.on("data", (chunk: Buffer) => (log += chunk.toString("utf8")));
  let exited: number | null = null;
  child.on("exit", (code) => (exited = code ?? -1));
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const started = Date.now();
  let status: Record<string, unknown> | null = null;
  try {
    for (;;) {
      if (exited !== null) throw new Error(`the keeper exited ${exited} early:\n${log.slice(-3_000)}`);
      if (Date.now() - started > 90_000) throw new Error(`the keeper did not sweep ${SWEEPS} times in 90 s:\n${log.slice(-3_000)}`);
      try {
        const reply = await fetch(`http://127.0.0.1:${statusPort}/status`, { signal: AbortSignal.timeout(2_000) });
        if (reply.ok) {
          const page = (await reply.json()) as Record<string, unknown>;
          const last = calls[calls.length - 1]?.at ?? 0;
          if (typeof page["sweeps"] === "number" && page["sweeps"] >= SWEEPS && page["lastSweepMs"] !== null && Date.now() - last > 1_000) {
            status = page;
            break;
          }
        }
      } catch {
        // not listening yet
      }
      await sleep(200);
    }
  } finally {
    child.kill("SIGTERM");
    for (let i = 0; i < 50 && exited === null; i++) await sleep(100);
    if (exited === null) child.kill("SIGKILL");
    await new Promise<void>((done) => server.close(() => done()));
  }
  return { calls: calls.map(({ method, params }) => ({ method, params })), status, log };
}

describe.skipIf(!usable)("the real legacy keeper with a vault on the queue (needs KEEPER_TEST_PG_URL on the loopback)", () => {
  const database = `keeper_select_e2e_${process.pid}_${Date.now()}`;
  let admin: pg.Pool;
  let db: pg.Pool;
  let databaseUrl: string;
  const { fleet } = mixedChain();
  const queued = fleet[1]!;
  const legacyVolume = [fleet[3]!, fleet[5]!];
  const profitLinks = [fleet[0]!, fleet[2]!, fleet[4]!];

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
    // THE OWNER'S STEP: this one VOLUME vault is on the queue.
    await db.query("INSERT INTO sip_solana.vault_work (vault_addr, system, skim_mode) VALUES ($1, 'queue', 1)", [queued.vault.toBase58()]);
  });

  afterAll(async () => {
    await db?.end().catch(() => undefined);
    if (admin !== undefined) {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  });

  const mentions = (run: Run, address: string): readonly string[] => run.calls.filter((call) => call.params.includes(address)).map((call) => call.method);
  const wallets = (run: Run) => run.status["wallets"] as Record<string, { settle: string; invest: string; signing: string; detail: string }>;

  it(
    "L6a: a VOLUME vault on the queue is never invested by the legacy profit keeper — no request names it, and /status says why",
    async () => {
      const run = await runKeeper("profit", databaseUrl);
      // THE CONTROL: the legacy VOLUME vaults ARE turned by the profit keeper, which invests them.
      for (const link of legacyVolume) {
        expect(mentions(run, link.vault.toBase58()).length, `legacy VOLUME vault ${link.index}`).toBeGreaterThan(0);
        expect(wallets(run)[link.wallet.toBase58()]!.invest, `legacy VOLUME vault ${link.index}`).not.toBe("LEFT_ALONE");
      }
      for (const link of profitLinks) expect(mentions(run, link.vault.toBase58()).length).toBeGreaterThan(0);
      // THE QUEUE'S VAULT: not one request names it or its wallet, over every sweep.
      expect(mentions(run, queued.vault.toBase58())).toEqual([]);
      expect(mentions(run, queued.wallet.toBase58())).toEqual([]);
      expect(wallets(run)[queued.wallet.toBase58()]).toMatchObject({
        settle: "LEFT_ALONE",
        invest: "LEFT_ALONE",
        signing: "not resolved (left alone: queue)",
        detail: expect.stringContaining("the dispatcher's workers act on this vault"),
      });
      expect(run.status["dispatch"]).toMatchObject({
        mode: "on",
        consecutiveFailures: 0,
        absentVaultsAre: "legacy",
        notLegacy: { draining: 0, queue: 1 },
        leftAloneLastSweep: 1,
        leftAlone: [{ wallet: queued.wallet.toBase58(), vault: queued.vault.toBase58(), reason: "queue" }],
        carryOnlyInMemory: [],
      });
      expect(run.status["linksDiscovered"]).toBe(6);
      expect(run.status["linksTriaged"]).toBe(5);
      // ITS RECEIPT: the map it acted on, every sweep.
      const { rows } = await db.query("SELECT role, dispatch, live, reads, seen FROM sip_solana.legacy_process WHERE role = 'profit'");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ role: "profit", dispatch: "on", live: false, seen: { [queued.vault.toBase58()]: "queue" } });
      expect(Number(rows[0].reads)).toBeGreaterThanOrEqual(SWEEPS);
    },
    120_000,
  );

  it(
    "the legacy volume keeper leaves it alone too: it turns the other VOLUME links and never reads this one",
    async () => {
      const run = await runKeeper("volume", databaseUrl);
      for (const link of legacyVolume) expect(mentions(run, link.wallet.toBase58()).length, `legacy VOLUME link ${link.index}`).toBeGreaterThan(0);
      expect(mentions(run, queued.vault.toBase58())).toEqual([]);
      expect(mentions(run, queued.wallet.toBase58())).toEqual([]);
      expect(wallets(run)[queued.wallet.toBase58()]).toMatchObject({ settle: "LEFT_ALONE", invest: "LEFT_ALONE" });
      const { rows } = await db.query("SELECT role, seen FROM sip_solana.legacy_process WHERE role = 'volume'");
      expect(rows).toEqual([{ role: "volume", seen: { [queued.vault.toBase58()]: "queue" } }]);
    },
    120_000,
  );
});
