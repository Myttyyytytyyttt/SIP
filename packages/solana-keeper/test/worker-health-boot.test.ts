// THE WORKER'S DEPLOY GATE IN THE REAL PROCESS (src/worker-health.ts):
// bin/worker.mts itself, in a child process.
//
// THE PROPERTY THE GATE EXISTS FOR: a configuration the worker refuses never
// answers on PORT at all, so a Railway deploy of it cannot pass its healthcheck
// and the worker before it keeps serving. Each way out the worker takes before
// it listens — readWorkerSettings (SIP_SOLANA_EXTRA_MODES_VAULTS left behind
// without SIP_SOLANA_EXTRA_MODES), SIP_SOLANA_DISPATCH unset, loadConfig,
// workerRefusals and, with a database, the price tape's columns — exits with
// its usual code, and test/listen-tripwire.ts writes down the child's every
// listen() BEFORE it runs: an empty file is "it never listened", whatever a
// probe from outside could have missed. The tripwire is shown seeing a listen
// that does happen, so an empty file is not a tripwire that saw nothing. So a
// refused worker is handed a fixed PORT that nothing binds: a listen would be
// written down before its bind, whatever held the port.
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
// not a beat), 200 once a claim answers, and 503 from SIGTERM: the test holds
// the worker's row, so the shutdown waits at closing it — for up to the store's
// 5 s statement timeout (DISPATCH_STATEMENT_TIMEOUT_MS), and then exits 0
// anyway — and the 503 is read inside that wait. That the 503 comes before the
// DRAIN is the code's order (the shutdown's first line, bin/worker.mts), not
// this test's: with no job in flight the drain takes no time. A worker whose
// PORT is taken exits 1 before it writes its row; one without PORT listens on
// nothing, from its first line to its exit.
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

afterAll(() => {
  for (const child of children) child.kill("SIGKILL");
  rmSync(scratch, { recursive: true, force: true });
});

describe("a configuration the worker refuses never listens on PORT", () => {
  const cases = [
    {
      way: "readWorkerSettings: SIP_SOLANA_EXTRA_MODES_VAULTS left without SIP_SOLANA_EXTRA_MODES, DISPATCH unset",
      env: { SIP_SOLANA_EXTRA_MODES_VAULTS: "*" },
      code: 2,
      says: "SIP_SOLANA_EXTRA_MODES_VAULTS set without SIP_SOLANA_EXTRA_MODES",
    },
    { way: "SIP_SOLANA_DISPATCH unset, which is off", env: {}, code: 0, says: "SIP_SOLANA_DISPATCH is off" },
    { way: "loadConfig: no endpoint and no program", env: { SIP_SOLANA_DISPATCH: "shadow" }, code: 2, says: "SIP_SOLANA_RPC_URLS is required" },
    {
      way: "workerRefusals: no DATABASE_URL",
      env: { SIP_SOLANA_DISPATCH: "shadow", SIP_SOLANA_RPC_URLS: DEAD_RPC, SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID },
      code: 2,
      says: "DATABASE_URL is required for a dispatcher worker",
    },
  ] as const;

  it.each(cases)("$way: exits with its usual code, and nothing ever listened", async ({ env, code, says }) => {
    const worker = start({ ...env, PORT: REFUSED_PORT });
    expect(await worker.exit(), worker.log).toBe(code);
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
      const worker = start({
        SIP_SOLANA_DISPATCH: "shadow",
        SIP_SOLANA_RPC_URLS: DEAD_RPC,
        SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
        DATABASE_URL: `postgres://worker:unused@127.0.0.1:${database}/sip?sslmode=disable`,
        PORT: String(port),
      });
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
  let admin: pg.Pool;
  let db: pg.Pool;
  let databaseUrl: string;
  let bareUrl: string;

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
    databaseUrl = urlOf(database);
    bareUrl = urlOf(bare);
    db = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    db.on("error", () => undefined);
    await db.query(SCHEMA_SQL);
  });

  afterAll(async () => {
    for (const child of children) child.kill("SIGKILL");
    await db?.end().catch(() => undefined);
    if (admin !== undefined) {
      for (const name of [database, bare]) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await db.query("TRUNCATE sip_solana.worker");
  });

  /** A shadow worker's environment; PORT only when given one. */
  const shadow = (url: string, port?: number): Record<string, string> => ({
    SIP_SOLANA_DISPATCH: "shadow",
    SIP_SOLANA_RPC_URLS: DEAD_RPC,
    SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
    DATABASE_URL: url,
    ...(port === undefined ? {} : { PORT: String(port) }),
  });

  const workerRows = async (): Promise<{ worker_id: string; stopped_at: Date | null }[]> =>
    (await db.query<{ worker_id: string; stopped_at: Date | null }>("SELECT worker_id, stopped_at FROM sip_solana.worker WHERE kind = 'worker'")).rows;

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

  it("refuses roundup over a database without the price tape's table: exit 2, and nothing ever listened", async () => {
    const port = await freePort();
    const worker = start({ ...shadow(bareUrl, port), SIP_SOLANA_EXTRA_MODES: "roundup", SIP_SOLANA_EXTRA_MODES_VAULTS: "*" });
    expect(await worker.exit(), worker.log).toBe(2);
    expect(worker.log).toContain("the price tape's table is not in this database");
    expect(worker.listened(), worker.log).toEqual([]);
  }, 2 * WAIT_MS);

  it("exits 1 when its PORT is taken — the deploy fails and says why — and writes no row", async () => {
    const holder = createSocketServer();
    await new Promise<void>((done) => holder.listen(0, done));
    const port = (holder.address() as { port: number }).port;
    try {
      const worker = start(shadow(databaseUrl, port));
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

  it("answers 503 while registered and its claims fail, 200 once a claim answers, and 503 from SIGTERM until it exits 0", async () => {
    const port = await freePort();
    // THE QUEUE HELD: while this transaction holds vault_work, every claim waits
    // for the lock, fails at its statement timeout (DISPATCH_STATEMENT_TIMEOUT_MS)
    // and is tried again CLAIM_IDLE_MS later. TWO FAILED ARE PAST THE FIRST
    // HEARTBEAT (HEARTBEAT_EVERY_MS from the loop's start), whose beat writes only
    // the worker's row: still 503 there is ready on a claim that ANSWERED, not on
    // one that failed, not on a beat, not on a shorter timer.
    const worker = await holding("LOCK TABLE sip_solana.vault_work IN EXCLUSIVE MODE", [], async () => {
      const child = start(shadow(databaseUrl, port));
      await until("the worker's row", child, async () => ((await workerRows()).length === 1 ? true : null));
      await until("two claims to fail behind the lock", child, async () =>
        child.log.split('"event":"the claim failed; trying again shortly"').length - 1 >= 2 ? true : null,
      );
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
    expect(await probe(port, "HEAD")).toEqual({ status: 200, body: null });
    expect((await fetch(`http://127.0.0.1:${port}/status`)).status).toBe(404);

    // SIGTERM WITH THE WORKER'S ROW HELD: the shutdown turns /health 503 at its
    // first line, then waits at closing the row — for up to the store's 5 s
    // statement timeout (DISPATCH_STATEMENT_TIMEOUT_MS), after which it exits 0
    // anyway — so the 503 is read inside that wait, before the exit.
    const stopping = await holding("SELECT 1 FROM sip_solana.worker WHERE worker_id = $1 FOR UPDATE", [rows[0]!.worker_id], async () => {
      worker.kill("SIGTERM");
      return await until("/health to answer 503 after SIGTERM", worker, async () => {
        const reply = await probe(port);
        return reply !== null && reply.status === 503 ? reply : null;
      });
    });
    expect(stopping.body).toMatchObject({ ok: false, phase: "stopping", role: "worker" });
    expect(await worker.exit(), worker.log).toBe(0);
    expect(worker.log).toContain('"event":"worker stopped"');
    // ONE LISTEN, ON PORT: nothing else in the process ever listened.
    expect(worker.listened()).toEqual([[port]]);
  }, 3 * WAIT_MS);

  it("listens on nothing without PORT, as before: registered, beating, stopped, and not one listen", async () => {
    const worker = start(shadow(databaseUrl));
    // ITS FIRST BEAT IS ITS LOOP RUNNING (WorkerLoop.start sets the beat's timer),
    // and the SIGTERM handler is in place before the loop starts.
    await until("the worker's first beat", worker, async () => {
      const beat = await db.query<{ beat: boolean }>("SELECT heartbeat_at > started_at + interval '1 second' AS beat FROM sip_solana.worker WHERE kind = 'worker'");
      return beat.rows[0]?.beat === true ? true : null;
    });
    worker.kill("SIGTERM");
    expect(await worker.exit(), worker.log).toBe(0);
    expect(worker.log).toContain('"event":"worker stopped"');
    expect(worker.log).not.toContain("listening for /health");
    expect(worker.log).not.toContain('"event":"worker ready"');
    // NOT ONE LISTEN, from its first line to its exit.
    expect(worker.listened(), worker.log).toEqual([]);
  }, 2 * WAIT_MS);
});
