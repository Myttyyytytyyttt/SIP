// THE WORKER'S DEPLOY GATE IN THE REAL PROCESS (src/worker-health.ts):
// bin/worker.mts itself, in a child process.
//
// THE GATE IS OPT-IN: SIP_SOLANA_WORKER_HEALTH=on (src/worker-config.ts). Every
// worker in production has a PORT — the image bakes 8080 and Railway injects its
// own — so a worker without the gate is shown here WITH a PORT, and listens on
// nothing all the same: its two off exits, and a worker that registers, beats
// and stops over a real database.
//
// THE PROPERTY THE GATE EXISTS FOR: a configuration the worker refuses never
// answers on PORT at all, so a Railway deploy of it cannot pass its healthcheck
// and the worker before it keeps serving. Each way out the worker takes before
// it listens — readWorkerSettings (SIP_SOLANA_EXTRA_MODES_VAULTS left behind
// without SIP_SOLANA_EXTRA_MODES; and the gate's own: H1 a value that is not on
// or off, H2 no valid PORT, H3 SIP_SOLANA_DISPATCH unset or empty), loadConfig,
// workerRefusals and, with a database, the price tape's columns — exits 2, and
// test/listen-tripwire.ts writes down the child's every listen() BEFORE it runs:
// an empty file is "it never listened", whatever a probe from outside could have
// missed. The tripwire is shown seeing a listen that does happen, so an empty
// file is not a tripwire that saw nothing. So a refused worker is handed the
// gate and a fixed PORT that nothing binds (H1 and H2 aside, which are about
// those two): a listen would be written down before its bind, whatever held
// the port.
//
// OFF BEHIND THE GATE: SIP_SOLANA_DISPATCH=off written out, with the gate on,
// and no database, no endpoint and no program — loadConfig would refuse the
// last two, so it is never called. It listens once, answers 200 'off', and
// exits 0 on SIGTERM or SIGINT; a PORT it cannot have exits 1.
//
// THE ONE BOOT FAILURE AFTER IT LISTENS, with no database either: a "database"
// that takes the connection and never answers holds the worker at writing its
// row, listening and 503 starting, until the pool's connection timeout throws
// into the trap; it exits 1 having never answered 200.
//
// AND THE OTHER SIDE, WITH A DATABASE: a shadow worker over an empty queue
// answers 503 starting while its row is registered and its claims cannot answer
// (the test holds vault_work locked until two have failed, which is past its
// first heartbeat: ready is the first claim that ANSWERS — not one that failed,
// not a beat), and 200 once a claim answers. Then it claims a vault whose job
// waits at its first chain read, on an "endpoint" that takes the request and
// never answers until the test lets it go, and SIGTERM finds its drain waiting
// on that job: /health says 503, and its row leaves the quota hand-out —
// stopped_at set, LIVE_WORKERS_SQL no longer naming it — while the vault is
// still its own; let go, the job ends, the vault is handed back, the row is
// closed and it exits 0. THIS CASE USED TO HOLD THE WORKER'S ROW to read the 503
// inside a wait. The leave is an UPDATE of that same row, so a held row holds
// it too, and nothing could be read of it before the exit; the drain's own wait
// is where it is read now. The held row is a case of its own: held through the
// whole shutdown, the leave and the close wait on it side by side
// (pg_stat_activity shows both), each fails at the store's 5 s statement
// timeout (DISPATCH_STATEMENT_TIMEOUT_MS) as a log line, and the worker exits 0
// at one timeout, not two. And WITHOUT THE GATE a worker draining the same kind
// of job leaves its row in the hand-out until the close, as before the gate. A
// claim whose STATEMENT ERRORS is no answer either: with vault_work renamed
// away once the worker is past its boot — in a database of that test's own,
// which no other test opens — it says 503 for as long as its claims fail, and
// 200 once the table is back. A worker whose PORT is taken exits 1 before it
// writes its row.
//
// No tight timing: every wait polls, with a minute to spare (cde9180).
//
// Every child runs with `env -i` and scripts/bench-offline.mts, as
// test/dispatcher-e2e.test.ts's: no key, no SIP_SOLANA_BROADCAST, nothing off
// the loopback. The database half runs only with KEEPER_TEST_PG_URL on the
// loopback, as the other *-pg tests; without it that block is skipped.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createSocketServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Keypair } from "@solana/web3.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LIVE_WORKERS_SQL, WORKER_LEAVING_SQL, WORKER_STOPPED_SQL } from "../src/dispatch-store.js";
import { WORKER_DEAD_AFTER_MS } from "../src/fleet-status.js";
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
/** An endpoint on the loopback that nothing answers: a worker calls none before its first job, and the queue holds none. */
const DEAD_RPC = "http://127.0.0.1:9/";
/** How long any one wait may take: generous on purpose, a loaded image build is slow (cde9180). */
const WAIT_MS = 60_000;
/** The PORT a refused worker is handed: never bound unless it listens, and then written down before the bind. */
const REFUSED_PORT = "8080";
/** What a worker that is off without the gate says before it exits 0: today's line, word for word. */
const OFF_EXIT_LINE = "SIP_SOLANA_DISPATCH is off (unset is off): this worker claims nothing, opens no connection and exits";
/** What a worker that is off behind the gate says once it listens. */
const OFF_GATED_LINE = '"event":"SIP_SOLANA_DISPATCH is off: this worker claims nothing and opens no connection; it answers /health 200 (off) until it is stopped"';

/** The gate on, on `port`: what every worker here that could listen is handed. */
const gated = (port: number | string): Record<string, string> => ({ SIP_SOLANA_WORKER_HEALTH: "on", PORT: String(port) });
/** A shadow worker's endpoint and program, every one on the loopback or fixed: what loadConfig needs, and no database. */
const SHADOW_NO_DATABASE: Readonly<Record<string, string>> = { SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_RPC_URLS: DEAD_RPC, SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const scratch = mkdtempSync(join(tmpdir(), "sip-worker-health-"));
let files = 0;

async function freePort(): Promise<number> {
  return await new Promise((done, fail) => {
    const server = createSocketServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => done(port));
    });
  });
}

/** What /health answered, its body parsed (null for HEAD's none). */
type Reply = { status: number; body: Record<string, unknown> | null };

/** GET /health, parsed; null while nothing answers on the port. */
const probe = async (port: number, method = "GET"): Promise<Reply | null> => {
  try {
    const reply = await fetch(`http://127.0.0.1:${port}/health`, { method, signal: AbortSignal.timeout(5_000) });
    const text = await reply.text();
    return { status: reply.status, body: text === "" ? null : (JSON.parse(text) as Record<string, unknown>) };
  } catch {
    return null;
  }
};

/**
 * AN "ENDPOINT" THAT TAKES THE REQUEST AND NEVER ANSWERS, as the silent database
 * below, for RPC: a job's first chain read waits on it, so the job — and a drain
 * — lasts until letGo(), which refuses every new connection, cuts the ones it
 * holds and closes, and the read fails at once. letGo() can be called again.
 */
async function silentEndpoint(): Promise<{ readonly url: string; reached(): boolean; letGo(): Promise<void> }> {
  const sockets: Socket[] = [];
  let open = true;
  const server = createSocketServer((socket) => {
    socket.on("error", () => undefined);
    if (open) sockets.push(socket);
    else socket.destroy();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const port = (server.address() as { port: number }).port;
  let closed: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${port}/`,
    reached: () => sockets.length > 0,
    letGo: () => {
      open = false;
      closed ??= new Promise<void>((done) => {
        server.close(() => done());
        for (const socket of sockets) socket.destroy();
      });
      return closed;
    },
  };
}

/**
 * A child of the package, `env -i`, offline but for the loopback, every listen()
 * it calls written to its own file first. NODE ITSELF with tsx as a loader, as
 * test/dispatcher-e2e.test.ts starts its workers: one process, so a signal
 * reaches the worker and not a relay.
 */
class Child {
  log = "";
  exited: number | null = null;
  readonly #listens = join(scratch, `listens-${(files += 1)}.jsonl`);
  readonly #child: ChildProcess;

  constructor(env: Record<string, string>, main: readonly string[]) {
    this.#child = spawn(
      "/usr/bin/env",
      [
        "-i",
        `PATH=${dirname(process.execPath)}:/usr/bin:/bin`,
        `HOME=${process.env["HOME"] ?? "/tmp"}`,
        `KEEPER_TEST_LISTEN_LOG=${this.#listens}`,
        ...Object.entries(env).map(([name, value]) => `${name}=${value}`),
        process.execPath,
        "--import",
        "tsx",
        "--import",
        resolve(KEEPER_DIR, "scripts/bench-offline.mts"),
        "--import",
        resolve(KEEPER_DIR, "test/listen-tripwire.ts"),
        ...main,
      ],
      { cwd: KEEPER_DIR, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.#child.stdout!.on("data", (chunk: Buffer) => (this.log += chunk.toString("utf8")));
    this.#child.stderr!.on("data", (chunk: Buffer) => (this.log += chunk.toString("utf8")));
    this.#child.on("exit", (code, signal) => (this.exited = code ?? (signal === "SIGKILL" ? 137 : -1)));
  }

  /** What every listen() the child called was handed, callbacks left out: [] when it never called one. */
  listened(): unknown[][] {
    if (!existsSync(this.#listens)) return [];
    return readFileSync(this.#listens, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as unknown[]);
  }

  /** How many log lines carry every one of `parts`. */
  lines(...parts: readonly string[]): number {
    return this.log.split("\n").filter((line) => parts.every((part) => line.includes(part))).length;
  }

  kill(signal: NodeJS.Signals): void {
    if (this.exited === null) this.#child.kill(signal);
  }

  async exit(timeoutMs = WAIT_MS): Promise<number> {
    const started = Date.now();
    while (this.exited === null && Date.now() - started < timeoutMs) await sleep(50);
    if (this.exited === null) throw new Error(`the child did not exit within ${timeoutMs} ms:\n${this.log.slice(-3_000)}`);
    return this.exited;
  }
}

const children: Child[] = [];
const start = (env: Record<string, string>, main: readonly string[] = ["bin/worker.mts"]): Child => {
  const child = new Child(env, main);
  children.push(child);
  return child;
};

/** Polls `test` until it answers, failing at once if the worker exits first, and after WAIT_MS. */
const until = async <T>(what: string, worker: Child, test: () => Promise<T | null>): Promise<T> => {
  const started = Date.now();
  for (;;) {
    const got = await test();
    if (got !== null) return got;
    if (worker.exited !== null) throw new Error(`the worker exited ${worker.exited} while waiting for ${what}:\n${worker.log.slice(-3_000)}`);
    if (Date.now() - started > WAIT_MS) throw new Error(`timed out after ${WAIT_MS} ms waiting for ${what}:\n${worker.log.slice(-3_000)}`);
    await sleep(100);
  }
};

afterAll(() => {
  for (const child of children) child.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
});

describe("a configuration the worker refuses never listens, with the gate on", () => {
  const GATE = gated(REFUSED_PORT);
  const cases = [
    {
      way: "readWorkerSettings: SIP_SOLANA_EXTRA_MODES_VAULTS left without SIP_SOLANA_EXTRA_MODES",
      env: { ...GATE, SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_EXTRA_MODES_VAULTS: "*" },
      says: "SIP_SOLANA_EXTRA_MODES_VAULTS set without SIP_SOLANA_EXTRA_MODES",
    },
    {
      way: "H1: SIP_SOLANA_WORKER_HEALTH neither on nor off",
      env: { ...SHADOW_NO_DATABASE, SIP_SOLANA_WORKER_HEALTH: "yes", PORT: REFUSED_PORT },
      says: "SIP_SOLANA_WORKER_HEALTH must be on or off",
    },
    { way: "H2: the gate on, and no PORT", env: { ...SHADOW_NO_DATABASE, SIP_SOLANA_WORKER_HEALTH: "on" }, says: "and PORT is not set" },
    {
      way: "H2: the gate on, and a PORT that is not a number",
      env: { ...SHADOW_NO_DATABASE, SIP_SOLANA_WORKER_HEALTH: "on", PORT: "80a" },
      // THE GATE'S OWN WORDS, before loadConfig, which would refuse the same PORT later.
      says: "SIP_SOLANA_WORKER_HEALTH=on answers /health on PORT: PORT must be an integer from 1 to 65535",
    },
    { way: "H3: the gate on, and SIP_SOLANA_DISPATCH unset", env: { ...GATE }, says: "SIP_SOLANA_WORKER_HEALTH=on with SIP_SOLANA_DISPATCH unset or empty" },
    { way: "H3: the gate on, and SIP_SOLANA_DISPATCH empty", env: { ...GATE, SIP_SOLANA_DISPATCH: "" }, says: "SIP_SOLANA_WORKER_HEALTH=on with SIP_SOLANA_DISPATCH unset or empty" },
    { way: "loadConfig: no endpoint and no program", env: { ...GATE, SIP_SOLANA_DISPATCH: "shadow" }, says: "SIP_SOLANA_RPC_URLS is required" },
    { way: "workerRefusals: no DATABASE_URL", env: { ...GATE, ...SHADOW_NO_DATABASE }, says: "DATABASE_URL is required for a dispatcher worker" },
  ] as const;

  it.each(cases)("$way: exits 2, and nothing ever listened", async ({ env, says }) => {
    const worker = start(env);
    expect(await worker.exit(), worker.log).toBe(2);
    expect(worker.log).toContain('"event":"configuration refused"');
    expect(worker.log).toContain(says);
    expect(worker.listened(), worker.log).toEqual([]);
    expect(worker.log).not.toContain("listening for /health");
  }, 2 * WAIT_MS);

  it("the tripwire sees a listen that does happen, before the process can exit in the same tick", async () => {
    const control = start({}, ["--input-type=module", "-e", 'import { createServer } from "node:http"; createServer().listen(0); process.exit(7);']);
    expect(await control.exit(), control.log).toBe(7);
    expect(control.listened()).toEqual([[0]]);
  }, 2 * WAIT_MS);
});

describe("without the gate nothing listens, PORT or not", () => {
  it.each<{ way: string; env: Record<string, string> }>([
    { way: "SIP_SOLANA_DISPATCH unset, which is off", env: {} },
    { way: "SIP_SOLANA_DISPATCH=off written out, the gate written off", env: { SIP_SOLANA_DISPATCH: "off", SIP_SOLANA_WORKER_HEALTH: "off" } },
  ])("$way: exits 0 as before the gate, and nothing ever listened", async ({ env }) => {
    const worker = start({ ...env, PORT: REFUSED_PORT });
    expect(await worker.exit(), worker.log).toBe(0);
    expect(worker.log).toContain(OFF_EXIT_LINE);
    expect(worker.listened(), worker.log).toEqual([]);
    expect(worker.log).not.toContain("/health");
  }, 2 * WAIT_MS);
});

describe("off behind the gate: SIP_SOLANA_DISPATCH=off written out, with SIP_SOLANA_WORKER_HEALTH=on", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "with no database, endpoint or program, listens once, answers 200 off until %s, and exits 0",
    async (signal) => {
      const port = await freePort();
      const worker = start({ SIP_SOLANA_DISPATCH: "off", ...gated(port) });
      const off = await until("/health to answer", worker, () => probe(port));
      expect(off).toEqual({ status: 200, body: { ok: true, phase: "off", role: "worker", version: "local", startedAt: expect.any(String), slots: 2 } });
      expect(Date.parse(String(off.body?.["startedAt"]))).not.toBeNaN();
      expect(await probe(port, "HEAD")).toEqual({ status: 200, body: null });
      expect((await fetch(`http://127.0.0.1:${port}/status`)).status).toBe(404);
      // ONE LINE, AND NOTHING PAST IT: loadConfig would have refused (no
      // endpoint, no program), and there is no row, no banner, no loop.
      expect(worker.lines(OFF_GATED_LINE), worker.log).toBe(1);
      expect(worker.log).not.toContain(OFF_EXIT_LINE);
      expect(worker.log).not.toContain("configuration refused");
      expect(worker.log).not.toContain('"event":"worker starting"');
      // IT WAITS: still there, still 200, until the signal.
      expect(worker.exited).toBeNull();
      expect(await probe(port)).toMatchObject({ status: 200, body: { phase: "off" } });

      worker.kill(signal);
      expect(await worker.exit(), worker.log).toBe(0);
      expect(worker.lines('"event":"worker stopped"', `"signal":"${signal}"`), worker.log).toBe(1);
      expect(worker.listened(), worker.log).toEqual([[port]]);
      // NOTHING TRIED TO LEAVE THE LOOPBACK: the offline guard says so only on the way out.
      expect(worker.log).not.toContain("non-loopback");
    },
    2 * WAIT_MS,
  );

  it("exits 1 when its PORT is taken, as a worker that serves does", async () => {
    const holder = createSocketServer();
    await new Promise<void>((done) => holder.listen(0, done));
    const port = (holder.address() as { port: number }).port;
    try {
      const worker = start({ SIP_SOLANA_DISPATCH: "off", ...gated(port) });
      expect(await worker.exit(), worker.log).toBe(1);
      expect(worker.log).toContain("worker: health server failed");
      expect(worker.log).toContain("EADDRINUSE");
      expect(worker.log).not.toContain(OFF_GATED_LINE);
      expect(worker.listened()).toEqual([[port]]);
    } finally {
      await new Promise<void>((done) => holder.close(() => done()));
    }
  }, 2 * WAIT_MS);
});

describe("a worker that listens and then cannot write its row", () => {
  it("exits 1 through the trap, having listened once, on PORT, and never answered 200", async () => {
    // A "DATABASE" THAT TAKES THE CONNECTION AND NEVER ANSWERS: past every
    // refusal the worker listens, then waits at registering its row until the
    // pool's connection timeout (DISPATCH_STATEMENT_TIMEOUT_MS) throws into the
    // uncaughtException trap. Whatever /health said while it waited, never 200.
    const held: Socket[] = [];
    const silent = createSocketServer((socket) => {
      socket.on("error", () => undefined);
      held.push(socket);
    });
    await new Promise<void>((done) => silent.listen(0, "127.0.0.1", () => done()));
    const database = (silent.address() as { port: number }).port;
    const port = await freePort();
    try {
      const worker = start({ ...SHADOW_NO_DATABASE, DATABASE_URL: `postgres://worker:unused@127.0.0.1:${database}/sip?sslmode=disable`, ...gated(port) });
      const replies: Reply[] = [];
      const started = Date.now();
      while (worker.exited === null && Date.now() - started < WAIT_MS) {
        const reply = await probe(port);
        if (reply !== null) replies.push(reply);
        await sleep(100);
      }
      expect(await worker.exit(), worker.log).toBe(1);
      expect(worker.log).toContain('"event":"worker: listening for /health"');
      expect(worker.log).toContain('"event":"uncaught exception"');
      expect(worker.log).not.toContain('"event":"worker ready"');
      expect(worker.listened(), worker.log).toEqual([[port]]);
      for (const reply of replies) expect(reply, worker.log).toMatchObject({ status: 503, body: { ok: false, phase: "starting" } });
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((done) => silent.close(() => done()));
    }
  }, 2 * WAIT_MS);
});

describe.skipIf(!usable)("the worker's /health over a real database (needs KEEPER_TEST_PG_URL on the loopback)", () => {
  const database = `keeper_worker_health_${process.pid}_${Date.now()}`;
  const bare = `${database}_bare`;
  /** The claim-error test's own: the one whose vault_work is renamed away, so no other test ever opens it. */
  const away = `${database}_away`;
  let admin: pg.Pool;
  let db: pg.Pool;
  let awayDb: pg.Pool;
  let databaseUrl: string;
  let bareUrl: string;
  let awayUrl: string;

  const urlOf = (name: string): string => {
    const parsed = new URL(URL_RAW!);
    parsed.pathname = `/${name}`;
    parsed.searchParams.set("sslmode", "disable");
    return parsed.toString();
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL_RAW!, max: 1 });
    admin.on("error", () => undefined);
    await admin.query(`CREATE DATABASE ${database}`);
    // A DATABASE WITHOUT THE SCHEMA: a roundup worker refuses it, by the price tape's columns.
    await admin.query(`CREATE DATABASE ${bare}`);
    await admin.query(`CREATE DATABASE ${away}`);
    databaseUrl = urlOf(database);
    bareUrl = urlOf(bare);
    awayUrl = urlOf(away);
    db = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    db.on("error", () => undefined);
    await db.query(SCHEMA_SQL);
    awayDb = new pg.Pool({ connectionString: awayUrl, max: 2 });
    awayDb.on("error", () => undefined);
    await awayDb.query(SCHEMA_SQL);
  });

  afterAll(async () => {
    for (const child of children) child.kill("SIGKILL");
    await db?.end().catch(() => undefined);
    await awayDb?.end().catch(() => undefined);
    if (admin !== undefined) {
      for (const name of [database, bare, away]) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await db.query("TRUNCATE sip_solana.worker, sip_solana.vault_work");
  });

  /** A shadow worker's environment over `url`: no gate and no PORT, unless the test adds them. */
  const shadow = (url: string): Record<string, string> => ({ ...SHADOW_NO_DATABASE, DATABASE_URL: url });

  const workerRows = async (pool: pg.Pool = db): Promise<{ worker_id: string; stopped_at: Date | null; busy: number }[]> =>
    (await pool.query<{ worker_id: string; stopped_at: Date | null; busy: number }>("SELECT worker_id, stopped_at, busy FROM sip_solana.worker WHERE kind = 'worker'")).rows;

  /** The workers the scheduler's hand-out divides among now: its own statement. */
  const inHandOut = async (): Promise<string[]> =>
    (await db.query<{ worker_id: string }>(LIVE_WORKERS_SQL, [WORKER_DEAD_AFTER_MS / 1000])).rows.map((row) => row.worker_id);

  /** One vault on the queue, due now, for the next claim to take. */
  const queueVault = async (): Promise<string> => {
    const vault = Keypair.generate().publicKey.toBase58();
    await db.query("INSERT INTO sip_solana.vault_work (vault_addr, system) VALUES ($1, 'queue')", [vault]);
    return vault;
  };

  /** Who holds `vault`: a worker_id, or null. */
  const holderOf = async (vault: string): Promise<string | null> =>
    (await db.query<{ holder: string | null }>("SELECT holder FROM sip_solana.vault_work WHERE vault_addr = $1", [vault])).rows[0]?.holder ?? null;

  it("refuses roundup over a database without the price tape's table: exit 2, and nothing ever listened", async () => {
    const worker = start({ ...shadow(bareUrl), ...gated(REFUSED_PORT), SIP_SOLANA_EXTRA_MODES: "roundup", SIP_SOLANA_EXTRA_MODES_VAULTS: "*" });
    expect(await worker.exit(), worker.log).toBe(2);
    expect(worker.log).toContain("the price tape's table is not in this database");
    expect(worker.listened(), worker.log).toEqual([]);
  }, 2 * WAIT_MS);

  it("exits 1 when its PORT is taken — the deploy fails and says why — and writes no row", async () => {
    const holder = createSocketServer();
    await new Promise<void>((done) => holder.listen(0, done));
    const port = (holder.address() as { port: number }).port;
    try {
      const worker = start({ ...shadow(databaseUrl), ...gated(port) });
      expect(await worker.exit(), worker.log).toBe(1);
      expect(worker.log).toContain("worker: health server failed");
      expect(worker.log).toContain("EADDRINUSE");
      expect(worker.listened()).toEqual([[port]]);
      expect(await workerRows()).toEqual([]);
    } finally {
      await new Promise<void>((done) => holder.close(() => done()));
    }
  }, 2 * WAIT_MS);

  /** Runs `body` while one transaction holds what `sql` locks; the lock goes with the transaction, whatever `body` did. */
  const holding = async <T>(sql: string, values: unknown[], body: () => Promise<T>): Promise<T> => {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql, values);
      return await body();
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  };

  it("answers 503 while registered and its claims fail, 200 once a claim answers, and from SIGTERM 503 — out of the hand-out while its drain still holds a vault — until it exits 0", async () => {
    const port = await freePort();
    const endpoint = await silentEndpoint();
    try {
      // THE QUEUE HELD: while this transaction holds vault_work, every claim waits
      // for the lock, fails at its statement timeout (DISPATCH_STATEMENT_TIMEOUT_MS)
      // and is tried again CLAIM_IDLE_MS later. TWO FAILED ARE PAST THE FIRST
      // HEARTBEAT (HEARTBEAT_EVERY_MS from the loop's start), whose beat writes only
      // the worker's row: still 503 there is ready on a claim that ANSWERED, not on
      // one that failed, not on a beat, not on a shorter timer.
      const worker = await holding("LOCK TABLE sip_solana.vault_work IN EXCLUSIVE MODE", [], async () => {
        const child = start({ ...shadow(databaseUrl), SIP_SOLANA_RPC_URLS: endpoint.url, ...gated(port) });
        await until("the worker's row", child, async () => ((await workerRows()).length === 1 ? true : null));
        await until("two claims to fail behind the lock", child, async () => (child.lines('"event":"the claim failed; trying again shortly"') >= 2 ? true : null));
        for (let seen = 0; seen < 3; seen++) {
          const reply = await until("/health to answer", child, () => probe(port));
          expect(reply).toMatchObject({ status: 503, body: { ok: false, phase: "starting", role: "worker" } });
          await sleep(200);
        }
        expect(child.log).not.toContain('"event":"worker ready"');
        return child;
      });

      const ready = await until("/health to answer 200", worker, async () => {
        const reply = await probe(port);
        return reply !== null && reply.status === 200 ? reply : null;
      });
      expect(ready.body).toMatchObject({ ok: true, phase: "ready", role: "worker", version: "local", slots: 2 });
      expect(Date.parse(String(ready.body?.["startedAt"]))).not.toBeNaN();
      expect(worker.log).toContain('"event":"worker ready"');
      const rows = await workerRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.stopped_at).toBeNull();
      const workerId = rows[0]!.worker_id;
      expect(await inHandOut()).toEqual([workerId]);
      expect(await probe(port, "HEAD")).toEqual({ status: 200, body: null });
      expect((await fetch(`http://127.0.0.1:${port}/status`)).status).toBe(404);

      // A JOB THAT WAITS AT ITS FIRST CHAIN READ: the vault claimed, the endpoint reached.
      const vault = await queueVault();
      await until("its job to wait at its chain read", worker, async () => (endpoint.reached() && (await holderOf(vault)) === workerId ? true : null));

      // SIGTERM WITH ITS DRAIN WAITING ON THAT JOB: /health turns 503 at the
      // shutdown's first line, and the row leaves the quota hand-out while the
      // vault is still this worker's — beside the drain, not after it. Both are
      // read inside the drain's wait, which lasts until the test lets the job go.
      worker.kill("SIGTERM");
      const stopping = await until("/health to answer 503 after SIGTERM", worker, async () => {
        const reply = await probe(port);
        return reply !== null && reply.status === 503 ? reply : null;
      });
      expect(stopping.body).toMatchObject({ ok: false, phase: "stopping", role: "worker" });
      await until("its row to leave the hand-out", worker, async () => ((await workerRows())[0]?.stopped_at != null ? true : null));
      expect(await inHandOut()).toEqual([]);
      expect(await holderOf(vault)).toBe(workerId);
      expect(worker.exited).toBeNull();

      // LET GO: the read fails, the job ends, the vault is handed back, the row is closed (busy 0), exit 0.
      await endpoint.letGo();
      expect(await worker.exit(), worker.log).toBe(0);
      expect(worker.log).toContain('"event":"worker stopped"');
      expect(worker.log).not.toContain("could not leave the quota hand-out");
      expect(await holderOf(vault)).toBeNull();
      expect(await workerRows()).toEqual([{ worker_id: workerId, stopped_at: expect.any(Date), busy: 0 }]);
      // ONE LISTEN, ON PORT: nothing else in the process ever listened.
      expect(worker.listened()).toEqual([[port]]);
    } finally {
      await endpoint.letGo();
    }
  }, 3 * WAIT_MS);

  it("with its row held through the whole shutdown, the leave and the close wait on it side by side, each a log line when it times out, and it exits 0 at one statement timeout", async () => {
    const port = await freePort();
    const worker = start({ ...shadow(databaseUrl), ...gated(port) });
    await until("/health to answer 200", worker, async () => ((await probe(port))?.status === 200 ? true : null));
    const workerId = (await workerRows())[0]!.worker_id;
    // RIGHT AFTER A BEAT: the next is HEARTBEAT_EVERY_MS away, and the shutdown
    // stops the beat's timer long before it, so no beat can be waiting on the
    // held row with one of the worker's two connections — the one the close needs.
    const beatAt = async (): Promise<number> =>
      (await db.query<{ at: Date }>("SELECT heartbeat_at AS at FROM sip_solana.worker WHERE worker_id = $1", [workerId])).rows[0]!.at.getTime();
    const before = await beatAt();
    await until("a beat", worker, async () => ((await beatAt()) > before ? true : null));
    await holding("SELECT 1 FROM sip_solana.worker WHERE worker_id = $1 FOR UPDATE", [workerId], async () => {
      worker.kill("SIGTERM");
      // THE LEAVE IS AN UPDATE OF THIS ROW, AND THE CLOSE TOO. Side by side: the
      // close is sent while the leave still waits, so the two waits end together.
      await until("the leave and the close to wait on the held row together", worker, async () => {
        const waiting = (
          await db.query<{ query: string }>("SELECT query FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'")
        ).rows.map((row) => row.query);
        return waiting.includes(WORKER_LEAVING_SQL) && waiting.includes(WORKER_STOPPED_SQL) ? true : null;
      });
      expect(await probe(port)).toMatchObject({ status: 503, body: { ok: false, phase: "stopping" } });
      // HELD TO THE END: each times out into its own log line, and the worker exits 0 all the same.
      expect(await worker.exit(), worker.log).toBe(0);
    });
    expect(worker.lines('"event":"the worker could not leave the quota hand-out')).toBe(1);
    expect(worker.lines('"event":"the worker row could not be closed"')).toBe(1);
    expect(worker.lines('"event":"worker stopped"')).toBe(1);
    expect(worker.log).not.toContain('"event":"unhandled rejection"');
    // NOTHING LANDED WHILE THE ROW WAS HELD.
    expect(await workerRows()).toEqual([{ worker_id: workerId, stopped_at: null, busy: 0 }]);
    expect(worker.listened()).toEqual([[port]]);
  }, 3 * WAIT_MS);

  it("never answers 200 while its claim STATEMENT errors — vault_work renamed away past its boot — and answers 200 once the table is back", async () => {
    const port = await freePort();
    /** The claims that failed because the table was not there: an error, not a lock's timeout. */
    const missing = (worker: Child): number => worker.lines('"event":"the claim failed; trying again shortly"', "does not exist");
    const holder = await awayDb.connect();
    let renamed = false;
    try {
      // THE QUEUE HELD THROUGH THE BOOT, so that no claim can answer before the table goes.
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE sip_solana.vault_work IN EXCLUSIVE MODE");
      const worker = start({ ...shadow(awayUrl), ...gated(port) });
      // PAST ITS BOOT: every refusal, the listen, its row and its banner.
      await until("the worker's banner", worker, async () => (worker.lines('"event":"worker starting"') === 1 ? true : null));
      expect(await workerRows(awayDb)).toHaveLength(1);
      expect(worker.log).toContain('"event":"worker: listening for /health"');
      // THE TABLE GOES, in the transaction that holds it: the rename takes the
      // table's ACCESS EXCLUSIVE lock ahead of any claim waiting behind ours (or
      // once that claim's statement timeout has let it go), and from the commit
      // on, every claim finds no vault_work and errors at once.
      await holder.query("ALTER TABLE sip_solana.vault_work RENAME TO vault_work_away");
      renamed = true;
      await holder.query("COMMIT");

      const replies: Reply[] = [];
      await until("two claims to fail on the missing table", worker, async () => {
        const reply = await probe(port);
        if (reply !== null) replies.push(reply);
        return missing(worker) >= 2 ? true : null;
      });
      expect(replies.length, worker.log).toBeGreaterThan(0);
      for (const reply of replies) expect(reply, worker.log).toMatchObject({ status: 503, body: { ok: false, phase: "starting" } });
      expect(await probe(port)).toMatchObject({ status: 503, body: { ok: false, phase: "starting" } });
      expect(worker.log).not.toContain('"event":"worker ready"');

      // BACK: the next claim answers — nothing to hand over — and that is ready.
      await awayDb.query("ALTER TABLE sip_solana.vault_work_away RENAME TO vault_work");
      renamed = false;
      const ready = await until("/health to answer 200 once the table is back", worker, async () => {
        const reply = await probe(port);
        return reply !== null && reply.status === 200 ? reply : null;
      });
      expect(ready.body).toMatchObject({ ok: true, phase: "ready", role: "worker" });
      expect(worker.lines('"event":"worker ready"')).toBe(1);
      worker.kill("SIGTERM");
      expect(await worker.exit(), worker.log).toBe(0);
      expect(worker.listened()).toEqual([[port]]);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      if (renamed) await awayDb.query("ALTER TABLE sip_solana.vault_work_away RENAME TO vault_work").catch(() => undefined);
    }
  }, 3 * WAIT_MS);

  it("listens on nothing without the gate, PORT set or not: registered, beating, in the hand-out through its drain and closed after it — as before the gate — and not one listen", async () => {
    const endpoint = await silentEndpoint();
    try {
      const worker = start({ ...shadow(databaseUrl), SIP_SOLANA_RPC_URLS: endpoint.url, PORT: String(await freePort()) });
      // ITS FIRST BEAT IS ITS LOOP RUNNING (WorkerLoop.start sets the beat's timer),
      // and the SIGTERM handler is in place before the loop starts.
      await until("the worker's first beat", worker, async () => {
        const beat = await db.query<{ beat: boolean }>("SELECT heartbeat_at > started_at + interval '1 second' AS beat FROM sip_solana.worker WHERE kind = 'worker'");
        return beat.rows[0]?.beat === true ? true : null;
      });
      const workerId = (await workerRows())[0]!.worker_id;
      // A JOB THAT WAITS AT ITS FIRST CHAIN READ, so its drain lasts until the test lets it go.
      const vault = await queueVault();
      await until("its job to wait at its chain read", worker, async () => (endpoint.reached() && (await holderOf(vault)) === workerId ? true : null));
      worker.kill("SIGTERM");
      await until("its shutdown to start", worker, async () => (worker.lines('"event":"worker stopping"') === 1 ? true : null));
      // NO LEAVE WITHOUT THE GATE: through a second of its drain the row is not
      // stopped and the hand-out still names it, where a gated worker's leave
      // lands at once.
      for (let seen = 0; seen < 10; seen++) {
        expect((await workerRows())[0]!.stopped_at).toBeNull();
        expect(await inHandOut()).toEqual([workerId]);
        expect(await holderOf(vault)).toBe(workerId);
        await sleep(100);
      }
      await endpoint.letGo();
      expect(await worker.exit(), worker.log).toBe(0);
      expect(worker.log).toContain('"event":"worker stopped"');
      // CLOSED AFTER ITS DRAIN, as before the gate.
      expect(await holderOf(vault)).toBeNull();
      expect(await workerRows()).toEqual([{ worker_id: workerId, stopped_at: expect.any(Date), busy: 0 }]);
      expect(worker.log).not.toContain("listening for /health");
      expect(worker.log).not.toContain('"event":"worker ready"');
      // NOT ONE LISTEN, from its first line to its exit.
      expect(worker.listened(), worker.log).toEqual([]);
    } finally {
      await endpoint.letGo();
    }
  }, 2 * WAIT_MS);
});
