// THE LOCAL SHADOW (plan §3.3.2, P3b): the dispatcher's real entry points run
// against MAINNET, READ-ONLY, beside production, and compared with it once a
// minute. Started by hand (test-local/shadow/README.md), never by a test run and
// never by an image: .dockerignore keeps test-local/ out of every build context.
//
//   node --import tsx test-local/shadow/harness.ts --state <dir> [--resume]
//        [--minutes 55 | --target-hours 168] [--pg-volume <name>]
//        [--drills worker-kill@10,worker-sigterm@17,scheduler-kill@24,pg-pause@31,pg-outage@38 | week | none]
//        [--drill-repeat-hours 0] [--drill-warmup-minutes 5] [--drill-spacing-minutes 5]
//        [--proxy <census-proxy.mjs>] [--model <model.py>]
//        [--production <profit-url>,<volume-url> | none] [--cuts <tokens>] [--report-every-minutes 30]
//   node --import tsx test-local/shadow/harness.ts --analyze <dir> [--model <model.py>]
//   (--out <dir> is --state <dir>, the name the 55-minute run used.)
//
// WHAT IT STARTS, AND STOPS AGAIN (every one is in report.json's `stopped`):
//   * Postgres 16 in Docker, its own container (published on 127.0.0.1 only,
//     trust auth: there is no password to hold), the keeper's own
//     sql/sip_solana.sql applied. Without --pg-volume: sip-shadow-pg-<hex>,
//     `--rm`, its data gone with it. With --pg-volume <name>: the data lives in
//     that NAMED volume (labelled with the state directory, and refused if it
//     belongs to anything else), the container is still removed at every stop,
//     and the next session finds the database where this one left it;
//   * THE CENSUS PROXY (census-proxy.mjs, disp-measure's measuring proxy) on the
//     loopback: the ONLY way out to the chain. It forwards to the public
//     https://api.mainnet-beta.solana.com and nothing else, REFUSES every send*
//     method and every websocket, and writes one line per JSON-RPC call — the
//     lines the listings and the credits are counted from;
//   * a RELAY in this process, in front of the proxy, one path per child process
//     (sched-a, worker-a, …) so the proxy's lines say who asked; the drills
//     freeze a path to hold a worker mid-job, or to give a scheduler calls that
//     never return;
//   * TWO SCHEDULERS (bin/scheduler.mts; one takes sip-solana-scheduler, one
//     stands by) and TWO WORKERS of two slots (bin/worker.mts), all with
//     SIP_SOLANA_DISPATCH=shadow, started with `env -i` and only the variables
//     below — NO KEY of any kind, no broadcast flag, no Helius, Privy or Jupiter
//     key — and with scripts/bench-offline.mts preloaded, so a request to any
//     host but the loopback is refused inside the process (a would-be Jupiter
//     quote included);
//   * the operator's bin/dispatch-handover.mts, as P3b's database needs it:
//     `new-vaults queue`, then `arm --all --roles=none --allow-dry` until moved
//     (a resumed session whose vaults are all in the queue already skips both).
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
//   * COVERAGE: each minute writes a beat (coverage.jsonl). The covered time is
//     the sum of the steps between beats of one session with the fleet up, no
//     longer than one skipped beat; every other step is a GAP, listed with its
//     cause — a sleeping Mac, a crash, a stop, a reboot. The run ends when the
//     covered time reaches its target (--target-hours, else --minutes), never
//     at a wall-clock instant;
//   * THE DRILLS (plan §3.3.2's list), one at a time, each due on the coverage
//     clock:
//       worker-kill        freeze a worker's path until it holds a vault mid-job,
//                          SIGKILL it; the successor must wait the lease out, then
//                          take the vault with a higher fence and finish it;
//       worker-sigterm-0   the same hold, then SIGTERM and SIGKILL at once —
//                          Railway's draining at 0 s: no release can happen, so
//                          it must look exactly like worker-kill;
//       worker-sigterm-30  the same hold, then SIGTERM, and SIGKILL 30 s later
//                          if it still runs (Railway's draining at 30 s): the
//                          drain runs out, the job is aborted, the vault RELEASED
//                          due now, the process exits 0 inside the 30 s, and the
//                          other worker takes the vault without the 45 s wait
//                          (`worker-sigterm`, the 55-minute run's name, is this);
//       scheduler-kill     SIGKILL the lock holder: the standby takes the lock at
//                          its next tick, and that tick is a full pass;
//       scheduler-blocked  freeze the lock holder's path for 240 s: every call it
//                          makes is held and never answered. Its bound is the RPC
//                          pool's 30 s per call: no call may stay held past it, a
//                          tick ends inside the freeze (failed, or on keeper_link's
//                          last-known-good list — none hangs), the process lives
//                          (or its watchdog exits it with code 3 and the standby
//                          takes over), and after the thaw a fresh listing and a
//                          job come back;
//       pg-pause           `docker pause` the database for 20 s: nothing commits,
//                          and everything recovers by itself afterwards. 20 s is
//                          a BRIEF outage: shorter than a lease's 35 s past the
//                          gate margin, so no lease lapses and no gate is refused
//                          for it, and the scheduler's lock check falls inside it
//                          only by chance;
//       pg-outage          hold a worker mid-job, then pause the database for 75 s
//                          — past every held lease and over a whole scheduler
//                          tick — and let the worker's job go on into it: nothing
//                          commits; the held vault's lease lapses inside the pause
//                          and the vault is worked again after it (a higher
//                          fence, or its COMPLETE); the lock holder's session
//                          check fails and it stands by; after the pause a
//                          scheduler takes the lock with a full pass; every
//                          process lives; overlap 0.
//     Each replaced process is restarted, so the fleet is whole again.
//     `--drills week` owes each of the seven once per covered day, at a slot
//     that moves daily (weeklyDrillPlan). A drill with a result is never run
//     again, across any number of resumes; one the harness stopped in the middle
//     of is recorded as interrupted and owed again, once.
//
// A RUN THAT OUTLIVES ITS PROCESS (the 7-day gate on the owner's Mac):
//   * THE STATE DIRECTORY holds everything: the results (JSONL), the logs, the
//     summaries, the run's settings and sessions (run.json), the beats, and the
//     pid files (harness.pid, children.json). A second harness on the same
//     directory refuses to start; a directory that holds a run needs --resume,
//     which continues it WITH THE SETTINGS IT WAS STARTED WITH;
//   * AT RESUME, first: whatever the last session left running is stopped — its
//     children by pid, only if they still run this keeper's code or name this
//     directory, and its container (unpaused, stopped, removed; the data stays
//     in the volume). The gap since its last beat is named: stopped, ended
//     without stopping (killed, crashed, the power), or the Mac restarted (by
//     the machine's boot time);
//   * THE FLEET IS KEPT WHOLE: a process that exits on its own (not a drill's
//     victim) is written to exits.jsonl and replaced, as Railway's ON_FAILURE
//     would, at most ten times an hour;
//   * A ROLLING REPORT: every --report-every-minutes a SEPARATE process runs
//     --analyze (report.json, summary.txt), so this process's event loop — the
//     relay every RPC call crosses — never stalls on a week of files.
//     status.json is rewritten every minute for a one-screen status.
//
// It never prints an environment value. The only URLs it writes are its own
// loopback ones and production's public /status addresses.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DEFAULT_SWEEP_MS } from "../../src/config.js";
import { DISPATCH_STATEMENT_TIMEOUT_MS, GATE_MARGIN_SECONDS, LEASE_SECONDS, OVERLAP_AUDIT_SQL } from "../../src/dispatch-store.js";
import { SIGTERM_DRAIN_MS } from "../../src/explicit-send.js";
import { SIP_PROGRAM_ID } from "../../src/idl.js";
import {
  agreementOf,
  compareAt,
  coverageOf,
  creditsOf,
  drillLedger,
  explainMismatches,
  foldShadowJobs,
  listingsPerMinute,
  perDay,
  productionDecisions,
  replayComparison,
  weeklyDrillPlan,
  type CompareRow,
  type Coverage,
  type CoverageBeat,
  type DrillResultLine,
  type PlannedDrill,
  type ProductionSample,
  type ProxyLine,
  type ShadowWallet,
  type WorkerLogLine,
} from "../../src/shadow-compare.js";

const HARNESS = fileURLToPath(import.meta.url);
const KEEPER_DIR = resolve(dirname(HARNESS), "../..");
const SCHEMA = resolve(KEEPER_DIR, "sql/sip_solana.sql");
const DEFAULT_PROXY = resolve(KEEPER_DIR, "test-local/shadow/census-proxy.mjs");
const DEFAULT_PRODUCTION = [
  "https://sip-solana-keeper-production.up.railway.app/status",
  "https://sip-solana-volume-keeper-production.up.railway.app/status",
];
const DEFAULT_DRILLS = "worker-kill@10,worker-sigterm@17,scheduler-kill@24,pg-pause@31,pg-outage@38";
/** The long run's drills (plan §3.3.2's list), each once per covered day under `--drills week`. */
const WEEK_DRILLS = ["worker-kill", "worker-sigterm-0", "worker-sigterm-30", "scheduler-kill", "scheduler-blocked", "pg-pause", "pg-outage"] as const;
/**
 * pg-pause's 20 s: SHORTER than a held lease's life past the gate's margin
 * (LEASE_SECONDS − GATE_MARGIN_SECONDS = 35 s), so it shows what a brief outage
 * does — statements fail, nothing commits, everything recovers — and NOT the
 * fail-closed paths: no lease lapses, and the scheduler's lock check falls inside
 * it only when a tick happens to (review, 2026-10-13). pg-outage is the long one.
 */
const PG_PAUSE_MS = 20_000;
/**
 * pg-outage's pause: past a held lease's gate margin, and past one whole
 * scheduler tick plus its statement timeout, so the holder's lock check
 * (SELECT 1, DISPATCH_STATEMENT_TIMEOUT_MS) certainly fails inside it.
 */
const PG_OUTAGE_MS = 75_000;
/** When, inside the outage, the worker held mid-job is let go on: its job then meets a database that cannot answer. */
const PG_OUTAGE_THAW_AFTER_MS = 5_000;
if (PG_OUTAGE_MS <= (LEASE_SECONDS - GATE_MARGIN_SECONDS) * 1_000 || PG_OUTAGE_MS <= DEFAULT_SWEEP_MS + DISPATCH_STATEMENT_TIMEOUT_MS) {
  throw new Error("pg-outage's pause must outlast a lease's gate margin and a whole scheduler tick");
}
/** Railway's draining as the plan sets it (RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30): SIGKILL follows SIGTERM after this. */
const RAILWAY_DRAINING_MS = 30_000;
if (SIGTERM_DRAIN_MS >= RAILWAY_DRAINING_MS) throw new Error("a worker's SIGTERM drain must fit inside Railway's 30 s draining");
/** The bound on one RPC call: src/rpc-pool.ts's poolFetch timeout, which bin/scheduler.mts leaves at its default. */
const RPC_CALL_BOUND_MS = 30_000;
/**
 * scheduler-blocked's freeze. A tick whose every call is held makes its calls
 * one after another, each given up at RPC_CALL_BOUND_MS: measured 2026-10-13,
 * two for the chain snapshot, the listing, then keeper_link's re-read — about
 * 4 × 30 s. The freeze must hold a whole such tick, begun up to one sweep after
 * the freeze, and see it end: one sweep + 4 bounds + a minute of margin.
 */
const SCHEDULER_BLOCK_MS = 240_000;
if (SCHEDULER_BLOCK_MS < DEFAULT_SWEEP_MS + 4 * RPC_CALL_BOUND_MS + 60_000) throw new Error("scheduler-blocked must hold a whole tick of calls that each time out");
/** A drill due within this much of the target is not started: it could not finish inside the run. */
const DRILL_END_MARGIN_MS = 3 * 60_000;
/** An interrupted drill is owed again until it has been interrupted this many times. */
const DRILL_MAX_INTERRUPTIONS = 2;
/** Replacements of processes that exited on their own, at most this many an hour: a crash loop is recorded, not fed. */
const RESTARTS_PER_HOUR = 10;
/** The fleet's shape: what keepFleetWhole restores and what a drill waits for. */
const FLEET = { scheduler: 2, worker: 2 } as const;
/**
 * A database that has not answered, or a proxy that is gone, for this long
 * outside any drill ends the session with code 1: mac/start.sh's loop resumes
 * it with a fresh container on the same volume (Docker Desktop restarted, a
 * container that died). Those minutes are gaps, never covered.
 */
const BROKEN_SESSION_MS = 5 * 60_000;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

// ── arguments ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const ANALYZE = option("analyze");
const STATE = option("state") ?? option("out");
const OUT = resolve(ANALYZE ?? STATE ?? "");
if (ANALYZE === undefined && STATE === undefined) {
  console.error("usage: harness.ts --state <dir> [--resume] [--minutes 55 | --target-hours 168] [--pg-volume <name>] [--drills …|week|none] [--proxy …] [--model …] | --analyze <dir>");
  process.exit(2);
}
const RESUME = argv.includes("--resume");
const MODEL_ARG = option("model");

/** What a run is started with, kept in run.json: a resumed session runs with these, not with its own command line. */
interface Settings {
  readonly targetMinutes: number;
  readonly drills: string;
  readonly drillRepeatHours: number;
  readonly drillWarmupMinutes: number;
  readonly drillSpacingMinutes: number;
  readonly proxy: string;
  readonly model: string | null;
  readonly production: readonly string[];
  readonly cuts: string;
  readonly pgImage: string;
  readonly pgVolume: string | null;
  readonly reportEveryMinutes: number;
}

const fromArgs: Settings = {
  targetMinutes: option("target-hours") !== undefined ? Number(option("target-hours")) * 60 : Number(option("minutes") ?? 55),
  drills: option("drills") ?? DEFAULT_DRILLS,
  drillRepeatHours: Number(option("drill-repeat-hours") ?? 0),
  drillWarmupMinutes: Number(option("drill-warmup-minutes") ?? 5),
  drillSpacingMinutes: Number(option("drill-spacing-minutes") ?? 5),
  proxy: resolve(option("proxy") ?? DEFAULT_PROXY),
  model: MODEL_ARG === undefined ? null : resolve(MODEL_ARG),
  production: option("production") === "none" ? [] : (option("production")?.split(",") ?? DEFAULT_PRODUCTION),
  cuts: option("cuts") ?? "",
  pgImage: option("pg-image") ?? "postgres:16-alpine",
  pgVolume: option("pg-volume") ?? null,
  reportEveryMinutes: Number(option("report-every-minutes") ?? 30),
};
if (ANALYZE === undefined) {
  for (const [name, value] of Object.entries(fromArgs)) {
    if (typeof value === "number" && !(Number.isFinite(value) && value >= 0)) {
      console.error(`--${name} must be a number ≥ 0`);
      process.exit(2);
    }
  }
  if (!(fromArgs.targetMinutes > 0)) {
    console.error("the target (--minutes or --target-hours) must be more than 0");
    process.exit(2);
  }
  // A VOLUME NAME OF OURS ONLY: never one of the machine's other projects (sip_sip-db and the like).
  if (fromArgs.pgVolume !== null && !/^sip-shadow-[A-Za-z0-9_.-]{1,50}$/.test(fromArgs.pgVolume)) {
    console.error("--pg-volume must be named sip-shadow-<something> (letters, digits, _ . -)");
    process.exit(2);
  }
}

// ── recording ─────────────────────────────────────────────────────────────────
const iso = (ms: number): string => new Date(ms).toISOString();
const at = (): string => iso(Date.now());
const jsonl = (file: string, value: unknown): void => appendFileSync(resolve(OUT, file), `${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n`);
/** Written whole or not at all: a kill -9 in the middle leaves the previous version, never a torn one. */
const writeJsonAtomic = (file: string, value: unknown): void => {
  const path = resolve(OUT, file);
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${path}.tmp`, path);
};
const readJsonOr = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(resolve(OUT, file), "utf8")) as T;
  } catch {
    return null;
  }
};
const event = (what: string, fields: Record<string, unknown> = {}): void => {
  const line = { at: at(), event: what, ...(session === null ? {} : { session: session.n }), ...fields };
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
/** The command line of a live pid, or "" (no such process). */
const commandOf = (pid: number): string => {
  if (!Number.isInteger(pid) || pid <= 1) return "";
  const result = spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 });
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
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

/** Every child this process started and that still runs, by pid, in children.json: what a resumed session stops first. */
const liveChildren = new Map<number, string>();
const saveChildren = (): void => {
  try {
    writeJsonAtomic("children.json", [...liveChildren].map(([pid, name]) => ({ pid, name })));
  } catch {
    // The directory is gone (an --analyze-only run never gets here): nothing to keep.
  }
};

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
    if (this.pid !== undefined) {
      liveChildren.set(this.pid, name);
      saveChildren();
    }
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
      if (this.pid !== undefined) {
        liveChildren.delete(this.pid);
        saveChildren();
      }
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
/** A request the relay held on a frozen path: when it came, and whether its caller gave up on it or it was let through. */
interface HeldCall {
  readonly tag: string;
  readonly at: number;
  abandonedAfterMs: number | null;
  releasedAfterMs: number | null;
}

class Relay {
  port = 0;
  readonly calls = new Map<string, number>();
  readonly #frozen = new Set<string>();
  readonly #held = new Map<string, { readonly response: ServerResponse; readonly body: string; readonly call: HeldCall }[]>();
  readonly #heldCalls: HeldCall[] = [];
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

  /** The calls held on a path since an instant: each with how long its caller waited before giving up, or before the thaw let it through. */
  heldCalls(tag: string, since: number): readonly HeldCall[] {
    return this.#heldCalls.filter((call) => call.tag === tag && call.at >= since);
  }

  /** Let the path answer again; requests held from a process still alive go on to the proxy. */
  thaw(tag: string): void {
    this.#frozen.delete(tag);
    const held = this.#held.get(tag) ?? [];
    this.#held.delete(tag);
    for (const entry of held) {
      if (entry.response.destroyed || entry.response.socket?.destroyed === true) continue;
      entry.call.releasedAfterMs = Date.now() - entry.call.at;
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
      const call: HeldCall = { tag, at: Date.now(), abandonedAfterMs: null, releasedAfterMs: null };
      this.#heldCalls.push(call);
      // A WEEK OF DRILLS KEEPS AN HOUR OF HELD CALLS: the drills read only their own.
      while (this.#heldCalls.length > 0 && this.#heldCalls[0]!.at < Date.now() - 3_600_000) this.#heldCalls.shift();
      // THE CALLER GAVE UP (its own timeout closed the connection) before the path was thawed.
      response.on("close", () => {
        if (call.releasedAfterMs === null && call.abandonedAfterMs === null) call.abandonedAfterMs = Date.now() - call.at;
      });
      const list = this.#held.get(tag) ?? [];
      list.push({ response, body, call });
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
  /** A drill ended it on purpose: not an exit "on its own". */
  byDrill: boolean;
  /** Its exit has been looked at by keepFleetWhole. */
  accounted: boolean;
}

/** One start of the harness on the run's state directory. */
interface Session {
  readonly n: number;
  readonly pid: number;
  readonly startedAt: string;
  steadyStart: number | null;
  endedAt: string | null;
  endReason: string | null;
  /** Why the run was not beating before this session began: the cause the coverage clock names its gap by. */
  readonly resumeCause: string | null;
}

interface RunMeta {
  pgName: string | null;
  pgPort: number | null;
  proxyPort: number | null;
  relayPort: number | null;
  startedAt: string;
  /** The first session's; each session's own is in `sessions`. */
  steadyStart: number | null;
  /** Unused since the coverage clock: the run ends on covered time, not at an instant. */
  endAt: number | null;
  program: string;
  cuts: string;
  /** The coverage target in minutes (the name a run from before the coverage clock used for its window). */
  minutes: number;
  targetMinutes: number;
  drills: string;
  drillRepeatHours: number;
  drillWarmupMinutes: number;
  drillSpacingMinutes: number;
  proxy: string;
  production: readonly string[];
  model: string | null;
  pgImage: string;
  pgVolume: string | null;
  reportEveryMinutes: number;
  letters: { scheduler: number; worker: number };
  sessions: Session[];
  completedAt: string | null;
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
  cuts: fromArgs.cuts,
  minutes: fromArgs.targetMinutes,
  targetMinutes: fromArgs.targetMinutes,
  drills: fromArgs.drills,
  drillRepeatHours: fromArgs.drillRepeatHours,
  drillWarmupMinutes: fromArgs.drillWarmupMinutes,
  drillSpacingMinutes: fromArgs.drillSpacingMinutes,
  proxy: fromArgs.proxy,
  production: fromArgs.production,
  model: fromArgs.model,
  pgImage: fromArgs.pgImage,
  pgVolume: fromArgs.pgVolume,
  reportEveryMinutes: fromArgs.reportEveryMinutes,
  letters: { scheduler: 0, worker: 0 },
  sessions: [],
  completedAt: null,
};
const settingsOf = (m: RunMeta): Settings => ({
  targetMinutes: m.targetMinutes,
  drills: m.drills,
  drillRepeatHours: m.drillRepeatHours,
  drillWarmupMinutes: m.drillWarmupMinutes,
  drillSpacingMinutes: m.drillSpacingMinutes,
  proxy: m.proxy,
  model: m.model,
  production: m.production,
  cuts: m.cuts,
  pgImage: m.pgImage,
  pgVolume: m.pgVolume,
  reportEveryMinutes: m.reportEveryMinutes,
});
let S: Settings = fromArgs;
const saveMeta = (): void => writeJsonAtomic("run.json", meta);

const procs: Proc[] = [];
const shadow = new Map<string, ShadowWallet>();
const recentRows: CompareRow[] = [];
const stopped: Record<string, unknown>[] = [];
let session: Session | null = null;
let proxyChild: Child | null = null;
let relay: Relay | null = null;
let db: pg.Pool | null = null;
let databaseUrl = "";
let finishing = false;
/** The one finish of this session: a signal and the end of the run share it, and the process exits only after it. */
let finished: Promise<void> | null = null;
/** The container THIS process started, and whether it has been stopped: the only one its exit may touch. */
let ownContainer: string | null = null;
let containerStopped = false;
/** The coverage clock, recomputed at every beat from every beat of the run. */
const beats: CoverageBeat[] = [];
let coverage: Coverage = coverageOf([]);
let plan: readonly PlannedDrill[] = [];
let drillResults: (DrillResultLine & Record<string, unknown>)[] = [];
let currentDrill: string | null = null;
let lastDrillEnd = 0;
let overlapMax = 0;
let overlapLast: number | null = null;
/** Since when the database has not answered the minute's audit outside a drill; null while it answers. */
let dbDownSince: number | null = null;
/** The code this session exits with: 1 when it ended itself because it could not work (the loop resumes it). */
let exitCode = 0;
let exitsOnTheirOwn = 0;
const restarts: number[] = [];
let restartLimitLoggedAt = 0;
let analysisChild: ChildProcess | null = null;
let lastReportAt = 0;

const docker = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 120_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

const query = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> => (await db!.query<T>(text, values)).rows;

const alive = (kind: Proc["kind"]): Proc[] => procs.filter((proc) => proc.kind === kind && proc.child.exited === null);
/** How the census proxy exited, or null while it runs (or before it started). */
const proxyExit = (): number | string | null => proxyChild?.exited ?? null;
const fleetWhole = (): boolean => alive("scheduler").length >= FLEET.scheduler && alive("worker").length >= FLEET.worker;

const shared = (tag: string): Record<string, string> => ({
  SIP_SOLANA_RPC_URLS: relay!.url(tag),
  SIP_SOLANA_PROGRAM_ID: SIP_PROGRAM_ID,
  DATABASE_URL: databaseUrl,
  SIP_SOLANA_DISPATCH: "shadow",
  ...(S.cuts === "" ? {} : { SIP_SOLANA_CUTS: S.cuts }),
});

/** Start a scheduler or a worker and learn its worker_id from the row it registers at boot. */
async function startProc(kind: Proc["kind"]): Promise<Proc> {
  // LETTERED ACROSS THE WHOLE RUN: a resumed session goes on from the last letter, so no log file is shared.
  const n = meta.letters[kind];
  meta.letters[kind] += 1;
  saveMeta();
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
  const proc: Proc = { name, kind, tag: name, child, id: null, byDrill: false, accounted: false };
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
  if (proc.id === null) {
    child.kill("SIGKILL");
    throw new Error(`${name} registered no worker row within 90 s; see logs/${name}.log`);
  }
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

// ── the database's container ──────────────────────────────────────────────────
const STATE_LABEL = "sip.shadow.state";
/** The container of a run with a named volume: one name per volume, so a resume finds what the last session left. */
const containerFor = (volume: string): string => (volume.endsWith("-pgdata") ? `${volume.slice(0, -"-pgdata".length)}-pg` : `${volume}-pg`);

/** The named volume, created with this run's label, or verified to carry it: a volume of anything else is refused, never mounted. */
function ensureVolume(volume: string): "created" | "found" {
  const label = docker("volume", "inspect", "-f", `{{ index .Labels "${STATE_LABEL}" }}`, volume);
  if (label.status === 0) {
    if (label.stdout.trim() !== OUT) throw new Error(`the docker volume ${volume} exists and is not this run's (its ${STATE_LABEL} label is not ${OUT}); pick another --pg-volume`);
    return "found";
  }
  const created = docker("volume", "create", "--label", `${STATE_LABEL}=${OUT}`, volume);
  if (created.status !== 0) throw new Error(`docker volume create failed: ${created.stderr.slice(0, 300)}`);
  return "created";
}

/** A container of this name the last session left (a kill, a crash): unpaused, stopped, removed — only if it carries this run's label. */
function removeLeftoverContainer(name: string): string | null {
  const found = docker("ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.State}}").stdout.trim();
  if (found === "") return null;
  const label = docker("inspect", "-f", `{{ index .Config.Labels "${STATE_LABEL}" }}`, name).stdout.trim();
  if (label !== OUT) throw new Error(`a container named ${name} exists and is not this run's; it is left alone, and this run will not start`);
  docker("unpause", name);
  docker("stop", "-t", "30", name);
  docker("rm", "-f", name);
  return found;
}

// ── setup ─────────────────────────────────────────────────────────────────────
async function setup(): Promise<void> {
  mkdirSync(resolve(OUT, "logs"), { recursive: true });
  mkdirSync(resolve(OUT, "rpc"), { recursive: true });
  if (!existsSync(S.proxy)) throw new Error(`no census proxy at ${S.proxy}`);
  event("harness starting", {
    out: OUT,
    resumed: session!.n > 1,
    targetHours: S.targetMinutes / 60,
    drills: S.drills,
    cuts: S.cuts || "none",
    pgVolume: S.pgVolume ?? "none (the data goes with the container)",
    program: SIP_PROGRAM_ID,
    node: process.version,
  });

  // POSTGRES 16, OURS ALONE: the loopback only, trust auth (no password exists to leak), and our label.
  let pgName: string;
  const runArgs = ["run", "--rm", "-d", "--label", `${STATE_LABEL}=${OUT}`, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-p", "127.0.0.1::5432"];
  if (S.pgVolume !== null) {
    const volume = ensureVolume(S.pgVolume);
    pgName = containerFor(S.pgVolume);
    const leftover = removeLeftoverContainer(pgName);
    if (leftover !== null) event("the last session's container was still there: stopped and removed (its data is in the volume)", { container: pgName, state: leftover });
    runArgs.push("--name", pgName, "-v", `${S.pgVolume}:/var/lib/postgresql/data`);
    event("database volume", { volume: S.pgVolume, state: volume });
  } else {
    pgName = `sip-shadow-pg-${randomBytes(4).toString("hex")}`;
    runArgs.push("--name", pgName);
  }
  const run = docker(...runArgs, S.pgImage);
  if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr.slice(0, 300)}`);
  ownContainer = pgName;
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
      // A first start runs initdb, and a resumed one may replay its WAL after a hard stop: both before the port answers.
      if (Date.now() - ready > 180_000) throw new Error("the database did not accept connections within 3 minutes");
      await sleep(500);
    }
  }
  const existed = (await admin.query("SELECT 1 FROM pg_database WHERE datname = 'shadow'")).rowCount === 1;
  if (!existed) await admin.query("CREATE DATABASE shadow");
  await admin.end();
  databaseUrl = `postgres://postgres@127.0.0.1:${mapped}/shadow?sslmode=disable`;
  db = new pg.Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000, query_timeout: 8_000 });
  db.on("error", () => undefined);
  // IDEMPOTENT (its header says so): applied again on a resumed database, it changes nothing.
  await db.query(readFileSync(SCHEMA, "utf8"));
  event("database ready", { container: pgName, port: meta.pgPort, image: S.pgImage, database: existed ? "found (resumed)" : "created" });

  // THE CENSUS PROXY: the only way out to the chain.
  const proxyPort = await freePortPair();
  meta.proxyPort = proxyPort;
  proxyChild = new Child("census-proxy", process.execPath, [S.proxy, "--port", String(proxyPort), "--log", resolve(OUT, "rpc/calls.jsonl")], {});
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
  const [fleetRow] = await query<{ new_vault_system: string }>("SELECT new_vault_system FROM sip_solana.fleet");
  if (fleetRow?.new_vault_system === "queue") event("handover skipped: new vaults already go to the queue");
  else if ((await handover("new-vaults", "queue")) !== 0) throw new Error("dispatch-handover new-vaults queue failed; see logs/handover-new-vaults.log");

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
  const allQueued = async (): Promise<boolean> => {
    const systems = await query<{ system: string }>("SELECT DISTINCT system FROM sip_solana.vault_work");
    return systems.length === 1 && systems[0]!.system === "queue";
  };
  if (await allQueued()) {
    event("armed already: every vault is in the queue");
  } else {
    const armStarted = Date.now();
    for (;;) {
      const code = await handover("arm", "--all", "--roles=none", "--allow-dry");
      if (code === 0 && (await allQueued())) break;
      if (Date.now() - armStarted > 6 * 60_000) throw new Error("arm did not move the vaults to the queue within 6 minutes");
      await sleep(20_000);
    }
    event("armed", { tookMs: Date.now() - armStarted });
  }

  await startProc("worker");
  await startProc("worker");
  session!.steadyStart = Date.now();
  meta.steadyStart ??= session!.steadyStart;
  saveMeta();
  event("fleet up", { steadyStart: iso(session!.steadyStart), coveredHours: coverage.coveredMs / 3_600_000, targetHours: S.targetMinutes / 60 });
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

/** Why a session's gap began, by session number: what the coverage clock names the step across two sessions by. */
const sessionCause = (n: number): string | undefined => meta.sessions.find((s) => s.n === n)?.resumeCause ?? undefined;

async function minute(): Promise<void> {
  const now = Date.now();
  if (S.production.length === 2) {
    const [profit, volume] = await Promise.all(S.production.map((url) => fetchStatus(url)));
    jsonl("production.jsonl", { at: iso(now), profit: { status: profit!.status, body: trimmed(profit!.body) }, volume: { status: volume!.status, body: trimmed(volume!.body) } });
    // THE INVEST PER VAULT: the vaults are the ones the workers' jobs named.
    const rows = compareAt(Date.now(), productionDecisions(profit!.body, volume!.body, (wallet) => shadow.get(wallet)?.vault), shadow);
    for (const row of rows) jsonl("compare.jsonl", row);
    recentRows.push(...rows);
    if (recentRows.length > 50) recentRows.splice(0, recentRows.length - 50);
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
    audit = { at: iso(now), overlapRows: overlap.length, intents, work, workers, fleet: fleet[0] ?? null };
    overlapLast = overlap.length;
    overlapMax = Math.max(overlapMax, overlap.length);
  } catch (error) {
    audit = { at: iso(now), unavailable: error instanceof Error ? error.message.slice(0, 200) : "error" };
  }
  jsonl("audit.jsonl", audit);
  // THE BEAT: what the coverage clock is read from. The shadow could work only with processes, a database that
  // answers and a proxy — a drill's deliberate outage excepted.
  const schedulers = alive("scheduler").length;
  const workers = alive("worker").length;
  const dbAnswered = audit["unavailable"] === undefined;
  const proxyUp = proxyChild !== null && proxyChild.exited === null;
  dbDownSince = dbAnswered || currentDrill !== null ? null : (dbDownSince ?? now);
  const beat = { at: now, session: session!.n, fleetUp: schedulers >= 1 && workers >= 1 && proxyUp && (dbAnswered || currentDrill !== null) };
  jsonl("coverage.jsonl", { at: iso(now), session: beat.session, fleetUp: beat.fleetUp, schedulers, workers, database: dbAnswered, proxy: proxyUp, drill: currentDrill });
  beats.push(beat);
  coverage = coverageOf(beats, { sessionCause });
  writeStatus(true);
  const recent = recentRows.filter((row) => row.at >= now - 1_000);
  console.log(
    JSON.stringify({
      at: iso(now),
      coveredHours: Math.round((coverage.coveredMs / 3_600_000) * 100) / 100,
      compare: recent.map((row) => `${row.wallet.slice(0, 4)}:${row.verdict}`).join(" "),
      overlapRows: audit["overlapRows"] ?? "unavailable",
      alive: procs.filter((proc) => proc.child.exited === null).map((proc) => proc.name),
      drill: currentDrill,
    }),
  );
}

/** status.json: the one screen's numbers, rewritten every minute (and at the end, with running false). */
function writeStatus(running: boolean): void {
  const ledger = drillLedger(plan, drillResults, DRILL_MAX_INTERRUPTIONS);
  const gapMs = coverage.gaps.reduce((sum, gap) => sum + gap.ms, 0);
  writeJsonAtomic("status.json", {
    at: at(),
    running,
    pid: process.pid,
    session: session?.n ?? null,
    sessionStartedAt: session?.startedAt ?? null,
    steadySince: session?.steadyStart == null ? null : iso(session.steadyStart),
    coveredHours: coverage.coveredMs / 3_600_000,
    targetHours: S.targetMinutes / 60,
    lastBeatAt: coverage.lastBeatAt === null ? null : iso(coverage.lastBeatAt),
    gaps: {
      count: coverage.gaps.length,
      hours: gapMs / 3_600_000,
      last: coverage.gaps.slice(-5).map((gap) => ({ from: iso(gap.from), to: iso(gap.to), minutes: Math.round(gap.ms / 6_000) / 10, cause: gap.cause })),
    },
    alive: procs.filter((proc) => proc.child.exited === null).map((proc) => proc.name),
    overlap: { lastAudit: overlapLast, maxSeen: overlapMax },
    drills: {
      planned: plan.length,
      done: ledger.done.length,
      passed: ledger.done.filter((drill) => drill.ok).length,
      failed: ledger.done.filter((drill) => !drill.ok).map((drill) => drill.id),
      interruptedAttempts: Object.values(ledger.interrupted).reduce((sum, n) => sum + n, 0),
      gaveUp: ledger.gaveUp,
      owed: ledger.owed.length,
      running: currentDrill,
      next: ledger.owed[0] === undefined ? null : { id: ledger.owed[0].id, atCoveredHours: ledger.owed[0].atCoveredMs / 3_600_000 },
    },
    exitsOnTheirOwn,
    completedAt: meta.completedAt,
  });
}

/** Railway's ON_FAILURE, here: a process that exited on its own is recorded and replaced. Never while a drill runs (the drill replaces its own victims). */
async function keepFleetWhole(): Promise<void> {
  if (finishing || currentDrill !== null || session?.steadyStart == null) return;
  for (const proc of procs) {
    if (proc.child.exited === null || proc.accounted) continue;
    proc.accounted = true;
    // ITS LINES ARE NOT NEEDED ANY MORE: a week of replacements must not keep 3,000 lines each.
    proc.child.ring.splice(0);
    if (proc.byDrill) continue;
    exitsOnTheirOwn += 1;
    const line = { at: at(), session: session.n, name: proc.name, kind: proc.kind, pid: proc.child.pid, exit: proc.child.exited, warnings: proc.child.warnings, errors: proc.child.errors };
    jsonl("exits.jsonl", line);
    event("process exited on its own", line);
  }
  for (const kind of ["scheduler", "worker"] as const) {
    while (!finishing && currentDrill === null && alive(kind).length < FLEET[kind]) {
      const hourAgo = Date.now() - 3_600_000;
      if (restarts.filter((t) => t > hourAgo).length >= RESTARTS_PER_HOUR) {
        if (Date.now() - restartLimitLoggedAt > 3_600_000) {
          restartLimitLoggedAt = Date.now();
          event("restart limit reached: the fleet stays short until the hour passes", { kind, limitPerHour: RESTARTS_PER_HOUR });
        }
        break;
      }
      restarts.push(Date.now());
      try {
        const replacement = await startProc(kind);
        event("replaced to keep the fleet whole", { kind, replacement: replacement.name });
      } catch (error) {
        event("a replacement failed to start", { kind, detail: error instanceof Error ? error.message.slice(0, 300) : String(error) });
        break;
      }
    }
  }
}

/** The rolling report: --analyze in its own process, so this one's event loop (the relay) never waits on a week of files. */
function rollingReport(): void {
  if (analysisChild !== null || finishing) return;
  lastReportAt = Date.now();
  const log = openSync(resolve(OUT, "logs", "analyze.log"), "a");
  const child = spawn(process.execPath, ["--import", "tsx", HARNESS, "--analyze", OUT], {
    cwd: KEEPER_DIR,
    stdio: ["ignore", log, log],
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: process.env["HOME"] ?? "/tmp" },
  });
  analysisChild = child;
  if (child.pid !== undefined) {
    liveChildren.set(child.pid, "analyze");
    saveChildren();
  }
  child.on("exit", (code) => {
    closeSync(log);
    if (child.pid !== undefined) {
      liveChildren.delete(child.pid);
      saveChildren();
    }
    analysisChild = null;
    if (code !== 0 && !finishing) event("the rolling report failed; see logs/analyze.log", { exit: code });
  });
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

/**
 * worker-kill, and worker-sigterm-0 (`sigtermFirst`): Railway's draining at 0 s
 * sends SIGTERM and SIGKILL in the same instant, so the SIGTERM handler gets no
 * time to release — the lease must run out, exactly as for a plain SIGKILL
 * (ADR §4.9 row 27).
 */
async function drillWorkerKill(sigtermFirst: boolean): Promise<Record<string, unknown>> {
  const workers = alive("worker");
  if (workers.length < 2) return { ok: false, detail: "fewer than two live workers" };
  const victim = workers[0]!;
  const held = await holdMidJob(victim);
  if (held === null) return { ok: false, detail: `${victim.name} held no vault mid-job within 4 minutes of its path being frozen` };
  const killAt = await dbNow();
  victim.byDrill = true;
  if (sigtermFirst) victim.child.kill("SIGTERM");
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
  return {
    ok,
    victim: victim.name,
    signals: sigtermFirst ? "SIGTERM, then SIGKILL in the same instant (Railway's draining at 0 s)" : "SIGKILL",
    exit,
    vaults,
    openIntentsOfVictimAfter: openOfVictim,
    overlapRows: overlap,
    replacement: replacement.name,
  };
}

/** worker-sigterm-30: SIGTERM, and SIGKILL at Railway's 30 s if the process still runs. */
async function drillWorkerSigterm(): Promise<Record<string, unknown>> {
  const workers = alive("worker");
  if (workers.length < 2) return { ok: false, detail: "fewer than two live workers" };
  const victim = workers[0]!;
  const held = await holdMidJob(victim);
  if (held === null) return { ok: false, detail: `${victim.name} held no vault mid-job within 4 minutes of its path being frozen` };
  const termAt = await dbNow();
  const termLocal = Date.now();
  victim.byDrill = true;
  victim.child.kill("SIGTERM");
  // THE PATH STAYS FROZEN: the job cannot end by itself, so the drain runs out and the job is aborted.
  let exit = await victim.child.exit(RAILWAY_DRAINING_MS);
  const exitAfterMs = Date.now() - termLocal;
  // RAILWAY'S SIGKILL AT THE END OF ITS DRAINING: a worker still running at 30 s fails the drill.
  const killedAtDeadline = exit === null;
  if (exit === null) {
    victim.child.kill("SIGKILL");
    exit = await victim.child.exit(10_000);
  }
  relay!.thaw(victim.tag);
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
    !killedAtDeadline &&
    row?.stopped === true &&
    released >= held.length &&
    vaults.every((v) => v.releasedAfterTermMs !== null && v.releasedAfterTermMs <= SIGTERM_DRAIN_MS + 5_000 && v.claimedAfterReleaseMs !== null && v.claimedAfterReleaseMs < 10_000 && v.completedOutcome !== null) &&
    overlap === 0;
  return {
    ok,
    victim: victim.name,
    exit,
    exitAfterTermMs: exitAfterMs,
    railwayDrainingMs: RAILWAY_DRAINING_MS,
    killedAtDeadline,
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
  active.byDrill = true;
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

/**
 * scheduler-blocked: the lock holder's every RPC call is held by the relay and
 * never answered, for SCHEDULER_BLOCK_MS. What bounds it is the RPC pool's
 * per-call timeout (RPC_CALL_BOUND_MS): each call must be given up within it,
 * so a tick ends inside the freeze (failed, or on keeper_link's last-known-good
 * list) instead of hanging, and the process lives on. The watchdog's own exit, for a wedge no
 * timeout covers, is test/watchdog.test.ts's: if it fires here anyway (code 3),
 * the standby must have taken the lock. After the thaw: a fresh listing and a
 * completed job.
 */
async function drillSchedulerBlocked(): Promise<Record<string, unknown>> {
  const [fleet] = await query<{ scheduler_id: string | null }>("SELECT scheduler_id FROM sip_solana.fleet");
  const schedulers = alive("scheduler");
  const active = schedulers.find((proc) => proc.id === fleet?.scheduler_id);
  const standby = schedulers.find((proc) => proc !== active);
  if (active === undefined || standby === undefined) return { ok: false, detail: "no acting scheduler with a live standby" };
  // IF ITS WATCHDOG ENDS IT, THAT IS THIS DRILL'S DOING, not an exit on its own.
  active.byDrill = true;
  const freezeAt = Date.now();
  relay!.freeze(active.tag);
  await sleep(SCHEDULER_BLOCK_MS);
  const thawAt = Date.now();
  const calls = relay!.heldCalls(active.tag, freezeAt).map((call) => ({ ...call }));
  relay!.thaw(active.tag);
  const during = active.child.since(freezeAt, thawAt);
  const ticks = {
    failed: during.filter((entry) => entry.line.event === "scheduler tick failed").length,
    actedOnLastKnownGood: during.filter((entry) => entry.line.event === "scheduler tick" && (entry.line["discovery"] as { source?: unknown } | undefined)?.source !== "fresh").length,
    actedFresh: during.filter((entry) => entry.line.event === "scheduler tick" && (entry.line["discovery"] as { source?: unknown } | undefined)?.source === "fresh").length,
    listingFellBack: during.filter((entry) => entry.line.event === "the link listing failed; this tick schedules keeper_link's last-known-good list").length,
  };
  // EACH HELD CALL: given up by its caller within the bound, or still inside the bound when the thaw let it through.
  const heldPastBound = calls.filter((call) => (call.abandonedAfterMs ?? call.releasedAfterMs ?? thawAt - call.at) > RPC_CALL_BOUND_MS + 5_000);
  // AFTER THE THAW: a tick with a fresh listing (any scheduler), and a job done.
  let freshAfter: { process: string; afterThawMs: number } | null = null;
  let jobAfter: number | null = null;
  const waitFrom = Date.now();
  while (Date.now() - waitFrom < 180_000 && (freshAfter === null || jobAfter === null)) {
    for (const proc of procs) {
      if (proc.kind === "scheduler" && freshAfter === null) {
        const tick = proc.child.since(thawAt).find((entry) => entry.line.event === "scheduler tick" && (entry.line["discovery"] as { source?: unknown } | undefined)?.source === "fresh");
        if (tick !== undefined) freshAfter = { process: proc.name, afterThawMs: tick.at - thawAt };
      }
      if (proc.kind === "worker" && jobAfter === null) {
        const job = proc.child.find("job done", thawAt);
        if (job !== undefined) jobAfter = job.at - thawAt;
      }
    }
    await sleep(500);
  }
  const watchdogExit = active.child.exited;
  const standbyTook = standby.child.find("took the scheduler lock: this tick is a full pass", freezeAt) !== undefined;
  const lived = watchdogExit === null;
  const overlap = await auditRows();
  const replacement = lived ? null : await startProc("scheduler");
  if (lived) active.byDrill = false;
  const ok =
    calls.length > 0 &&
    heldPastBound.length === 0 &&
    ticks.failed + ticks.actedOnLastKnownGood + ticks.actedFresh >= 1 &&
    (lived || (watchdogExit === 3 && standbyTook)) &&
    freshAfter !== null &&
    jobAfter !== null &&
    overlap === 0;
  return {
    ok,
    blocked: active.name,
    standby: standby.name,
    blockedMs: thawAt - freezeAt,
    boundMs: RPC_CALL_BOUND_MS,
    heldCalls: calls.length,
    abandonedWithinMs: calls.length === 0 ? null : Math.max(...calls.map((call) => call.abandonedAfterMs ?? 0)),
    stillHeldAtThaw: calls.filter((call) => call.abandonedAfterMs === null).length,
    heldPastBound: heldPastBound.length,
    ticksDuringBlock: ticks,
    processLived: lived,
    exit: watchdogExit,
    standbyTookTheLock: standbyTook,
    freshListingAfterThaw: freshAfter,
    jobDoneAfterThawMs: jobAfter,
    overlapRows: overlap,
    replacement: replacement?.name ?? null,
  };
}

async function drillPgPause(): Promise<Record<string, unknown>> {
  const pgName = ownContainer!;
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

async function drillPgOutage(): Promise<Record<string, unknown>> {
  const pgName = ownContainer!;
  const workers = alive("worker");
  if (workers.length < 1) return { ok: false, detail: "no live worker" };
  const victim = workers[0]!;
  // A WORKER MID-JOB FIRST (its path frozen, as worker-kill holds one): the outage must find a job in flight.
  const held = await holdMidJob(victim);
  if (held === null) return { ok: false, detail: `${victim.name} held no vault mid-job within 4 minutes of its path being frozen` };
  const [before] = await query<{ scheduler_id: string | null }>("SELECT scheduler_id FROM sip_solana.fleet");
  const holder = procs.find((proc) => proc.id === (before?.scheduler_id ?? null)) ?? null;
  // THE LEASES AS THE PAUSE FINDS THEM (the database's clock), and who is running.
  const leases = await query<{ vault_addr: string; fence: string; lease_ms: string }>(
    `SELECT vault_addr, fence::text, (extract(epoch FROM lease_until) * 1000)::bigint::text AS lease_ms FROM sip_solana.vault_work WHERE holder = $1`,
    [victim.id],
  );
  const running = procs.filter((proc) => proc.child.exited === null);
  const pauseDb = await dbNow();
  const pauseAt = Date.now();
  const paused = docker("pause", pgName);
  if (paused.status !== 0) {
    relay!.thaw(victim.tag);
    return { ok: false, detail: `docker pause failed: ${paused.stderr.slice(0, 200)}` };
  }
  // THE HELD JOB GOES ON INTO THE OUTAGE: its next heartbeat, gate or COMPLETE meets a database that cannot answer.
  await sleep(PG_OUTAGE_THAW_AFTER_MS);
  relay!.thaw(victim.tag);
  await sleep(PG_OUTAGE_MS - PG_OUTAGE_THAW_AFTER_MS);
  const unpaused = docker("unpause", pgName);
  const unpauseAt = Date.now();
  if (unpaused.status !== 0) return { ok: false, detail: `docker unpause failed: ${unpaused.stderr.slice(0, 200)}` };
  const unpauseDb = await dbNow();
  // RECOVERY: a tick that TOOK the lock — a full pass — and a job done, both after the pause.
  let takeover: { process: string; afterUnpauseMs: number; fullPass: unknown; lanes: unknown } | null = null;
  let jobAfter: number | null = null;
  const waitFrom = Date.now();
  while (Date.now() - waitFrom < 180_000 && (takeover === null || jobAfter === null)) {
    for (const proc of procs) {
      if (proc.kind === "scheduler" && takeover === null) {
        const tick = proc.child.since(unpauseAt).find((entry) => entry.line.event === "scheduler tick" && entry.line["tookOver"] === true);
        if (tick !== undefined) takeover = { process: proc.name, afterUnpauseMs: tick.at - unpauseAt, fullPass: tick.line["fullPass"] ?? null, lanes: tick.line["lanes"] ?? null };
      }
      if (proc.kind === "worker" && jobAfter === null) {
        const job = proc.child.find("job done", unpauseAt);
        if (job !== undefined) jobAfter = job.at - unpauseAt;
      }
    }
    await sleep(500);
  }
  // THE HOLDER'S LOCK CHECK FAILED INSIDE THE PAUSE (its statement timeout may fire a moment after the end).
  const lockLost =
    holder === null
      ? []
      : holder.child
          .since(pauseAt, unpauseAt + DISPATCH_STATEMENT_TIMEOUT_MS)
          .filter((entry) => entry.line.event === "the scheduler lost its lock's session; it stands by and asks again next tick");
  // EACH HELD VAULT: its lease ran out inside the pause, and after it the vault was worked again.
  const vaults = await Promise.all(
    leases.map(async (lease) => {
      let after: VaultState | null = null;
      const followFrom = Date.now();
      while (Date.now() - followFrom < 180_000) {
        after = await vaultState(lease.vault_addr).catch(() => null);
        if (after !== null && (BigInt(after.fence) > BigInt(lease.fence) || (after.holder === null && (after.lastDoneAt ?? 0) >= unpauseDb))) break;
        await sleep(500);
      }
      const reclaimed = after !== null && BigInt(after.fence) > BigInt(lease.fence);
      const completedSameFence = after !== null && !reclaimed && after.holder === null && (after.lastDoneAt ?? 0) >= unpauseDb;
      return {
        vault: lease.vault_addr,
        fenceAtPause: lease.fence,
        leaseRanOutInsidePause: Number(lease.lease_ms) < unpauseDb,
        leaseLeftAtPauseMs: Number(lease.lease_ms) - pauseDb,
        fenceAfter: after?.fence ?? null,
        workedAgain: reclaimed ? "claimed at a higher fence" : completedSameFence ? "completed at its fence" : null,
        by: nameOf(after?.holder ?? after?.lastHolder ?? null),
        lastOutcome: after?.lastOutcome ?? null,
      };
    }),
  );
  const committed = await query<{ intents: number; completions: number }>(
    `SELECT (SELECT count(*)::int FROM sip_solana.send_intent WHERE created_at > to_timestamp($1 / 1000.0) AND created_at < to_timestamp($2 / 1000.0)) AS intents,
            (SELECT count(*)::int FROM sip_solana.vault_work WHERE last_done_at > to_timestamp($1 / 1000.0) AND last_done_at < to_timestamp($2 / 1000.0)) AS completions`,
    [pauseAt + 1_500, unpauseAt - 1_500],
  );
  const parked = (await query("SELECT vault_addr FROM sip_solana.vault_work WHERE parked_reason IS NOT NULL")).length;
  const victimLines = victim.child.since(pauseAt, unpauseAt + 60_000).filter((entry) => entry.line.level === "warn" || entry.line.level === "error");
  const overlap = await auditRows();
  const allAlive = running.every((proc) => proc.child.exited === null);
  const ok =
    committed[0]!.intents === 0 &&
    committed[0]!.completions === 0 &&
    vaults.length > 0 &&
    vaults.every((vault) => vault.leaseRanOutInsidePause && vault.workedAgain !== null) &&
    holder !== null &&
    lockLost.length > 0 &&
    takeover !== null &&
    takeover.fullPass !== null &&
    jobAfter !== null &&
    allAlive &&
    parked === 0 &&
    overlap === 0;
  return {
    ok,
    pausedMs: unpauseAt - pauseAt,
    committedWhilePaused: committed[0],
    victim: victim.name,
    vaults,
    victimWarnings: [...new Set(victimLines.map((entry) => String(entry.line.event)))].slice(0, 10),
    holderBefore: holder?.name ?? "none",
    holderLostItsLockInsidePause: lockLost.length > 0,
    takeoverAfterPause: takeover,
    jobDoneAfterUnpauseMs: jobAfter,
    allAlive,
    parkedVaults: parked,
    overlapRows: overlap,
  };
}

const DRILLS: Record<string, () => Promise<Record<string, unknown>>> = {
  "worker-kill": () => drillWorkerKill(false),
  "worker-sigterm-0": () => drillWorkerKill(true),
  "worker-sigterm-30": drillWorkerSigterm,
  // THE 55-MINUTE RUN'S NAME for the 30 s case.
  "worker-sigterm": drillWorkerSigterm,
  "scheduler-kill": drillSchedulerKill,
  "scheduler-blocked": drillSchedulerBlocked,
  "pg-pause": drillPgPause,
  "pg-outage": drillPgOutage,
};

/**
 * The drills a run owes, each with an id that is the same in every session:
 * `week` → weeklyDrillPlan; `name@minutes,…` → due at that many COVERED
 * minutes (id: the name when it appears once and nothing repeats, else
 * name@minutes, with r<k>- for the k-th repetition); `none` → none.
 */
function drillPlanOf(settings: Pick<Settings, "drills" | "drillRepeatHours" | "targetMinutes">): PlannedDrill[] {
  if (settings.drills === "none") return [];
  if (settings.drills === "week") return weeklyDrillPlan(WEEK_DRILLS, Math.max(1, Math.ceil(settings.targetMinutes / 1_440)));
  const once = settings.drills.split(",").map((entry) => {
    const [name, minutes] = entry.trim().split("@");
    if (name === undefined || DRILLS[name] === undefined || minutes === undefined || !Number.isFinite(Number(minutes))) throw new Error(`unknown drill entry: ${entry}`);
    return { name, minutes: Number(minutes) };
  });
  const unique = (name: string): boolean => once.filter((drill) => drill.name === name).length === 1;
  if (!(settings.drillRepeatHours > 0)) {
    return once.map((drill) => ({ id: unique(drill.name) ? drill.name : `${drill.name}@${drill.minutes}`, name: drill.name, atCoveredMs: drill.minutes * 60_000 })).sort((a, b) => a.atCoveredMs - b.atCoveredMs);
  }
  const out: PlannedDrill[] = [];
  for (let k = 0, offset = 0; offset < settings.targetMinutes * 60_000; k += 1, offset += settings.drillRepeatHours * 3_600_000) {
    for (const drill of once) out.push({ id: `r${k + 1}-${drill.name}@${drill.minutes}`, name: drill.name, atCoveredMs: drill.minutes * 60_000 + offset });
  }
  return out.sort((a, b) => a.atCoveredMs - b.atCoveredMs);
}

/** One drill at a time, each when the coverage clock reaches it, the session is warm, the last drill is far enough back, and the fleet is whole. */
async function runDrills(): Promise<void> {
  for (;;) {
    if (finishing) return;
    const next = drillLedger(plan, drillResults, DRILL_MAX_INTERRUPTIONS).owed[0];
    if (next === undefined) return;
    const targetMs = S.targetMinutes * 60_000;
    // DUE TOO LATE TO FINISH INSIDE THE RUN: left owed, and the report says so.
    if (next.atCoveredMs > targetMs - DRILL_END_MARGIN_MS) return;
    const now = Date.now();
    const ready =
      coverage.coveredMs >= next.atCoveredMs &&
      session!.steadyStart !== null &&
      now - session!.steadyStart >= S.drillWarmupMinutes * 60_000 &&
      now - lastDrillEnd >= S.drillSpacingMinutes * 60_000 &&
      targetMs - coverage.coveredMs > DRILL_END_MARGIN_MS &&
      fleetWhole();
    if (!ready) {
      await sleep(5_000);
      continue;
    }
    currentDrill = next.id;
    const coveredHoursAtStart = coverage.coveredMs / 3_600_000;
    event("drill starting", { id: next.id, drill: next.name, coveredHours: coveredHoursAtStart });
    const started = Date.now();
    let result: Record<string, unknown>;
    try {
      result = await DRILLS[next.name]!();
    } catch (error) {
      result = { ok: false, detail: `the drill threw: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}` };
    }
    const line: DrillResultLine & Record<string, unknown> = {
      id: next.id,
      drill: next.name,
      session: session!.n,
      startedAt: iso(started),
      tookMs: Date.now() - started,
      coveredHoursAtStart,
      ...result,
      // A DRILL THE HARNESS BEGAN STOPPING IN THE MIDDLE OF proved nothing: owed again, not failed.
      ...(finishing ? { ok: false, interrupted: true, interruptedBy: "the harness began stopping during the drill" } : {}),
    };
    drillResults.push(line);
    jsonl("drills.jsonl", line);
    event("drill done", { id: next.id, drill: next.name, ok: line.ok, interrupted: line.interrupted === true });
    currentDrill = null;
    lastDrillEnd = Date.now();
  }
}

/** At resume: a drill the last session started and never wrote a result for is recorded as interrupted (owed again, up to the limit). */
function reconcileInterruptedDrills(): void {
  const started = readLines<{ event?: string; id?: string; drill?: string; at?: string; session?: number }>("events.jsonl").filter(
    (line) => line.event === "drill starting" && typeof line.id === "string",
  );
  for (const start of started) {
    const id = start.id!;
    const attempts = started.filter((line) => line.id === id).length;
    const results = drillResults.filter((line) => line.id === id).length;
    if (results >= attempts) continue;
    // ONE LINE PER MISSING RESULT, written once: the next pass sees it as a result.
    const line: DrillResultLine & Record<string, unknown> = {
      id,
      drill: start.drill ?? id,
      session: start.session ?? null,
      startedAt: start.at ?? null,
      ok: false,
      interrupted: true,
      interruptedBy: "the harness ended during the drill (killed, crashed, a reboot or the power) and wrote no result",
    };
    drillResults.push(line);
    jsonl("drills.jsonl", line);
    event("drill interrupted by the last session's end: owed again", { id });
  }
}

// ── the end: stop everything, keep what the database knows, analyse ──────────
function finish(reason: string, complete = false): Promise<void> {
  finished ??= finishNow(reason, complete);
  return finished;
}

async function finishNow(reason: string, complete: boolean): Promise<void> {
  finishing = true;
  event("finishing", { reason, coveredHours: coverage.coveredMs / 3_600_000 });
  if (analysisChild !== null) analysisChild.kill("SIGKILL");
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
  if (ownContainer !== null) {
    docker("unpause", ownContainer);
    // A CLEAN SHUTDOWN OF THE DATABASE: with a named volume, the next session starts without crash recovery.
    const stop = docker("stop", "-t", "30", ownContainer);
    // --rm REMOVES IT AFTER THE STOP RETURNS: asked until it is gone, for up to 15 s.
    let left = ownContainer;
    for (let i = 0; i < 30 && left !== ""; i += 1) {
      left = docker("ps", "-a", "--filter", `name=^${ownContainer}$`, "--format", "{{.Names}}").stdout.trim();
      if (left !== "") await sleep(500);
    }
    if (left !== "") docker("rm", "-f", ownContainer);
    containerStopped = true;
    stopped.push({
      what: "postgres container",
      name: ownContainer,
      stopExit: stop.status,
      removed: left === "",
      volume: S.pgVolume === null ? "none: the data went with the container" : `${S.pgVolume}, kept: a --resume finds the database in it`,
    });
  }
  if (session !== null) {
    session.endedAt = at();
    session.endReason = reason;
  }
  if (complete) meta.completedAt = at();
  saveMeta();
  writeFileSync(resolve(OUT, "stopped.json"), JSON.stringify(stopped, null, 2));
  writeStatus(false);
  analyse();
}

// ── the analysis: a pure function of the files in OUT ─────────────────────────
function modelPrediction(model: string | null, tokens: readonly string[]): unknown {
  if (model === null) return null;
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
  const result = spawnSync("python3", ["-I", "-c", script, dirname(resolve(model)), JSON.stringify(tokens)], { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) return { error: (result.stderr ?? "").slice(-500) };
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch {
    return { error: "the model printed no JSON" };
  }
}

const hours = (ms: number): number => Math.round((ms / 3_600_000) * 100) / 100;

function analyse(): void {
  const run = JSON.parse(readFileSync(resolve(OUT, "run.json"), "utf8")) as Partial<RunMeta> & { startedAt: string };
  const sessions = run.sessions ?? [];
  const model = MODEL_ARG !== undefined ? resolve(MODEL_ARG) : (run.model ?? null);
  const targetMinutes = run.targetMinutes ?? run.minutes ?? 0;
  // THE BEATS: coverage.jsonl; a run from before the coverage clock has its minute's audit lines instead.
  let beats: CoverageBeat[] = readLines<{ at?: string; session?: number; fleetUp?: boolean }>("coverage.jsonl")
    .map((line) => ({ at: Date.parse(line.at ?? ""), session: line.session ?? 1, fleetUp: line.fleetUp !== false }))
    .filter((beat) => Number.isFinite(beat.at));
  const beatsFrom = beats.length > 0 ? "coverage.jsonl" : "audit.jsonl (a run from before the coverage clock: one beat a minute, the fleet assumed up)";
  if (beats.length === 0) {
    beats = readLines<{ at?: string }>("audit.jsonl")
      .map((line) => ({ at: Date.parse(line.at ?? ""), session: 1, fleetUp: true }))
      .filter((beat) => Number.isFinite(beat.at));
  }
  const cov = coverageOf(beats, { sessionCause: (n) => sessions.find((s) => s.n === n)?.resumeCause ?? undefined });
  const intervals = cov.intervals;
  /** Whether an instant lies in a covered stretch (binary search: a week of calls against its stretches). */
  const inCovered = (ts: number): boolean => {
    let lo = 0;
    let hi = intervals.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const interval = intervals[mid]!;
      if (ts < interval.from) hi = mid - 1;
      else if (ts > interval.to) lo = mid + 1;
      else return true;
    }
    return false;
  };
  // REPLAYED from production.jsonl and jobs.jsonl (compare.jsonl is the live loop's record of the same).
  const rows = replayComparison(readLines<ProductionSample>("production.jsonl"), readLines<WorkerLogLine & { process?: unknown }>("jobs.jsonl"));
  // A MISMATCH IN A WALLET'S LAST COMPARED MINUTE cannot be explained yet: no later minute exists to show a shift or a
  // recovery. It is "open" — listed, counted as a mismatch in the percentage, apart from "unexplained" — and the next
  // rolling report, with more minutes, explains it or not.
  const lastCompared = new Map<string, number>();
  for (const row of rows) if (row.verdict === "agree" || row.verdict === "mismatch") lastCompared.set(row.wallet, Math.max(lastCompared.get(row.wallet) ?? 0, row.at));
  const explained = explainMismatches(rows).map((e) =>
    e.explanation === "unexplained" && e.row.at >= (lastCompared.get(e.row.wallet) ?? Number.POSITIVE_INFINITY)
      ? { ...e, explanation: "open" as const, note: `${e.note}; the data ends here, so no later minute can explain it yet` }
      : e,
  );
  const drills = readLines<DrillResultLine & Record<string, unknown>>("drills.jsonl");
  let drillPlan: PlannedDrill[] = [];
  try {
    drillPlan = drillPlanOf({ drills: run.drills ?? "none", drillRepeatHours: run.drillRepeatHours ?? 0, targetMinutes });
  } catch {
    // A drill name this harness no longer knows: its results are still listed below.
  }
  const ledger = drillLedger(drillPlan, drills, DRILL_MAX_INTERRUPTIONS);
  const audit = readLines<{ at: string; overlapRows?: number; unavailable?: string }>("audit.jsonl");
  const calls = readLines<ProxyLine>("rpc/calls.jsonl");
  const exits = readLines<Record<string, unknown>>("exits.jsonl");
  // THE DRILL WINDOWS: a drill, and two minutes after it (it turns vaults twice and restarts processes). From its
  // result; and from its "drill starting" event when it has none yet — still running at a rolling report, or cut
  // short by the session's end — up to the data's last beat (at most 30 minutes).
  const drillWindows: (readonly [number, number])[] = [];
  const lastBeat = cov.lastBeatAt;
  const windowOf = (from: number, tookMs: number | null): readonly [number, number] => [
    from,
    from + Math.min(tookMs ?? Math.max(0, (lastBeat ?? from) - from), 30 * 60_000) + 120_000,
  ];
  for (const drill of drills) {
    const from = Date.parse(String(drill.startedAt ?? ""));
    if (Number.isFinite(from)) drillWindows.push(windowOf(from, typeof drill["tookMs"] === "number" ? drill["tookMs"] : null));
  }
  for (const start of readLines<{ event?: string; at?: string }>("events.jsonl")) {
    if (start.event !== "drill starting") continue;
    const from = Date.parse(start.at ?? "");
    if (!Number.isFinite(from) || drills.some((drill) => Math.abs(Date.parse(String(drill.startedAt ?? "")) - from) < 5_000)) continue;
    drillWindows.push(windowOf(from, null));
  }
  const inDrill = (from: number, until: number): boolean => drillWindows.some(([a, b]) => from < b && until > a);
  // DISCOVERY, over the covered minutes only; a drill's minutes are judged apart.
  const listingCalls = calls.filter((line) => line.method === "getProgramAccounts" || line.method === "getProgramAccountsV2");
  const perInterval = intervals.map((interval) => listingsPerMinute(listingCalls, (tag) => tag.startsWith("sched-"), interval.from, interval.to));
  const judged = perInterval.flatMap((result) => result.minutes).map((minute) => {
    const start = Date.parse(`${minute.minute}:00.000Z`);
    return { ...minute, drill: inDrill(start, start + 60_000) };
  });
  const quietListing = judged.filter((minute) => !minute.drill);
  const drillListing = judged.filter((minute) => minute.drill);
  const listingGaps = perInterval.flatMap((result) => result.gapsMs);
  // CREDITS, over the covered time.
  const coveredMs = cov.coveredMs;
  const steady = (tag: string, ts: number): boolean => tag !== "handover" && inCovered(ts);
  const credit1 = creditsOf(calls, 1, steady);
  const credit10 = creditsOf(calls, 10, steady);
  const byKind = (prefix: string) => creditsOf(calls, 1, (tag, ts) => tag.startsWith(prefix) && steady(tag, ts));
  // THE QUIET MINUTES: whole covered minutes no drill touched. The model predicts a steady tick, so the credits are set beside it over these.
  const quiet = new Set<number>();
  for (const interval of intervals) {
    for (let m = Math.ceil(interval.from / 60_000) * 60_000; m + 60_000 <= interval.to; m += 60_000) if (!inDrill(m, m + 60_000)) quiet.add(m);
  }
  const inQuiet = (tag: string, ts: number): boolean => steady(tag, ts) && quiet.has(Math.floor(ts / 60_000) * 60_000);
  const quiet1 = creditsOf(calls, 1, inQuiet);
  const quiet10 = creditsOf(calls, 10, inQuiet);
  const quietMs = quiet.size * 60_000;
  const quietDay = { archival1: perDay(quiet1.credits, quietMs), archival10: perDay(quiet10.credits, quietMs) };
  const tokens = (run.cuts ?? "") === "" ? [] : run.cuts!.split(",").map((token) => token.trim());
  const prediction = modelPrediction(model, tokens) as { creditsPerDay?: { archival1: number; archival10: number }; perTick?: Record<string, number> } | null;
  const measuredDay = { archival1: perDay(credit1.credits, coveredMs), archival10: perDay(credit10.credits, coveredMs) };
  const minutes = coveredMs / 60_000;
  const perMinute = (n: number): number | null => (minutes === 0 ? null : n / minutes);
  const blocked = calls.filter((line) => line.refused === true);
  const finalDb = existsSync(resolve(OUT, "final-db.json")) ? (JSON.parse(readFileSync(resolve(OUT, "final-db.json"), "utf8")) as Record<string, unknown>) : null;
  const agreement = agreementOf(rows);
  const unexplained = explained.filter((e) => e.explanation === "unexplained").length;
  const openAtEnd = explained.filter((e) => e.explanation === "open").length;
  const quietOverModel =
    prediction?.creditsPerDay === undefined || quiet.size === 0
      ? null
      : { archival1: quietDay.archival1 / prediction.creditsPerDay.archival1, archival10: quietDay.archival10 / prediction.creditsPerDay.archival10 };
  const overlapMaxSeen = Math.max(0, ...audit.map((line) => line.overlapRows ?? 0));
  const finalOverlap = (finalDb?.["overlapRows"] as number | undefined) ?? null;
  const gapMs = cov.gaps.reduce((sum, gap) => sum + gap.ms, 0);
  const drillsPassed = ledger.done.filter((drill) => drill.ok).length;
  const report = {
    generatedAt: at(),
    coverage: {
      targetHours: targetMinutes / 60,
      coveredHours: hours(coveredMs),
      percent: targetMinutes === 0 ? null : Math.round((coveredMs / (targetMinutes * 60_000)) * 1_000) / 10,
      beatsFrom,
      firstBeat: cov.firstBeatAt === null ? null : iso(cov.firstBeatAt),
      lastBeat: cov.lastBeatAt === null ? null : iso(cov.lastBeatAt),
      gapHours: hours(gapMs),
      gaps: cov.gaps.map((gap) => ({ from: iso(gap.from), to: iso(gap.to), minutes: Math.round(gap.ms / 6_000) / 10, cause: gap.cause })),
      sessions: sessions.map((s) => ({ n: s.n, startedAt: s.startedAt, steadyStart: s.steadyStart === null ? null : iso(s.steadyStart), endedAt: s.endedAt, endReason: s.endReason, resumeCause: s.resumeCause })),
      completedAt: run.completedAt ?? null,
    },
    window: { from: cov.firstBeatAt === null ? null : iso(cov.firstBeatAt), to: cov.lastBeatAt === null ? null : iso(cov.lastBeatAt), coveredMinutes: Math.round(minutes * 10) / 10 },
    agreement: {
      ...agreement,
      explained: {
        timing: explained.filter((e) => e.explanation === "timing").length,
        dryRun: explained.filter((e) => e.explanation === "dry-run").length,
        transient: explained.filter((e) => e.explanation === "transient").length,
        unexplained,
        openAtEnd,
      },
      mismatches: explained.map((e) => ({ at: iso(e.row.at), wallet: e.row.wallet, production: e.row.production, shadow: e.row.shadow, explanation: e.explanation, note: e.note })),
      gaps: rows.filter((row) => row.verdict === "no-shadow" || row.verdict === "no-production").map((row) => ({ at: iso(row.at), wallet: row.wallet, verdict: row.verdict })),
    },
    overlap: {
      maxRowsSeen: overlapMaxSeen,
      auditsRun: audit.filter((line) => line.overlapRows !== undefined).length,
      auditsUnavailable: audit.filter((line) => line.unavailable !== undefined).length,
      final: finalOverlap,
      intents: finalDb?.["intents"] ?? null,
    },
    discovery: {
      quietMinutesJudged: quietListing.length,
      quietMinutesWithExactlyOne: quietListing.filter((minute) => minute.listings === 1).length,
      quietNotOne: quietListing.filter((minute) => minute.listings !== 1).slice(0, 500),
      drillMinutesJudged: drillListing.length,
      drillMinutesWithExactlyOne: drillListing.filter((minute) => minute.listings === 1).length,
      gapsMs: { min: listingGaps.length === 0 ? null : Math.min(...listingGaps), max: listingGaps.length === 0 ? null : Math.max(...listingGaps), count: listingGaps.length },
    },
    credits: {
      callsPerMinute: perMinute(credit1.calls),
      byMethodPerMinute: Object.fromEntries(Object.entries(credit1.byMethod).map(([method, n]) => [method, Math.round((n / Math.max(1, minutes)) * 100) / 100])),
      byProcessKindPerMinute: { schedulers: perMinute(byKind("sched-").calls), workers: perMinute(byKind("worker-").calls) },
      measuredPerDay: measuredDay,
      quiet: {
        minutes: quiet.size,
        callsPerMinute: quiet.size === 0 ? null : quiet1.calls / quiet.size,
        byMethodPerMinute: Object.fromEntries(Object.entries(quiet1.byMethod).map(([method, n]) => [method, Math.round((n / Math.max(1, quiet.size)) * 100) / 100])),
        byClassPerMinute: Object.fromEntries(Object.entries(quiet1.byClass).map(([line, v]) => [line, Math.round((v.calls / Math.max(1, quiet.size)) * 100) / 100])),
        perDay: quietDay,
      },
      model: prediction,
      // THE GATE'S RATIO, over the quiet minutes: within +15 % of the model for the same token set.
      quietOverModel,
      measuredOverModel:
        prediction?.creditsPerDay === undefined
          ? null
          : { archival1: measuredDay.archival1 / prediction.creditsPerDay.archival1, archival10: measuredDay.archival10 / prediction.creditsPerDay.archival10 },
      refusedCalls: blocked.length,
      processMeters: finalDb?.["rpcUsage"] ?? null,
      proxyTotalsByClass: creditsOf(calls, 1).byClass,
    },
    drills: {
      planned: drillPlan.length,
      done: ledger.done.length,
      passed: drillsPassed,
      failed: ledger.done.filter((drill) => !drill.ok).map((drill) => drill.id),
      interrupted: ledger.interrupted,
      gaveUp: ledger.gaveUp,
      owed: ledger.owed.map((drill) => ({ id: drill.id, atCoveredHours: drill.atCoveredMs / 3_600_000 })),
      results: drills,
    },
    exitsOnTheirOwn: exits,
    // THE GATE (plan §3.3.2), check by check. PENDING: not reached yet; FAIL: reached and missed.
    gate: {
      coverage: { need: `≥ ${targetMinutes / 60} h covered`, have: `${hours(coveredMs)} h, ${cov.gaps.length} gaps (${hours(gapMs)} h)`, verdict: coveredMs >= targetMinutes * 60_000 ? "PASS" : "PENDING" },
      agreement: {
        need: "≥ 99 %, every mismatch explained (one in a wallet's last compared minute stays open until a later minute exists)",
        have: `${agreement.percent === null ? "n/a" : agreement.percent.toFixed(2)} % (${agreement.agree}/${agreement.compared}), ${unexplained} unexplained, ${openAtEnd} open`,
        verdict: agreement.percent === null ? "PENDING" : agreement.percent >= 99 && unexplained === 0 ? "PASS" : "FAIL",
      },
      overlap: { need: "0 rows", have: `max ${overlapMaxSeen}, final ${String(finalOverlap)}`, verdict: overlapMaxSeen === 0 && (finalOverlap === null || finalOverlap === 0) ? "PASS" : "FAIL" },
      discovery: {
        need: "exactly 1 listing every quiet covered minute",
        have: `${quietListing.filter((minute) => minute.listings === 1).length}/${quietListing.length}`,
        verdict: quietListing.length === 0 ? "PENDING" : quietListing.every((minute) => minute.listings === 1) ? "PASS" : "FAIL",
      },
      credits: {
        need: "≤ +15 % over the model, archival 1 and 10",
        have: quietOverModel === null ? "n/a" : `${quietOverModel.archival1.toFixed(3)} / ${quietOverModel.archival10.toFixed(3)}`,
        verdict: quietOverModel === null ? "PENDING" : quietOverModel.archival1 <= 1.15 && quietOverModel.archival10 <= 1.15 ? "PASS" : "FAIL",
      },
      drills: {
        need: `every planned drill passed (${drillPlan.length})`,
        have: `${drillsPassed} passed, ${ledger.done.length - drillsPassed} failed, ${ledger.gaveUp.length} interrupted twice, ${ledger.owed.length} owed`,
        verdict: ledger.done.length - drillsPassed > 0 || ledger.gaveUp.length > 0 ? "FAIL" : ledger.owed.length > 0 ? "PENDING" : "PASS",
      },
    },
    stopped: existsSync(resolve(OUT, "stopped.json")) ? (JSON.parse(readFileSync(resolve(OUT, "stopped.json"), "utf8")) as unknown) : null,
  };
  writeJsonAtomic("report.json", report);
  const a = report.agreement;
  const lines = [
    `coverage ${report.coverage.coveredHours} h of ${report.coverage.targetHours} h (${String(report.coverage.percent)} %); ${cov.gaps.length} gaps, ${report.coverage.gapHours} h in all; ${sessions.length || 1} session(s)`,
    ...report.coverage.gaps.slice(-20).map((gap) => `  gap ${gap.from} → ${gap.to} (${gap.minutes} min): ${gap.cause}`),
    `window ${String(report.window.from)} → ${String(report.window.to)} (${report.window.coveredMinutes} covered min)`,
    `agreement ${a.percent === null ? "n/a" : a.percent.toFixed(2)} % (${a.agree}/${a.compared}); mismatches: timing ${a.explained.timing}, dry-run ${a.explained.dryRun}, transient ${a.explained.transient}, unexplained ${a.explained.unexplained}, open in the data's last minute ${a.explained.openAtEnd}; gaps: no-shadow ${a.noShadow}, no-production ${a.noProduction}; frontier slots equal ${a.frontier.equal}/${a.frontier.compared}`,
    `overlap audit: max ${report.overlap.maxRowsSeen} rows over ${report.overlap.auditsRun} audits (${report.overlap.auditsUnavailable} unavailable), final ${String(report.overlap.final)}`,
    `discovery: ${report.discovery.quietMinutesWithExactlyOne}/${report.discovery.quietMinutesJudged} quiet covered minutes with exactly one listing; drill minutes ${report.discovery.drillMinutesWithExactlyOne}/${report.discovery.drillMinutesJudged}; gaps ${String(report.discovery.gapsMs.min)}–${String(report.discovery.gapsMs.max)} ms`,
    `credits/day measured: ${Math.round(measuredDay.archival1)} (archival 1), ${Math.round(measuredDay.archival10)} (archival 10); calls/min ${report.credits.callsPerMinute?.toFixed(2) ?? "n/a"}; refused calls ${report.credits.refusedCalls}`,
    `credits/day over ${quiet.size} quiet minutes: ${Math.round(quietDay.archival1)} (archival 1), ${Math.round(quietDay.archival10)} (archival 10); calls/min ${report.credits.quiet.callsPerMinute?.toFixed(2) ?? "n/a"}`,
    `model: ${prediction === null ? "not given" : JSON.stringify(prediction)}`,
    `quiet / model: ${quietOverModel === null ? "n/a" : `${quietOverModel.archival1.toFixed(3)} (archival 1), ${quietOverModel.archival10.toFixed(3)} (archival 10)`}`,
    `drills: ${ledger.done.length} of ${drillPlan.length} done, ${drillsPassed} passed; interrupted attempts ${Object.values(ledger.interrupted).reduce((sum, n) => sum + n, 0)}; owed ${ledger.owed.length}`,
    ...drills.map((drill) => `  drill ${String(drill.id ?? drill.drill)}: ${drill.interrupted === true ? "INTERRUPTED (owed again)" : drill.ok === true ? "PASS" : "FAIL"}`),
    `processes that exited on their own (replaced): ${exits.length}`,
    `gate: ${Object.entries(report.gate)
      .map(([check, value]) => `${check} ${value.verdict}`)
      .join(", ")}`,
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
// ONE HARNESS PER STATE DIRECTORY.
const PID_FILE = resolve(OUT, "harness.pid");
if (existsSync(PID_FILE)) {
  const other = Number(readFileSync(PID_FILE, "utf8").trim());
  if (other !== process.pid && commandOf(other).includes("harness.ts")) {
    console.error(`another harness (pid ${other}) is running on ${OUT}; stop it first`);
    process.exit(3);
  }
}
writeFileSync(PID_FILE, String(process.pid));
// A HARNESS THAT DIES STILL TAKES ITS CONTAINER AND ITS CHILDREN WITH IT, and says how its session ended.
process.on("exit", (code) => {
  for (const proc of procs) proc.child.kill("SIGKILL");
  proxyChild?.kill("SIGKILL");
  analysisChild?.kill("SIGKILL");
  if (ownContainer !== null && !containerStopped) {
    // WITH A NAMED VOLUME, A CLEAN SHUTDOWN FIRST; the data stays in the volume either way.
    if (S.pgVolume !== null) spawnSync("docker", ["stop", "-t", "15", ownContainer], { timeout: 30_000 });
    spawnSync("docker", ["rm", "-f", ownContainer], { timeout: 30_000 });
  }
  if (session !== null && session.endedAt === null) {
    session.endedAt = at();
    session.endReason = `the harness exited (code ${code}) without finishing`;
    try {
      saveMeta();
    } catch {
      // Nothing left to keep it in.
    }
  }
  try {
    if (readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) rmSync(PID_FILE);
  } catch {
    // Already gone.
  }
});

const stored = readJsonOr<Partial<RunMeta> & { startedAt: string }>("run.json");
if (stored !== null && !RESUME) {
  console.error(`${OUT} already holds a run (run.json): pass --resume to continue it, or choose another --state`);
  process.exit(2);
}
if (stored?.completedAt) {
  console.log(`the run in ${OUT} is complete (${stored.completedAt}); nothing to resume. Its report: summary.txt`);
  process.exit(0);
}
if (stored !== null) {
  // A RESUMED RUN KEEPS THE SETTINGS IT WAS STARTED WITH; a run from before resume existed gets today's defaults for what it lacks.
  Object.assign(meta, stored, {
    targetMinutes: stored.targetMinutes ?? stored.minutes ?? fromArgs.targetMinutes,
    drillWarmupMinutes: stored.drillWarmupMinutes ?? fromArgs.drillWarmupMinutes,
    drillSpacingMinutes: stored.drillSpacingMinutes ?? fromArgs.drillSpacingMinutes,
    model: stored.model === undefined ? fromArgs.model : stored.model,
    pgImage: stored.pgImage ?? fromArgs.pgImage,
    pgVolume: stored.pgVolume ?? null,
    reportEveryMinutes: stored.reportEveryMinutes ?? fromArgs.reportEveryMinutes,
    letters: stored.letters ?? { scheduler: 0, worker: 0 },
    sessions: stored.sessions ?? [],
    completedAt: stored.completedAt ?? null,
  });
  S = settingsOf(meta);
  const FLAGS: Record<keyof Settings, readonly string[]> = {
    targetMinutes: ["minutes", "target-hours"],
    drills: ["drills"],
    drillRepeatHours: ["drill-repeat-hours"],
    drillWarmupMinutes: ["drill-warmup-minutes"],
    drillSpacingMinutes: ["drill-spacing-minutes"],
    proxy: ["proxy"],
    model: ["model"],
    production: ["production"],
    cuts: ["cuts"],
    pgImage: ["pg-image"],
    pgVolume: ["pg-volume"],
    reportEveryMinutes: ["report-every-minutes"],
  };
  const differs = (Object.keys(FLAGS) as (keyof Settings)[]).filter(
    (key) => FLAGS[key].some((flag) => argv.includes(`--${flag}`)) && JSON.stringify(fromArgs[key]) !== JSON.stringify(S[key]),
  );
  if (differs.length > 0) console.log(JSON.stringify({ at: at(), note: "a resumed run keeps the settings it was started with; these options were ignored", ignored: differs }));
}
try {
  plan = drillPlanOf(S);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

// THE RUN SO FAR: its beats (the coverage clock), its drills, its overlap.
for (const line of readLines<{ at?: string; session?: number; fleetUp?: boolean }>("coverage.jsonl")) {
  const t = Date.parse(line.at ?? "");
  if (Number.isFinite(t)) beats.push({ at: t, session: line.session ?? 1, fleetUp: line.fleetUp !== false });
}
drillResults = readLines<DrillResultLine & Record<string, unknown>>("drills.jsonl");
overlapMax = Math.max(0, ...readLines<{ overlapRows?: number }>("audit.jsonl").map((line) => line.overlapRows ?? 0));
exitsOnTheirOwn = readLines("exits.jsonl").length;

// WHY THE RUN WAS NOT BEATING BEFORE THIS SESSION: what the gap since the last beat is named by.
const previous = meta.sessions.at(-1);
const lastBeatAt = beats.at(-1)?.at ?? null;
const bootedAt = (() => {
  const sec = /sec = (\d+)/.exec(spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8" }).stdout ?? "")?.[1];
  return sec === undefined ? null : Number(sec) * 1_000;
})();
const resumeCause =
  previous === undefined
    ? null
    : previous.endedAt !== null && !(previous.endReason ?? "").startsWith("the harness exited")
      ? `the harness was stopped (${previous.endReason}) and started again`
      : bootedAt !== null && bootedAt > (lastBeatAt ?? Date.parse(previous.startedAt))
        ? `the Mac restarted (booted ${iso(bootedAt)}); the harness had not stopped cleanly`
        : previous.endedAt !== null
          ? `${previous.endReason ?? "the harness ended"}; started again`
          : "the harness ended without stopping cleanly (killed, crashed, or the power went)";
session = { n: (previous?.n ?? 0) + 1, pid: process.pid, startedAt: at(), steadyStart: null, endedAt: null, endReason: null, resumeCause };
meta.sessions.push(session);

// WHAT THE LAST SESSION LEFT RUNNING: its children, by pid, only if they still run this keeper's code or name this directory.
const reaped: { pid: number; name: string }[] = [];
for (const entry of readJsonOr<{ pid: number; name: string }[]>("children.json") ?? []) {
  const command = commandOf(entry.pid);
  if (entry.pid === process.pid || command === "" || !(command.includes(KEEPER_DIR) || command.includes(OUT))) continue;
  try {
    process.kill(entry.pid, "SIGKILL");
    reaped.push(entry);
  } catch {
    // Gone between the look and the kill.
  }
}
saveChildren();
saveMeta();
if (stored !== null) {
  event("resuming", {
    previousSession: previous?.n ?? null,
    lastBeatAt: lastBeatAt === null ? null : iso(lastBeatAt),
    gapMinutes: lastBeatAt === null ? null : Math.round((Date.now() - lastBeatAt) / 6_000) / 10,
    cause: resumeCause,
    coveredHours: coverageOf(beats).coveredMs / 3_600_000,
    reapedLeftovers: reaped,
  });
  reconcileInterruptedDrills();
  const done = drillLedger(plan, drillResults, DRILL_MAX_INTERRUPTIONS).done.map((drill) => drill.id);
  if (done.length > 0) event("drills already done: not repeated", { ids: done });
}
coverage = coverageOf(beats, { sessionCause });

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
const targetMs = S.targetMinutes * 60_000;
while (!finishing && coverage.coveredMs < targetMs) {
  const next = Math.floor((Date.now() - 30_000) / 60_000) * 60_000 + 90_000;
  await sleep(Math.max(1_000, next - Date.now()));
  if (finishing) break;
  try {
    await minute();
  } catch (error) {
    event("minute failed", { detail: error instanceof Error ? error.message.slice(0, 300) : String(error) });
  }
  try {
    await keepFleetWhole();
  } catch (error) {
    event("keeping the fleet whole failed", { detail: error instanceof Error ? error.message.slice(0, 300) : String(error) });
  }
  // A SESSION THAT CANNOT WORK ENDS ITSELF, and the loop resumes it with a fresh container on the same volume.
  const broken =
    dbDownSince !== null && Date.now() - dbDownSince >= BROKEN_SESSION_MS
      ? `the database has not answered for ${BROKEN_SESSION_MS / 60_000} minutes outside any drill`
      : proxyExit() !== null && currentDrill === null
        ? `the census proxy exited (${String(proxyExit())})`
        : null;
  if (broken !== null && !finishing) {
    event("this session cannot work: ending it so it can be resumed", { why: broken });
    exitCode = 1;
    void finish(broken);
    break;
  }
  // THE ROLLING REPORT: ten minutes into each session, then every --report-every-minutes.
  const steadyFor = Date.now() - (session.steadyStart ?? Date.now());
  if (S.reportEveryMinutes > 0 && ((lastReportAt === 0 && steadyFor >= 10 * 60_000) || (lastReportAt !== 0 && Date.now() - lastReportAt >= S.reportEveryMinutes * 60_000))) rollingReport();
}
if (!finishing) {
  // THE TARGET IS REACHED: a drill still running is let finish first.
  event("the coverage target is reached", { coveredHours: coverage.coveredMs / 3_600_000, targetHours: S.targetMinutes / 60 });
  while (currentDrill !== null && !finishing) await sleep(1_000);
  void finish("the coverage target was reached", true);
}
// A SIGNAL'S FINISH, THE TARGET'S, OR A BROKEN SESSION'S: the process exits only when it is over.
await finished;
void drillsDone;
process.exit(exitCode);
