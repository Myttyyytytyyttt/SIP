// THE LOCAL SHADOW (plan §3.3.2, P3b): the dispatcher's real entry points run
// against MAINNET, READ-ONLY, beside production, and compared with it once a
// minute. Started by hand (test-local/shadow/README.md), never by a test run and
// never by an image: .dockerignore keeps test-local/ out of every build context.
//
//   node --import tsx test-local/shadow/harness.ts --out <dir> [--minutes 55]
//        [--drills worker-kill@10,worker-sigterm@17,scheduler-kill@24,pg-pause@31 | none]
//        [--drill-repeat-hours 0] [--proxy <census-proxy.mjs>] [--model <model.py>]
//        [--production <profit-url>,<volume-url> | none] [--cuts <tokens>]
//   node --import tsx test-local/shadow/harness.ts --analyze <dir> [--model <model.py>]
//
// WHAT IT STARTS, AND STOPS AGAIN (every one is in report.json's `stopped`):
//   * Postgres 16 in Docker, its own container (sip-shadow-pg-<hex>, `--rm`,
//     published on 127.0.0.1 only, trust auth: there is no password to hold),
//     the keeper's own sql/sip_solana.sql applied;
//   * THE CENSUS PROXY (census-proxy.mjs, disp-measure's measuring proxy) on the
//     loopback: the ONLY way out to the chain. It forwards to the public
//     https://api.mainnet-beta.solana.com and nothing else, REFUSES every send*
//     method and every websocket, and writes one line per JSON-RPC call — the
//     lines the listings and the credits are counted from;
//   * a RELAY in this process, in front of the proxy, one path per child process
//     (sched-a, worker-a, …) so the proxy's lines say who asked; the drills
//     freeze a path to hold a worker mid-job;
//   * TWO SCHEDULERS (bin/scheduler.mts; one takes sip-solana-scheduler, one
//     stands by) and TWO WORKERS of two slots (bin/worker.mts), all with
//     SIP_SOLANA_DISPATCH=shadow, started with `env -i` and only the variables
//     below — NO KEY of any kind, no broadcast flag, no Helius, Privy or Jupiter
//     key — and with scripts/bench-offline.mts preloaded, so a request to any
//     host but the loopback is refused inside the process (a would-be Jupiter
//     quote included);
//   * the operator's bin/dispatch-handover.mts, as P3b's database needs it:
//     `new-vaults queue`, then `arm --all --roles=none --allow-dry` until moved.
//
// WHAT IT MEASURES (src/shadow-compare.ts holds the arithmetic, tested):
//   * once a minute, production's public /status of both legacy keepers (a plain
//     GET), compared per wallet with the workers' newest jobs: agreement, and each
//     mismatch explained or not;
//   * the overlap audit over the 'shadow' intents, once a minute and at the end;
//   * discovery listings per minute, from the proxy's lines;
//   * credits: the proxy's method counts × the keeper's price table at archival 1
//     and 10, beside the cost model's prediction for the same token set when
//     --model names disp-measure's model.py;
//   * THE DRILLS, scripted in the window (plan §3.3.2's list):
//       worker-kill     freeze a worker's path until it holds a vault mid-job,
//                       SIGKILL it; the successor must wait the lease out, then
//                       take the vault with a higher fence and finish it;
//       worker-sigterm  the same hold, then SIGTERM: the drain runs out, the job is
//                       aborted, the vault RELEASED due now, the process exits 0,
//                       and the other worker takes the vault without the 45 s wait;
//       scheduler-kill  SIGKILL the lock holder: the standby takes the lock at its
//                       next tick, and that tick is a full pass;
//       pg-pause        `docker pause` the database for 20 s: nothing commits, and
//                       everything recovers by itself afterwards.
//     Each replaced process is restarted, so the fleet is whole again.
//
// It never prints an environment value. The only URLs it writes are its own
// loopback ones and production's public /status addresses.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, type WriteStream } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { OVERLAP_AUDIT_SQL } from "../../src/dispatch-store.js";
import { SIGTERM_DRAIN_MS } from "../../src/explicit-send.js";
import { SIP_PROGRAM_ID } from "../../src/idl.js";
import {
  agreementOf,
  compareAt,
  creditsOf,
  explainMismatches,
  foldShadowJobs,
  listingsPerMinute,
  perDay,
  productionDecisions,
  replayComparison,
  type CompareRow,
  type ProductionSample,
  type ProxyLine,
  type ShadowWallet,
  type WorkerLogLine,
} from "../../src/shadow-compare.js";

const KEEPER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCHEMA = resolve(KEEPER_DIR, "sql/sip_solana.sql");
const DEFAULT_PROXY = resolve(KEEPER_DIR, "test-local/shadow/census-proxy.mjs");
const DEFAULT_PRODUCTION = [
  "https://sip-solana-keeper-production.up.railway.app/status",
  "https://sip-solana-volume-keeper-production.up.railway.app/status",
];
const DEFAULT_DRILLS = "worker-kill@10,worker-sigterm@17,scheduler-kill@24,pg-pause@31";
const PG_PAUSE_MS = 20_000;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// ── arguments ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const ANALYZE = option("analyze");
const OUT = resolve(ANALYZE ?? option("out") ?? "");
if (ANALYZE === undefined && option("out") === undefined) {
  console.error("usage: harness.ts --out <dir> [--minutes 55] [--drills …|none] [--proxy …] [--model …] | --analyze <dir>");
  process.exit(2);
}
const MINUTES = Number(option("minutes") ?? 55);
const DRILL_SPEC = option("drills") ?? DEFAULT_DRILLS;
const DRILL_REPEAT_HOURS = Number(option("drill-repeat-hours") ?? 0);
const PROXY = resolve(option("proxy") ?? DEFAULT_PROXY);
const MODEL = option("model");
const PRODUCTION = option("production") === "none" ? [] : (option("production")?.split(",") ?? DEFAULT_PRODUCTION);
const CUTS = option("cuts") ?? "";
const PG_IMAGE = option("pg-image") ?? "postgres:16-alpine";

// ── recording ─────────────────────────────────────────────────────────────────
const at = (): string => new Date().toISOString();
const jsonl = (file: string, value: unknown): void => appendFileSync(resolve(OUT, file), `${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`);
const event = (what: string, fields: Record<string, unknown> = {}): void => {
  const line = { at: at(), event: what, ...fields };
  jsonl("events.jsonl", line);
  console.log(JSON.stringify(line));
};
const readLines = <T>(file: string): T[] => {
  const path = resolve(OUT, file);
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn last line from a killed writer: skipped.
    }
  }
  return out;
};

// ── ports ─────────────────────────────────────────────────────────────────────
async function portFree(port: number): Promise<boolean> {
  return await new Promise((done) => {
    const probe = createSocketServer();
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
  });
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
/** The proxy listens on p and p + 1 (the port web3.js derives for a websocket): both must be free. */
async function freePortPair(): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await freePort();
    if (port < 65_000 && (await portFree(port + 1))) return port;
  }
  throw new Error("no two free consecutive loopback ports");
}

// ── a child process of the keeper package ─────────────────────────────────────
interface LogLine {
  readonly ts?: unknown;
  readonly level?: unknown;
  readonly event?: unknown;
  readonly [field: string]: unknown;
}

class Child {
  exited: number | string | null = null;
  readonly pid: number | undefined;
  readonly startedAt = Date.now();
  /** The newest notable lines, for the drills. */
  readonly ring: { readonly at: number; readonly line: LogLine }[] = [];
  warnings = 0;
  errors = 0;
  readonly #child: ChildProcess;
  readonly #log: WriteStream;
  #partial = "";

  constructor(
    readonly name: string,
    command: string,
    args: readonly string[],
    env: Record<string, string>,
    private readonly onLine: (line: LogLine, child: Child) => void = () => undefined,
  ) {
    this.#log = createWriteStream(resolve(OUT, "logs", `${name}.log`), { flags: "a" });
    // `env -i`: NOTHING FROM THIS SHELL reaches the child — no key, no DATABASE_URL, no broadcast flag.
    this.#child = spawn(
      "/usr/bin/env",
      ["-i", `PATH=${dirname(process.execPath)}:/usr/bin:/bin`, `HOME=${process.env["HOME"] ?? "/tmp"}`, ...Object.entries(env).map(([k, v]) => `${k}=${v}`), command, ...args],
      { cwd: KEEPER_DIR, stdio: ["ignore", "pipe", "pipe"] },
    );
    this.pid = this.#child.pid;
    const take = (chunk: Buffer): void => {
      this.#log.write(chunk);
      this.#partial += chunk.toString("utf8");
      const lines = this.#partial.split("\n");
      this.#partial = lines.pop() ?? "";
      for (const raw of lines) {
        if (!raw.startsWith("{")) continue;
        let line: LogLine;
        try {
          line = JSON.parse(raw) as LogLine;
        } catch {
          continue;
        }
        if (line.level === "warn") this.warnings += 1;
        if (line.level === "error") this.errors += 1;
        this.ring.push({ at: Date.now(), line });
        if (this.ring.length > 3_000) this.ring.splice(0, this.ring.length - 3_000);
        this.onLine(line, this);
      }
    };
    this.#child.stdout!.on("data", take);
    this.#child.stderr!.on("data", take);
    this.#child.on("exit", (code, signal) => {
      this.exited = code ?? signal ?? -1;
      this.#log.end();
    });
  }

  /** A node child running a keeper entry point with tsx and the offline guard: ONE process, so a SIGKILL kills it. */
  static keeper(name: string, entry: string, env: Record<string, string>, onLine?: (line: LogLine, child: Child) => void, args: readonly string[] = []): Child {
    return new Child(name, process.execPath, ["--import", "tsx", "--import", resolve(KEEPER_DIR, "scripts/bench-offline.mts"), entry, ...args], env, onLine);
  }

  kill(signal: NodeJS.Signals): void {
    if (this.exited === null) this.#child.kill(signal);
  }

  async exit(timeoutMs = 60_000): Promise<number | string | null> {
    const started = Date.now();
    while (this.exited === null && Date.now() - started < timeoutMs) await sleep(100);
    return this.exited;
  }

  /** The newest ring line with this event at or after `since`. */
  find(eventName: string, since: number): { readonly at: number; readonly line: LogLine } | undefined {
    for (let i = this.ring.length - 1; i >= 0; i -= 1) {
      const entry = this.ring[i]!;
      if (entry.at < since) break;
      if (entry.line.event === eventName) return entry;
    }
    return undefined;
  }

  /** Every ring line at or after `since` (and before `until`). */
  since(since: number, until = Number.POSITIVE_INFINITY): { readonly at: number; readonly line: LogLine }[] {
    return this.ring.filter((entry) => entry.at >= since && entry.at < until);
  }
}

// ── the relay: one path per process, in front of the census proxy ─────────────
class Relay {
  port = 0;
  readonly calls = new Map<string, number>();
  readonly #frozen = new Set<string>();
  readonly #held = new Map<string, { readonly response: ServerResponse; readonly body: string }[]>();
  #server: Server | null = null;

  constructor(private readonly proxyPort: number) {}

  async listen(): Promise<void> {
    this.#server = createServer((request, response) => void this.#serve(request, response));
    // NO WEBSOCKET THROUGH HERE EITHER.
    this.#server.on("upgrade", (_request, socket) => socket.destroy());
    await new Promise<void>((done) => this.#server!.listen(0, "127.0.0.1", done));
    this.port = (this.#server.address() as { port: number }).port;
  }

  url(tag: string): string {
    return `http://127.0.0.1:${this.port}/${tag}`;
  }

  freeze(tag: string): void {
    this.#frozen.add(tag);
  }

  heldCount(tag: string): number {
    return (this.#held.get(tag) ?? []).filter((entry) => !entry.response.destroyed && !entry.response.socket?.destroyed).length;
  }

  /** Let the path answer again; requests held from a process still alive go on to the proxy. */
  thaw(tag: string): void {
    this.#frozen.delete(tag);
    const held = this.#held.get(tag) ?? [];
    this.#held.delete(tag);
    for (const entry of held) {
      if (entry.response.destroyed || entry.response.socket?.destroyed === true) continue;
      void this.#forward(tag, entry.body, entry.response);
    }
  }

  async close(): Promise<void> {
    for (const tag of [...this.#held.keys()]) for (const entry of this.#held.get(tag)!) entry.response.destroy();
    this.#server?.closeAllConnections();
    await new Promise<void>((done) => (this.#server === null ? done() : this.#server.close(() => done())));
  }

  async #serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const tag = /^\/([A-Za-z0-9_-]{1,40})$/.exec(request.url ?? "")?.[1];
    if (request.method !== "POST" || tag === undefined) {
      response.writeHead(request.method === "POST" ? 404 : 405);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    this.calls.set(tag, (this.calls.get(tag) ?? 0) + 1);
    if (this.#frozen.has(tag)) {
      const list = this.#held.get(tag) ?? [];
      list.push({ response, body });
      this.#held.set(tag, list);
      return;
    }
    await this.#forward(tag, body, response);
  }

  async #forward(tag: string, body: string, response: ServerResponse): Promise<void> {
    try {
      const upstream = await fetch(`http://127.0.0.1:${this.proxyPort}/run/${tag}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      const text = await upstream.text();
      if (response.destroyed) return;
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      response.end(text);
    } catch {
      if (response.destroyed) return;
      response.writeHead(502);
      response.end();
    }
  }
}

// ── the run's state ──────────────────────────────────────────────────────────
interface Proc {
  readonly name: string;
  readonly kind: "scheduler" | "worker";
  readonly tag: string;
  readonly child: Child;
  id: string | null;
}

interface RunMeta {
  pgName: string | null;
  pgPort: number | null;
  proxyPort: number | null;
  relayPort: number | null;
  startedAt: string;
  steadyStart: number | null;
  endAt: number | null;
  program: string;
  cuts: string;
  minutes: number;
  drills: string;
  drillRepeatHours: number;
  proxy: string;
  production: readonly string[];
}

const meta: RunMeta = {
  pgName: null,
  pgPort: null,
  proxyPort: null,
  relayPort: null,
  startedAt: at(),
  steadyStart: null,
  endAt: null,
  program: SIP_PROGRAM_ID,
  cuts: CUTS,
  minutes: MINUTES,
  drills: DRILL_SPEC,
  drillRepeatHours: DRILL_REPEAT_HOURS,
  proxy: PROXY,
  production: PRODUCTION,
};
const saveMeta = (): void => writeFileSync(resolve(OUT, "run.json"), JSON.stringify(meta, null, 2));

const procs: Proc[] = [];
const shadow = new Map<string, ShadowWallet>();
const compareRows: CompareRow[] = [];
const stopped: Record<string, unknown>[] = [];
let proxyChild: Child | null = null;
let relay: Relay | null = null;
let db: pg.Pool | null = null;
let databaseUrl = "";
let finishing = false;
/** Each kind's processes are lettered in start order: sched-a, sched-b, sched-c …; worker-a, worker-b, worker-c … */
const letters = { scheduler: 0, worker: 0 };

const docker = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const query = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> => (await db!.query<T>(text, values)).rows;

const alive = (kind: Proc["kind"]): Proc[] => procs.filter((proc) => proc.kind === kind && proc.child.exited === null);

const shared = (tag: string): Record<string, string> => ({
  SIP_SOLANA_RPC_URLS: relay!.url(tag),
  SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
  DATABASE_URL: databaseUrl,
  SIP_SOLANA_DISPATCH: "shadow",
  ...(CUTS === "" ? {} : { SIP_SOLANA_CUTS: CUTS }),
});

/** Start a scheduler or a worker and learn its worker_id from the row it registers at boot. */
async function startProc(kind: Proc["kind"]): Promise<Proc> {
  const n = letters[kind];
  letters[kind] += 1;
  const letter = String.fromCharCode(97 + (n % 26)) + (n >= 26 ? String(Math.floor(n / 26)) : "");
  const name = `${kind === "scheduler" ? "sched" : "worker"}-${letter}`;
  const known = new Set((await query<{ worker_id: string }>("SELECT worker_id FROM sip_solana.worker")).map((row) => row.worker_id));
  const env = kind === "scheduler" ? { ...shared(name), PORT: String(await freePort()) } : { ...shared(name), SIP_SOLANA_WORKER_SLOTS: "2" };
  const child = Child.keeper(name, kind === "scheduler" ? "bin/scheduler.mts" : "bin/worker.mts", env, (line, from) => {
    if (kind === "worker") {
      foldShadowJobs(shadow, line, from.name);
      if (line.event === "job done" || line.event === "job stopped") jsonl("jobs.jsonl", { process: from.name, ...line });
    } else if (line.event === "scheduler tick" || line.event === "took the scheduler lock: this tick is a full pass") {
      jsonl("ticks.jsonl", { process: from.name, ...line });
    }
  });
  const proc: Proc = { name, kind, tag: name, child, id: null };
  procs.push(proc);
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    if (child.exited !== null) throw new Error(`${name} exited ${String(child.exited)} at boot; see logs/${name}.log`);
    const rows = await query<{ worker_id: string }>("SELECT worker_id FROM sip_solana.worker WHERE kind = $1 ORDER BY started_at", [kind]);
    const fresh = rows.map((row) => row.worker_id).filter((id) => !known.has(id));
    if (fresh.length > 0) {
      proc.id = fresh[0]!;
      break;
    }
    await sleep(250);
  }
  if (proc.id === null) throw new Error(`${name} registered no worker row within 90 s; see logs/${name}.log`);
  event("process started", { name, kind, pid: child.pid, workerId: proc.id });
  return proc;
}

async function handover(...args: string[]): Promise<number | string | null> {
  const child = Child.keeper(`handover-${args[0]}`, "bin/dispatch-handover.mts", { SIP_SOLANA_RPC_URLS: relay!.url("handover"), DATABASE_URL: databaseUrl }, undefined, args);
  const code = await child.exit(120_000);
  if (code === null) child.kill("SIGKILL");
  event("handover", { args, exit: code });
  return code;
}

// ── setup ─────────────────────────────────────────────────────────────────────
async function setup(): Promise<void> {
  mkdirSync(resolve(OUT, "logs"), { recursive: true });
  mkdirSync(resolve(OUT, "rpc"), { recursive: true });
  if (!existsSync(PROXY)) throw new Error(`no census proxy at ${PROXY}`);
  event("harness starting", { out: OUT, minutes: MINUTES, drills: DRILL_SPEC, cuts: CUTS || "none", program: SIP_PROGRAM_ID, node: process.version });

  // POSTGRES 16, OURS ALONE: a unique name, --rm, the loopback only, trust auth (no password exists to leak).
  const pgName = `sip-shadow-pg-${randomBytes(4).toString("hex")}`;
  const run = docker("run", "--rm", "-d", "--name", pgName, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-p", "127.0.0.1::5432", PG_IMAGE);
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr.slice(0, 300)}`);
  meta.pgName = pgName;
  saveMeta();
  const mapped = /127\.0\.0\.1:(\d+)/.exec(docker("port", pgName, "5432/tcp").stdout)?.[1];
  if (mapped === undefined) throw new Error("the database container published no loopback port");
  meta.pgPort = Number(mapped);
  const admin = new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:${mapped}/postgres?sslmode=disable`, max: 1, connectionTimeoutMillis: 3_000 });
  admin.on("error", () => undefined);
  const ready = Date.now();
  for (;;) {
    try {
      await admin.query("SELECT 1");
      break;
    } catch {
      if (Date.now() - ready > 90_000) throw new Error("the database did not accept connections within 90 s");
      await sleep(500);
    }
  }
  await admin.query("CREATE DATABASE shadow");
  await admin.end();
  databaseUrl = `postgres://postgres@127.0.0.1:${mapped}/shadow?sslmode=disable`;
  db = new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000, query_timeout: 8_000 });
  db.on("error", () => undefined);
  await db.query(readFileSync(SCHEMA, "utf8"));
  event("database ready", { container: pgName, port: meta.pgPort, image: PG_IMAGE });

  // THE CENSUS PROXY: the only way out to the chain.
  const proxyPort = await freePortPair();
  meta.proxyPort = proxyPort;
  proxyChild = new Child("census-proxy", process.execPath, [PROXY, "--port", String(proxyPort), "--log", resolve(OUT, "rpc/calls.jsonl")], {});
  for (let i = 0; ; i += 1) {
    try {
      const census = await fetch(`http://127.0.0.1:${proxyPort}/__census`, { signal: AbortSignal.timeout(1_000) });
      if (census.ok) break;
    } catch {
      // not yet
    }
    if (i > 40 || proxyChild.exited !== null) throw new Error("the census proxy did not start; see logs/census-proxy.log");
    await sleep(250);
  }
  relay = new Relay(proxyPort);
  await relay.listen();
  meta.relayPort = relay.port;
  saveMeta();
  event("census proxy and relay listening", { proxyPort, relayPort: relay.port, upstream: "https://api.mainnet-beta.solana.com (the proxy refuses any other)" });

  // THE HANDOVER, AS A SHADOW'S DATABASE NEEDS IT: new vaults go to the queue, through 'draining'.
  if ((await handover("new-vaults", "queue")) !== 0) throw new Error("dispatch-handover new-vaults queue failed; see logs/handover-new-vaults.log");

  const first = await startProc("scheduler");
  const discovered = Date.now();
  while ((await query("SELECT 1 FROM sip_solana.vault_work")).length === 0) {
    if (first.child.exited !== null) throw new Error("the first scheduler exited before its discovery");
    if (Date.now() - discovered > 180_000) throw new Error("no vault discovered within 3 minutes");
    await sleep(1_000);
  }
  const fleet = await query<{ scheduler_id: string | null }>("SELECT scheduler_id FROM sip_solana.fleet");
  event("discovery", {
    vaults: (await query("SELECT vault_addr, system FROM sip_solana.vault_work ORDER BY vault_addr")).length,
    links: (await query("SELECT 1 FROM sip_solana.keeper_link WHERE gone_at IS NULL")).length,
    holder: fleet[0]?.scheduler_id === first.id ? first.name : fleet[0]?.scheduler_id,
  });
  await startProc("scheduler");

  // ARM: the first call records the height, the next moves every vault once 150 blocks are final.
  const armStarted = Date.now();
  for (;;) {
    const code = await handover("arm", "--all", "--roles=none", "--allow-dry");
    const systems = await query<{ system: string }>("SELECT DISTINCT system FROM sip_solana.vault_work");
    if (code === 0 && systems.length === 1 && systems[0]!.system === "queue") break;
    if (Date.now() - armStarted > 6 * 60_000) throw new Error("arm did not move the vaults to the queue within 6 minutes");
    await sleep(20_000);
  }
  event("armed", { tookMs: Date.now() - armStarted });

  await startProc("worker");
  await startProc("worker");
  meta.steadyStart = Date.now();
  meta.endAt = meta.steadyStart + MINUTES * 60_000;
  saveMeta();
  event("fleet up", { steadyStart: new Date(meta.steadyStart).toISOString(), endAt: new Date(meta.endAt).toISOString() });
}

// ── once a minute ─────────────────────────────────────────────────────────────
async function fetchStatus(url: string): Promise<{ readonly status: number | null; readonly body: unknown }> {
  try {
    const response = await fetch(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: response.status, body: null };
    }
  } catch {
    return { status: null, body: null };
  }
}

/** What of a production /status body is kept: the role, its sweep clock and the per-wallet rows. */
const trimmed = (body: unknown): unknown => {
  if (body === null || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  return { role: b["role"], mode: b["mode"], sweeps: b["sweeps"], lastSweepAt: b["lastSweepAt"], lastSweepError: b["lastSweepError"], wallets: b["wallets"] };
};

async function minute(): Promise<void> {
  const now = Date.now();
  if (PRODUCTION.length === 2) {
    const [profit, volume] = await Promise.all(PRODUCTION.map((url) => fetchStatus(url)));
    jsonl("production.jsonl", { at: new Date(now).toISOString(), profit: { status: profit!.status, body: trimmed(profit!.body) }, volume: { status: volume!.status, body: trimmed(volume!.body) } });
    // THE INVEST PER VAULT: the vaults are the ones the workers' jobs named.
    const rows = compareAt(Date.now(), productionDecisions(profit!.body, volume!.body, (wallet) => shadow.get(wallet)?.vault), shadow);
    for (const row of rows) jsonl("compare.jsonl", row);
    compareRows.push(...rows);
  }
  let audit: Record<string, unknown>;
  try {
    const overlap = await query(OVERLAP_AUDIT_SQL);
    const intents = await query<{ state: string; n: number }>("SELECT state, count(*)::int AS n FROM sip_solana.send_intent GROUP BY state ORDER BY state");
    const work = await query(
      `SELECT vault_addr, system, holder, fence::text, lane, attempts, parked_reason, last_holder, last_outcome,
              round(extract(epoch FROM due_at - clock_timestamp()))::int AS due_in_s, last_done_at FROM sip_solana.vault_work ORDER BY vault_addr`,
    );
    const workers = await query("SELECT worker_id, kind, busy, rps_quota, stopped_at IS NOT NULL AS stopped FROM sip_solana.worker ORDER BY started_at");
    const fleet = await query("SELECT scheduler_id, tick_at, full_pass_reason, new_vault_system FROM sip_solana.fleet");
    audit = { at: new Date(now).toISOString(), overlapRows: overlap.length, intents, work, workers, fleet: fleet[0] ?? null };
  } catch (error) {
    audit = { at: new Date(now).toISOString(), unavailable: error instanceof Error ? error.message.slice(0, 200) : "error" };
  }
  jsonl("audit.jsonl", audit);
  const recent = compareRows.filter((row) => row.at >= now - 1_000);
  console.log(
    JSON.stringify({
      at: new Date(now).toISOString(),
      minute: meta.steadyStart === null ? null : Math.round((now - meta.steadyStart) / 60_000),
      compare: recent.map((row) => `${row.wallet.slice(0, 4)}:${row.verdict}`).join(" "),
      overlapRows: audit["overlapRows"] ?? "unavailable",
      alive: procs.filter((proc) => proc.child.exited === null).map((proc) => proc.name),
      relayCalls: Object.fromEntries(relay?.calls ?? []),
    }),
  );
}

// ── the drills ────────────────────────────────────────────────────────────────
interface Hold {
  readonly vault: string;
  readonly fence: string;
  readonly leaseUntil: number;
}

/** Freeze a worker's path until it holds a vault with a request held in the relay: mid-job. */
async function holdMidJob(victim: Proc, timeoutMs = 240_000): Promise<Hold[] | null> {
  relay!.freeze(victim.tag);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const rows = await query<{ vault_addr: string; fence: string; lease_ms: string }>(
      `SELECT vault_addr, fence::text, (extract(epoch FROM lease_until) * 1000)::bigint::text AS lease_ms
         FROM sip_solana.vault_work WHERE holder = $1 AND lease_until > clock_timestamp()`,
      [victim.id],
    ).catch(() => []);
    if (rows.length > 0 && relay!.heldCount(victim.tag) > 0) {
      return rows.map((row) => ({ vault: row.vault_addr, fence: row.fence, leaseUntil: Number(row.lease_ms) }));
    }
    await sleep(250);
  }
  relay!.thaw(victim.tag);
  return null;
}

const dbNow = async (): Promise<number> => Number((await query<{ ms: string }>("SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS ms"))[0]!.ms);

interface VaultState {
  readonly holder: string | null;
  readonly fence: string;
  readonly claimedAt: number | null;
  readonly lastHolder: string | null;
  readonly lastDoneAt: number | null;
  readonly lastOutcome: string | null;
  readonly attempts: number;
}

async function vaultState(vault: string): Promise<VaultState> {
  const [row] = await query<{ holder: string | null; fence: string; claimed_ms: string | null; last_holder: string | null; done_ms: string | null; last_outcome: string | null; attempts: number }>(
    `SELECT holder, fence::text, (extract(epoch FROM claimed_at) * 1000)::bigint::text AS claimed_ms, last_holder,
            (extract(epoch FROM last_done_at) * 1000)::bigint::text AS done_ms, last_outcome, attempts
       FROM sip_solana.vault_work WHERE vault_addr = $1`,
    [vault],
  );
  return {
    holder: row!.holder,
    fence: row!.fence,
    claimedAt: row!.claimed_ms === null ? null : Number(row!.claimed_ms),
    lastHolder: row!.last_holder,
    lastDoneAt: row!.done_ms === null ? null : Number(row!.done_ms),
    lastOutcome: row!.last_outcome,
    attempts: row!.attempts,
  };
}

/** Wait until someone other than `victimId` has claimed the vault above `fence` and completed that job. */
async function followTakeover(vault: string, fence: string, victimId: string, timeoutMs = 240_000): Promise<{ claimed: VaultState | null; completed: VaultState | null }> {
  const started = Date.now();
  let claimed: VaultState | null = null;
  while (Date.now() - started < timeoutMs) {
    const state = await vaultState(vault).catch(() => null);
    if (state !== null) {
      if (claimed === null && BigInt(state.fence) > BigInt(fence) && state.holder !== null && state.holder !== victimId) claimed = state;
      if (claimed === null && BigInt(state.fence) > BigInt(fence) && state.holder === null && state.lastHolder !== victimId) {
        // CLAIMED AND ALREADY DONE between two polls: the claim time is the completed row's.
        claimed = state;
      }
      if (claimed !== null && state.holder === null && state.lastHolder !== victimId && (state.lastDoneAt ?? 0) >= (claimed.claimedAt ?? 0)) return { claimed, completed: state };
    }
    await sleep(250);
  }
  return { claimed, completed: null };
}

/** t − base, or null when t is unknown. */
const delta = (t: number | null | undefined, base: number): number | null => (t === null || t === undefined ? null : t - base);

const nameOf = (id: string | null): string => procs.find((proc) => proc.id === id)?.name ?? (id === null ? "none" : `unknown(${id.slice(0, 18)})`);

async function auditRows(): Promise<number | null> {
  try {
    return (await query(OVERLAP_AUDIT_SQL)).length;
  } catch {
    return null;
  }
}

async function drillWorkerKill(): Promise<Record<string, unknown>> {
  const workers = alive("worker");
  if (workers.length < 2) return { ok: false, detail: "fewer than two live workers" };
  const victim = workers[0]!;
  const held = await holdMidJob(victim);
  if (held === null) return { ok: false, detail: `${victim.name} held no vault mid-job within 4 minutes of its path being frozen` };
  const killAt = await dbNow();
  victim.child.kill("SIGKILL");
  const exit = await victim.child.exit(30_000);
  relay!.thaw(victim.tag);
  // THE LEASES AS THE KILL LEFT THEM: the last heartbeat's.
  const leases = await query<{ vault_addr: string; lease_ms: string }>(
    `SELECT vault_addr, (extract(epoch FROM lease_until) * 1000)::bigint::text AS lease_ms FROM sip_solana.vault_work WHERE holder = $1`,
    [victim.id],
  );
  // EVERY HELD VAULT FOLLOWED AT ONCE: a later tick must not claim one again before it is looked at.
  const vaults = await Promise.all(
    held.map(async (hold) => {
      const leaseUntil = Number(leases.find((row) => row.vault_addr === hold.vault)?.lease_ms ?? hold.leaseUntil);
      const { claimed, completed } = await followTakeover(hold.vault, hold.fence, victim.id!);
      const successor = claimed?.holder ?? claimed?.lastHolder ?? null;
      return {
        vault: hold.vault,
        fenceAtKill: hold.fence,
        fenceAfter: claimed?.fence ?? null,
        leaseUntilAfterKillMs: leaseUntil - killAt,
        takeoverAfterKillMs: delta(claimed?.claimedAt, killAt),
        successorWaitedTheLease: claimed?.claimedAt != null && claimed.claimedAt >= leaseUntil,
        successor: nameOf(successor),
        successorIsAliveWorker: alive("worker").some((proc) => proc.id === successor),
        completedOutcome: completed?.lastOutcome ?? null,
        completedAfterKillMs: delta(completed?.lastDoneAt, killAt),
      };
    }),
  );
  const openOfVictim = (await query<{ n: number }>("SELECT count(*)::int AS n FROM sip_solana.send_intent WHERE worker_id = $1 AND resolved_at IS NULL", [victim.id]))[0]!.n;
  const overlap = await auditRows();
  const replacement = await startProc("worker");
  const ok =
    exit === "SIGKILL" &&
    vaults.length > 0 &&
    vaults.every((v) => v.fenceAfter !== null && BigInt(v.fenceAfter) > BigInt(v.fenceAtKill) && v.successorWaitedTheLease && v.successorIsAliveWorker && v.completedOutcome !== null) &&
    openOfVictim === 0 &&
    overlap === 0;
  return { ok, victim: victim.name, exit, vaults, openIntentsOfVictimAfter: openOfVictim, overlapRows: overlap, replacement: replacement.name };
}

async function drillWorkerSigterm(): Promise<Record<string, unknown>> {
  const workers = alive("worker");
  if (workers.length < 2) return { ok: false, detail: "fewer than two live workers" };
  const victim = workers[0]!;
  const held = await holdMidJob(victim);
  if (held === null) return { ok: false, detail: `${victim.name} held no vault mid-job within 4 minutes of its path being frozen` };
  const termAt = await dbNow();
  const termLocal = Date.now();
  victim.child.kill("SIGTERM");
  // THE PATH STAYS FROZEN: the job cannot end by itself, so the drain runs out and the job is aborted.
  const exit = await victim.child.exit(SIGTERM_DRAIN_MS + 60_000);
  const exitAfterMs = Date.now() - termLocal;
  relay!.thaw(victim.tag);
  if (exit === null) victim.child.kill("SIGKILL");
  const stoppedLine = victim.child.find("worker stopped", termLocal)?.line ?? null;
  const vaults = await Promise.all(
    held.map(async (hold) => {
      const { claimed, completed } = await followTakeover(hold.vault, hold.fence, victim.id!);
      // THE RELEASE IS THE VICTIM'S COMPLETE WITH NO DELAY: its time is last_done_at as the successor found the row.
      const releasedAt = claimed?.lastHolder === victim.id ? claimed.lastDoneAt : null;
      return {
        vault: hold.vault,
        fenceAtTerm: hold.fence,
        fenceAfter: claimed?.fence ?? null,
        releasedAfterTermMs: delta(releasedAt, termAt),
        claimedAfterReleaseMs: releasedAt === null ? null : delta(claimed?.claimedAt, releasedAt),
        leaseWouldHaveRunUntilMs: hold.leaseUntil - termAt,
        successor: nameOf(claimed?.holder ?? claimed?.lastHolder ?? null),
        completedOutcome: completed?.lastOutcome ?? null,
      };
    }),
  );
  const [row] = await query<{ stopped: boolean }>("SELECT stopped_at IS NOT NULL AS stopped FROM sip_solana.worker WHERE worker_id = $1", [victim.id]);
  const overlap = await auditRows();
  const replacement = await startProc("worker");
  const released = Number((stoppedLine?.["releasedOnSigterm"] as number | undefined) ?? -1);
  const ok =
    exit === 0 &&
    row?.stopped === true &&
    released >= held.length &&
    vaults.every((v) => v.releasedAfterTermMs !== null && v.releasedAfterTermMs <= SIGTERM_DRAIN_MS + 5_000 && v.claimedAfterReleaseMs !== null && v.claimedAfterReleaseMs < 10_000 && v.completedOutcome !== null) &&
    overlap === 0;
  return {
    ok,
    victim: victim.name,
    exit,
    exitAfterTermMs: exitAfterMs,
    drainMs: SIGTERM_DRAIN_MS,
    workerStopped: stoppedLine === null ? null : { drained: stoppedLine["drained"], releasedOnSigterm: stoppedLine["releasedOnSigterm"] },
    rowClosed: row?.stopped ?? null,
    vaults,
    overlapRows: overlap,
    replacement: replacement.name,
  };
}

async function drillSchedulerKill(): Promise<Record<string, unknown>> {
  const [fleet] = await query<{ scheduler_id: string | null }>("SELECT scheduler_id FROM sip_solana.fleet");
  const schedulers = alive("scheduler");
  const active = schedulers.find((proc) => proc.id === fleet?.scheduler_id);
  const standby = schedulers.find((proc) => proc !== active);
  if (active === undefined || standby === undefined) return { ok: false, detail: "no acting scheduler with a live standby" };
  const vaults = (await query("SELECT 1 FROM sip_solana.vault_work WHERE system = 'queue'")).length;
  const killLocal = Date.now();
  const killAt = await dbNow();
  active.child.kill("SIGKILL");
  const exit = await active.child.exit(30_000);
  let took: { at: number } | undefined;
  let tick: LogLine | undefined;
  const started = Date.now();
  while (Date.now() - started < 180_000) {
    took ??= standby.child.find("took the scheduler lock: this tick is a full pass", killLocal);
    if (took !== undefined) {
      const acted = standby.child.since(took.at).find((entry) => entry.line.event === "scheduler tick" && entry.line["tookOver"] === true);
      if (acted !== undefined) {
        tick = acted.line;
        break;
      }
    }
    await sleep(250);
  }
  const [after] = await query<{ scheduler_id: string | null; tick_ms: string | null }>(
    "SELECT scheduler_id, (extract(epoch FROM tick_at) * 1000)::bigint::text AS tick_ms FROM sip_solana.fleet",
  );
  // EVERY VAULT TURNED AFTER THE TAKEOVER: the full pass made each due, and a worker completed it.
  let turned = 0;
  const waitTurned = Date.now();
  while (took !== undefined && Date.now() - waitTurned < 120_000) {
    turned = (await query("SELECT 1 FROM sip_solana.vault_work WHERE system = 'queue' AND last_done_at > to_timestamp($1 / 1000.0)", [killAt + (took.at - killLocal)])).length;
    if (turned >= vaults) break;
    await sleep(1_000);
  }
  const lanes = (tick?.["lanes"] ?? null) as Record<string, number> | null;
  const replacement = await startProc("scheduler");
  const ok = exit === "SIGKILL" && took !== undefined && tick !== undefined && after?.scheduler_id === standby.id && (lanes?.["full"] ?? 0) >= 1 && turned >= vaults;
  return {
    ok,
    killed: active.name,
    standby: standby.name,
    exit,
    tookLockAfterKillMs: took === undefined ? null : took.at - killLocal,
    takeoverTick: tick === undefined ? null : { tookOver: tick["tookOver"], fullPass: tick["fullPass"], lanes, due: tick["due"], discovery: tick["discovery"] },
    fleetSchedulerIsStandby: after?.scheduler_id === standby.id,
    vaultsTurnedAfterTakeover: `${turned}/${vaults}`,
    replacementStandby: replacement.name,
  };
}

async function drillPgPause(): Promise<Record<string, unknown>> {
  const pgName = meta.pgName!;
  const [before] = await query<{ scheduler_id: string | null }>("SELECT scheduler_id FROM sip_solana.fleet");
  // THE PROCESSES THE PAUSE IS DONE TO: those alive when it starts (an earlier drill's victims are not).
  const running = procs.filter((proc) => proc.child.exited === null);
  const pauseAt = Date.now();
  const paused = docker("pause", pgName);
  if (paused.status !== 0) return { ok: false, detail: `docker pause failed: ${paused.stderr.slice(0, 200)}` };
  await sleep(PG_PAUSE_MS);
  const unpaused = docker("unpause", pgName);
  const unpauseAt = Date.now();
  if (unpaused.status !== 0) return { ok: false, detail: `docker unpause failed: ${unpaused.stderr.slice(0, 200)}` };
  // RECOVERY: a scheduler tick that acts and a job that completes, after the database is back.
  let tickAfter: number | null = null;
  let jobAfter: number | null = null;
  const started = Date.now();
  while (Date.now() - started < 150_000 && (tickAfter === null || jobAfter === null)) {
    for (const proc of procs) {
      if (proc.kind === "scheduler" && tickAfter === null) {
        const tick = proc.child.find("scheduler tick", unpauseAt);
        if (tick !== undefined) tickAfter = tick.at - unpauseAt;
      }
      if (proc.kind === "worker" && jobAfter === null) {
        const job = proc.child.find("job done", unpauseAt);
        if (job !== undefined) jobAfter = job.at - unpauseAt;
      }
    }
    await sleep(500);
  }
  // NOTHING COMMITTED WHILE IT WAS PAUSED: no intent created, no job completed, in the window (the database's clock).
  const committed = await query<{ intents: number; completions: number }>(
    `SELECT (SELECT count(*)::int FROM sip_solana.send_intent WHERE created_at > to_timestamp($1 / 1000.0) AND created_at < to_timestamp($2 / 1000.0)) AS intents,
            (SELECT count(*)::int FROM sip_solana.vault_work WHERE last_done_at > to_timestamp($1 / 1000.0) AND last_done_at < to_timestamp($2 / 1000.0)) AS completions`,
    // A SECOND AND A HALF INSIDE EACH END: the container's clock and this process's are two clocks.
    [pauseAt + 1_500, unpauseAt - 1_500],
  );
  const [after] = await query<{ scheduler_id: string | null }>("SELECT scheduler_id FROM sip_solana.fleet");
  const parked = (await query("SELECT vault_addr FROM sip_solana.vault_work WHERE parked_reason IS NOT NULL")).length;
  const window = { from: pauseAt, until: unpauseAt + 60_000 };
  const byProcess = running.map((proc) => {
      const lines = proc.child.since(window.from, window.until);
      const noisy = lines.filter((entry) => entry.line.level === "warn" || entry.line.level === "error");
      return {
        name: proc.name,
        alive: proc.child.exited === null,
        exit: proc.child.exited,
        warnOrError: noisy.length,
        events: [...new Set(noisy.map((entry) => String(entry.line.event)))].slice(0, 8),
        jobsStopped: lines.filter((entry) => entry.line.event === "job stopped").length,
      };
    });
  const overlap = await auditRows();
  const ok =
    committed[0]!.intents === 0 &&
    committed[0]!.completions === 0 &&
    tickAfter !== null &&
    jobAfter !== null &&
    byProcess.every((proc) => proc.alive) &&
    parked === 0 &&
    overlap === 0;
  return {
    ok,
    pausedMs: unpauseAt - pauseAt,
    committedWhilePaused: committed[0],
    schedulerTickAfterUnpauseMs: tickAfter,
    jobDoneAfterUnpauseMs: jobAfter,
    holderBefore: nameOf(before?.scheduler_id ?? null),
    holderAfter: nameOf(after?.scheduler_id ?? null),
    parkedVaults: parked,
    processes: byProcess,
    overlapRows: overlap,
  };
}

const DRILLS: Record<string, () => Promise<Record<string, unknown>>> = {
  "worker-kill": drillWorkerKill,
  "worker-sigterm": drillWorkerSigterm,
  "scheduler-kill": drillSchedulerKill,
  "pg-pause": drillPgPause,
};

function drillSchedule(): { readonly name: string; readonly atMs: number }[] {
  if (DRILL_SPEC === "none") return [];
  const once = DRILL_SPEC.split(",").map((entry) => {
    const [name, minutes] = entry.split("@");
    if (name === undefined || DRILLS[name] === undefined || minutes === undefined || !Number.isFinite(Number(minutes))) throw new Error(`unknown drill entry: ${entry}`);
    return { name, atMs: Number(minutes) * 60_000 };
  });
  if (!(DRILL_REPEAT_HOURS > 0)) return once;
  const out: { name: string; atMs: number }[] = [];
  for (let offset = 0; offset < MINUTES * 60_000; offset += DRILL_REPEAT_HOURS * 3_600_000) for (const drill of once) out.push({ name: drill.name, atMs: drill.atMs + offset });
  return out.sort((a, b) => a.atMs - b.atMs);
}

async function runDrills(): Promise<void> {
  for (const drill of drillSchedule()) {
    const due = meta.steadyStart! + drill.atMs;
    while (Date.now() < due && !finishing) await sleep(1_000);
    if (finishing || Date.now() > meta.endAt! - 3 * 60_000) return;
    event("drill starting", { drill: drill.name });
    const started = Date.now();
    let result: Record<string, unknown>;
    try {
      result = await DRILLS[drill.name]!();
    } catch (error) {
      result = { ok: false, detail: `the drill threw: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}` };
    }
    const line = { drill: drill.name, startedAt: new Date(started).toISOString(), tookMs: Date.now() - started, ...result };
    jsonl("drills.jsonl", line);
    event("drill done", { drill: drill.name, ok: result["ok"] });
  }
}

// ── the end: stop everything, keep what the database knows, analyse ──────────
async function finish(reason: string): Promise<void> {
  if (finishing) return;
  finishing = true;
  event("finishing", { reason });
  // THE DATABASE'S LAST WORD, while the processes still run: the audit and the intents.
  const finalDb: Record<string, unknown> = {};
  if (db !== null) {
    try {
      finalDb["overlapRows"] = (await query(OVERLAP_AUDIT_SQL)).length;
      finalDb["intents"] = await query("SELECT state, kind, count(*)::int AS n FROM sip_solana.send_intent GROUP BY state, kind ORDER BY state, kind");
      finalDb["vaultWork"] = await query("SELECT vault_addr, system, fence::text, last_holder, last_outcome, parked_reason, attempts FROM sip_solana.vault_work ORDER BY vault_addr");
    } catch (error) {
      finalDb["error"] = error instanceof Error ? error.message.slice(0, 200) : "error";
    }
  }
  // SIGTERM EVERY CHILD (each flushes its rpc_usage and closes its row), then SIGKILL what is left.
  for (const proc of procs) proc.child.kill("SIGTERM");
  for (const proc of procs) {
    const exit = await proc.child.exit(SIGTERM_DRAIN_MS + 15_000);
    if (exit === null) {
      proc.child.kill("SIGKILL");
      await proc.child.exit(5_000);
    }
    stopped.push({ what: "process", name: proc.name, pid: proc.child.pid, exit: proc.child.exited });
  }
  if (db !== null) {
    try {
      finalDb["rpcUsage"] = await query("SELECT provider, class, sum(calls)::bigint::text AS calls FROM sip_solana.rpc_usage GROUP BY provider, class ORDER BY provider, class");
      finalDb["workers"] = await query("SELECT worker_id, kind, stopped_at IS NOT NULL AS stopped FROM sip_solana.worker ORDER BY started_at");
    } catch (error) {
      finalDb["usageError"] = error instanceof Error ? error.message.slice(0, 200) : "error";
    }
    await db.end().catch(() => undefined);
  }
  writeFileSync(resolve(OUT, "final-db.json"), JSON.stringify(finalDb, null, 2));
  if (relay !== null) {
    await relay.close();
    stopped.push({ what: "relay", port: relay.port });
  }
  if (proxyChild !== null) {
    proxyChild.kill("SIGTERM");
    await proxyChild.exit(10_000);
    if (proxyChild.exited === null) proxyChild.kill("SIGKILL");
    stopped.push({ what: "census proxy", pid: proxyChild.pid, exit: proxyChild.exited });
  }
  if (meta.pgName !== null) {
    docker("unpause", meta.pgName);
    const stop = docker("stop", meta.pgName);
    // --rm REMOVES IT AFTER THE STOP RETURNS: asked until it is gone, for up to 15 s.
    let left = meta.pgName;
    for (let i = 0; i < 30 && left !== ""; i += 1) {
      left = docker("ps", "-a", "--filter", `name=^${meta.pgName}$`, "--format", "{{.Names}}").stdout.trim();
      if (left !== "") await sleep(500);
    }
    stopped.push({ what: "postgres container", name: meta.pgName, stopExit: stop.status, removed: left === "" });
  }
  writeFileSync(resolve(OUT, "stopped.json"), JSON.stringify(stopped, null, 2));
  analyse();
}

// ── the analysis: a pure function of the files in OUT ─────────────────────────
function modelPrediction(tokens: readonly string[]): unknown {
  if (MODEL === undefined) return null;
  const script = `
import json, sys
sys.path.insert(0, sys.argv[1])
import model as M
tokens = set(json.loads(sys.argv[2]))
cfg = M.Cfg()
pop = M.TODAY_FLEET
cuts = set()
if "rest-skip" in tokens: cuts.add("C4")
if "invest-batch" in tokens: cuts.add("C5")
cuts = frozenset(cuts)
# THE DISPATCHER WITH THIS TOKEN SET, FROM THE MODEL'S OWN PER-TURN COSTS: the scheduler's chain snapshot (3),
# one getMultipleAccounts per job (the plan default), every link's resting settle by its own mode, and each
# vault's resting invest turn once; the listing once a tick. Every tick is a full pass (no bell reaches a shadow).
std = 3.0 + pop.vaults
arch = 0.0
for g in pop.groups:
    s, a = M.settle_cost("rest", g, cfg, cuts, g.mode)
    std += g.count * s
    arch += g.count * a
    std += (g.count / g.lpv) * M.invest_cost(g, cuts)
gpa = 0 if "gpa-v2" in tokens else 1
gpa2 = 1 if "gpa-v2" in tokens else 0
ticks = M.SWEEPS_PER_DAY_60S
def credits(p):
    return std + M.GPA_CREDITS * gpa + M.GPA_V2_CREDITS * gpa2 + p * arch
queue = M.evaluate("queue", pop, 0.0, cfg)
print(json.dumps({
  "perTick": {"standard": std, "archival": arch, "programAccounts": gpa, "programAccountsV2": gpa2, "calls": std + arch + gpa + gpa2},
  "creditsPerDay": {"archival1": credits(1) * ticks, "archival10": credits(10) * ticks},
  "modelQueueDesign": {"note": "the model's own 'queue' row: C4+C5+C8 assumed, a trusted doorbell, webhook traffic", "credits_day_P1": queue["credits_day_P1"], "credits_day_P2": queue["credits_day_P2"]},
}))
`;
  const result = spawnSync("python3", ["-I", "-c", script, dirname(resolve(MODEL)), JSON.stringify(tokens)], { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) return { error: (result.stderr ?? "").slice(-500) };
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return { error: "the model printed no JSON" };
  }
}

function analyse(): void {
  const run = JSON.parse(readFileSync(resolve(OUT, "run.json"), "utf8")) as RunMeta;
  const steadyStart = run.steadyStart ?? Date.parse(run.startedAt);
  const events = readLines<{ at: string; event: string }>("events.jsonl");
  const finishedAt = Date.parse(events.filter((line) => line.event === "finishing").at(-1)?.at ?? new Date().toISOString());
  const end = Math.min(run.endAt ?? finishedAt, finishedAt);
  // REPLAYED from production.jsonl and jobs.jsonl (compare.jsonl is the live loop's record of the same).
  const rows = replayComparison(readLines<ProductionSample>("production.jsonl"), readLines<WorkerLogLine & { process?: unknown }>("jobs.jsonl")).filter(
    (row) => row.at >= steadyStart && row.at <= end,
  );
  const explained = explainMismatches(rows);
  const drills = readLines<Record<string, unknown>>("drills.jsonl");
  const audit = readLines<{ at: string; overlapRows?: number; unavailable?: string }>("audit.jsonl");
  const calls = readLines<ProxyLine>("rpc/calls.jsonl");
  const listings = listingsPerMinute(calls, (tag) => tag.startsWith("sched-"), steadyStart, end);
  const windowMs = end - steadyStart;
  const steady = (tag: string, ts: number): boolean => tag !== "handover" && ts >= steadyStart && ts < end;
  const credit1 = creditsOf(calls, 1, steady);
  const credit10 = creditsOf(calls, 10, steady);
  const byKind = (prefix: string) => creditsOf(calls, 1, (tag, ts) => tag.startsWith(prefix) && steady(tag, ts));
  // THE QUIET MINUTES: whole minutes no drill touched (a drill, and two minutes after it, turn vaults twice and
  // restart processes). The model predicts a steady tick, so the credits are set beside it over these.
  const drillWindows = drills.map((drill) => {
    const from = Date.parse(String(drill["startedAt"]));
    return [from, from + Number(drill["tookMs"] ?? 0) + 120_000] as const;
  });
  const quiet = new Set<number>();
  for (let m = Math.ceil(steadyStart / 60_000) * 60_000; m + 60_000 <= end; m += 60_000) {
    if (!drillWindows.some(([from, until]) => m < until && m + 60_000 > from)) quiet.add(m);
  }
  const inQuiet = (tag: string, ts: number): boolean => steady(tag, ts) && quiet.has(Math.floor(ts / 60_000) * 60_000);
  const quiet1 = creditsOf(calls, 1, inQuiet);
  const quiet10 = creditsOf(calls, 10, inQuiet);
  const quietMs = quiet.size * 60_000;
  const quietDay = { archival1: perDay(quiet1.credits, quietMs), archival10: perDay(quiet10.credits, quietMs) };
  const tokens = run.cuts === "" ? [] : run.cuts.split(",").map((token) => token.trim());
  const model = modelPrediction(tokens) as { creditsPerDay?: { archival1: number; archival10: number }; perTick?: Record<string, number> } | null;
  const measuredDay = { archival1: perDay(credit1.credits, windowMs), archival10: perDay(credit10.credits, windowMs) };
  const minutes = windowMs / 60_000;
  const blocked = calls.filter((line) => line.refused === true);
  const finalDb = existsSync(resolve(OUT, "final-db.json")) ? (JSON.parse(readFileSync(resolve(OUT, "final-db.json"), "utf8")) as Record<string, unknown>) : null;
  const report = {
    window: { from: new Date(steadyStart).toISOString(), to: new Date(end).toISOString(), minutes: Math.round(minutes * 10) / 10 },
    agreement: {
      ...agreementOf(rows),
      explained: {
        timing: explained.filter((e) => e.explanation === "timing").length,
        dryRun: explained.filter((e) => e.explanation === "dry-run").length,
        transient: explained.filter((e) => e.explanation === "transient").length,
        unexplained: explained.filter((e) => e.explanation === "unexplained").length,
      },
      mismatches: explained.map((e) => ({ at: new Date(e.row.at).toISOString(), wallet: e.row.wallet, production: e.row.production, shadow: e.row.shadow, explanation: e.explanation, note: e.note })),
      gaps: rows.filter((row) => row.verdict === "no-shadow" || row.verdict === "no-production").map((row) => ({ at: new Date(row.at).toISOString(), wallet: row.wallet, verdict: row.verdict })),
    },
    overlap: {
      maxRowsSeen: Math.max(0, ...audit.map((line) => line.overlapRows ?? 0)),
      auditsRun: audit.filter((line) => line.overlapRows !== undefined).length,
      auditsUnavailable: audit.filter((line) => line.unavailable !== undefined).length,
      final: finalDb?.["overlapRows"] ?? null,
      intents: finalDb?.["intents"] ?? null,
    },
    discovery: {
      judgedMinutes: listings.judged,
      minutesWithExactlyOne: listings.exactlyOne,
      notOne: listings.minutes.filter((minute) => minute.listings !== 1),
      gapsMs: { min: Math.min(...listings.gapsMs), max: Math.max(...listings.gapsMs), count: listings.gapsMs.length },
    },
    credits: {
      callsPerMinute: credit1.calls / minutes,
      byMethodPerMinute: Object.fromEntries(Object.entries(credit1.byMethod).map(([method, n]) => [method, Math.round((n / minutes) * 100) / 100])),
      byProcessKindPerMinute: { schedulers: byKind("sched-").calls / minutes, workers: byKind("worker-").calls / minutes },
      measuredPerDay: measuredDay,
      quiet: {
        minutes: quiet.size,
        callsPerMinute: quiet.size === 0 ? null : quiet1.calls / quiet.size,
        byMethodPerMinute: Object.fromEntries(Object.entries(quiet1.byMethod).map(([method, n]) => [method, Math.round((n / Math.max(1, quiet.size)) * 100) / 100])),
        byClassPerMinute: Object.fromEntries(Object.entries(quiet1.byClass).map(([line, v]) => [line, Math.round((v.calls / Math.max(1, quiet.size)) * 100) / 100])),
        perDay: quietDay,
      },
      model,
      // THE GATE'S RATIO, over the quiet minutes: within +15 % of the model for the same token set.
      quietOverModel:
        model?.creditsPerDay === undefined || quiet.size === 0
          ? null
          : { archival1: quietDay.archival1 / model.creditsPerDay.archival1, archival10: quietDay.archival10 / model.creditsPerDay.archival10 },
      measuredOverModel:
        model?.creditsPerDay === undefined
          ? null
          : { archival1: measuredDay.archival1 / model.creditsPerDay.archival1, archival10: measuredDay.archival10 / model.creditsPerDay.archival10 },
      refusedCalls: blocked.length,
      processMeters: finalDb?.["rpcUsage"] ?? null,
      proxyTotalsByClass: creditsOf(calls, 1).byClass,
    },
    drills,
    stopped: existsSync(resolve(OUT, "stopped.json")) ? (JSON.parse(readFileSync(resolve(OUT, "stopped.json"), "utf8")) as unknown) : null,
  };
  writeFileSync(resolve(OUT, "report.json"), JSON.stringify(report, null, 2));
  const a = report.agreement;
  const lines = [
    `window ${report.window.from} → ${report.window.to} (${report.window.minutes} min)`,
    `agreement ${a.percent === null ? "n/a" : a.percent.toFixed(2)} % (${a.agree}/${a.compared}); mismatches: timing ${a.explained.timing}, dry-run ${a.explained.dryRun}, transient ${a.explained.transient}, unexplained ${a.explained.unexplained}; gaps: no-shadow ${a.noShadow}, no-production ${a.noProduction}; frontier slots equal ${a.frontier.equal}/${a.frontier.compared}`,
    `overlap audit: max ${report.overlap.maxRowsSeen} rows over ${report.overlap.auditsRun} audits (${report.overlap.auditsUnavailable} unavailable), final ${String(report.overlap.final)}`,
    `discovery: ${report.discovery.minutesWithExactlyOne}/${report.discovery.judgedMinutes} minutes with exactly one listing; gaps ${report.discovery.gapsMs.min}–${report.discovery.gapsMs.max} ms`,
    `credits/day measured: ${Math.round(measuredDay.archival1)} (archival 1), ${Math.round(measuredDay.archival10)} (archival 10); calls/min ${report.credits.callsPerMinute.toFixed(2)}; refused calls ${report.credits.refusedCalls}`,
    `credits/day over ${quiet.size} quiet minutes: ${Math.round(quietDay.archival1)} (archival 1), ${Math.round(quietDay.archival10)} (archival 10); calls/min ${report.credits.quiet.callsPerMinute?.toFixed(2) ?? "n/a"}`,
    `model: ${model === null ? "not given" : JSON.stringify(model)}`,
    `quiet / model: ${report.credits.quietOverModel === null ? "n/a" : `${report.credits.quietOverModel.archival1.toFixed(3)} (archival 1), ${report.credits.quietOverModel.archival10.toFixed(3)} (archival 10)`}`,
    ...drills.map((drill) => `drill ${String(drill["drill"])}: ${drill["ok"] === true ? "PASS" : "FAIL"}`),
  ];
  writeFileSync(resolve(OUT, "summary.txt"), `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
}

// ── main ──────────────────────────────────────────────────────────────────────
if (ANALYZE !== undefined) {
  analyse();
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
saveMeta();
// A HARNESS THAT DIES STILL TAKES ITS CONTAINER AND ITS CHILDREN WITH IT.
process.on("exit", () => {
  for (const proc of procs) proc.child.kill("SIGKILL");
  proxyChild?.kill("SIGKILL");
  if (meta.pgName !== null && !stopped.some((entry) => entry["what"] === "postgres container")) spawnSync("docker", ["rm", "-f", meta.pgName], { timeout: 30_000 });
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void finish(`received ${signal}`).finally(() => process.exit(0)));
}

try {
  await setup();
} catch (error) {
  event("setup failed", { detail: error instanceof Error ? error.message.slice(0, 500) : String(error) });
  await finish("setup failed");
  process.exit(1);
}
const drillsDone = runDrills();
// THE MINUTE: thirty seconds past each wall-clock minute, between the production sweeps' usual instants.
while (!finishing && Date.now() < meta.endAt!) {
  const next = Math.floor((Date.now() - 30_000) / 60_000) * 60_000 + 90_000;
  if (next > meta.endAt!) {
    // THE WINDOW ENDS BEFORE THE NEXT MINUTE: wait it out, take no sample past it.
    while (!finishing && Date.now() < meta.endAt!) await sleep(1_000);
    break;
  }
  await sleep(Math.max(1_000, next - Date.now()));
  if (finishing) break;
  try {
    await minute();
  } catch (error) {
    event("minute failed", { detail: error instanceof Error ? error.message.slice(0, 300) : String(error) });
  }
}
await drillsDone;
await finish("the window ended");
process.exit(0);
