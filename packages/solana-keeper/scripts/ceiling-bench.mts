#!/usr/bin/env node
// HOW MANY SIMULTANEOUS USERS FIT IN A SWEEP — measured, without real users and
// without hammering anybody's RPC.
//
//   pnpm --dir packages/solana-keeper bench:ceiling
//   pnpm --dir packages/solana-keeper bench:ceiling -- --links 1,25,100 --latency 86:122 --hot-ratio 0.02
//   pnpm --dir packages/solana-keeper bench:ceiling -- --latency 30:45 --plan-rps 50 --privy-ms 300
//
// WHAT IT ACTUALLY RUNS. It serves a Solana JSON-RPC endpoint on the loopback
// over a synthetic fleet (src/bench/chain-stub.ts), then BOOTS THE REAL KEEPER
// against it — bin/keeper.mts, unmodified, through tsx, with SIP_SOLANA_RPC_URLS
// pointed at the stub. Discovery, the batched vault read, the settle turns, the
// window walks and the invest turns are the keeper's own code, in the keeper's
// own sequential loop, and the duration in the table is the keeper's own
// `lastSweepMs` read back off its /status. Nothing here re-implements the sweep:
// a bench that did would be measuring itself, which is the trap
// docs/TESTING_TRAPS.md opens with.
//
// LATENCY IS INJECTED PER CALL, FROM A DISTRIBUTION. Every HTTP request to the
// stub waits a draw from a lognormal pinned by a p50 and a p90 before it is
// answered, because the measured spread was 86.3 ms median against 122.4 ms at
// p90 and the sweep is sequential: what fills a sweep is the sum of a few
// hundred draws, and the tail is most of the difference.
//
// THE WRITE PATH IS EXCLUDED AND THE REPORT SAYS SO. The child is a DRY RUN: it
// is given neither SIP_SOLANA_BROADCAST nor the acknowledgement sentence, so
// config.ts reads no signing secret and no turn reaches a send. On top of that
// the stub refuses sendTransaction outright, and an offline guard
// (src/bench/offline.ts) refuses any request to a host that is not the loopback.
// So the ROWS are the READ path and the loop overhead. Signing, sending and
// confirming are not run — but they are no longer left out of the CEILING: every
// hot user is charged the least settle-tick.ts lets a live settle cost
// (src/bench/ceiling.ts settleWriteFloor), and the report says what a settle
// that never confirms costs on its own (CONFIRM_TIMEOUT_MS, 60 s, inside the
// sequential loop).
//
// THE CEILING IS READ OFF THE KEEPER'S OWN LANES, NOT OFF A LINE THROUGH THE
// TOTALS. c6e38d8 drew one straight line through four sweeps whose hot shares
// differed (at 2 % the small rows had no hot user at all) and priced a hot user
// on its reads only; it published ~99 / ~266 / ~698 and all three were too high.
// Now the idle and hot prices are divided out of /status's triageMs and
// expensiveMs separately, and the ceiling is printed as a function of the hot
// share, next to the backlog a keeper outage leaves behind.
//
// A PLAN'S RATE LIMIT IS MODELLED AS WHAT IT IS: A REFUSAL. With --plan-rps the
// endpoint answers HTTP 429 above the plan (src/bench/rate-gate.ts), the real
// keeper meets it in the real loop, and the row reports how many calls were
// refused and how many users that left unserved. Without it, every ceiling is
// printed with the request rate it needs, because it holds only on a plan that
// grants it.
//
// ONE PROCESS PER CELL, ONE SWEEP PER PROCESS. bin/keeper.mts sweeps once the
// moment it boots and then on an interval, and `lastSweepMs` on /status is null
// until a sweep has finished — so "sweeps >= 1 and lastSweepMs is not null" is an
// exact, race-free signal that THIS cell's sweep is the one being read. It costs
// a couple of seconds of tsx startup per row and buys an unambiguous table.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import { BenchChain, WRITE_PATH_REFUSAL } from "../src/bench/chain-stub.js";
import {
  backlogFill,
  fleetCeiling,
  JUPITER_CALLS_PER_BUYING_TURN,
  jupiterBuyerCeiling,
  laneCosts,
  roundTripMs,
  SENSITIVITY_HOT_SHARES,
  settleWriteFloor,
  type CeilingAnswer,
  type LaneCosts,
} from "../src/bench/ceiling.js";
import { buildFleet, benchKey, hotCount } from "../src/bench/fleet.js";
import { buildGrid, ceilingLinks, fitSweepCost, largestFitting, parseCountList, parseLatencyList, rowVerdict, type BenchCell } from "../src/bench/grid.js";
import { createLatency, type LatencySampler } from "../src/bench/latency.js";
import { createRateGate, type RateGate } from "../src/bench/rate-gate.js";
import { idl } from "../src/idl.js";
import { MAX_SIGNATURES } from "../src/measure-window.js";
import { CONFIRM_POLL_MS } from "../src/settle-tick.js";
import { JUPITER_KEYLESS_CALLS_PER_MINUTE } from "../src/sweep-cost.js";

const KEEPER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Options {
  readonly links: readonly number[];
  readonly latencies: readonly { readonly p50Ms: number; readonly p90Ms: number }[];
  readonly hotRatio: number;
  readonly hotTxCount: number;
  readonly windowMs: number;
  /** The provider plan's requests a second, or null when it is not known. */
  readonly planRps: number | null;
  /** Privy's submit round trip, charged to every hot user's write floor. Unmeasured, so zero unless passed. */
  readonly privyMs: number;
  readonly seed: number;
  readonly bootTimeoutMs: number;
  readonly sweepTimeoutMs: number;
  readonly json: boolean;
  readonly verbose: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  const bare = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) bare.add(name);
    else {
      flags.set(name, next);
      i += 1;
    }
  }
  const number = (name: string, fallback: number): number => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`--${name} takes a number; it holds "${raw}"`);
    return value;
  };
  return {
    // The default grid finishes in a few minutes on a laptop and still spans the
    // two regimes the owner asked about: a fleet that fits and one that does not.
    links: parseCountList(flags.get("links") ?? "1,10,50,100", "--links"),
    // The measured public-endpoint shape, a fast keyed provider, and a bad day.
    latencies: parseLatencyList(flags.get("latency") ?? "10:14,30:45,86:122", "--latency"),
    hotRatio: number("hot-ratio", 0.02),
    hotTxCount: number("hot-tx", 12),
    windowMs: number("window-ms", 60_000),
    planRps: flags.has("plan-rps") ? number("plan-rps", 0) : null,
    privyMs: number("privy-ms", 0),
    seed: number("seed", 1),
    bootTimeoutMs: number("boot-timeout-ms", 60_000),
    sweepTimeoutMs: number("sweep-timeout-ms", 15 * 60_000),
    json: bare.has("json"),
    verbose: bare.has("verbose"),
  };
}

/**
 * The child keeper's environment.
 *
 * THE ARMING VARIABLES ARE DELETED, NOT BLANKED. config.ts reports a variable
 * that is SET BUT EMPTY as a misconfiguration and warns about it, which would
 * put a line in every cell's log about a thing the bench did on purpose. Absent
 * is what a dry run looks like, and a dry run reads no signing secret at all.
 * Deleted from a COPY of this process's environment, so a shell that has the
 * production variables exported cannot arm the child by accident.
 */
function childEnv(rpcPort: number, statusPort: number, programId: string, windowMs: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    "SIP_SOLANA_BROADCAST",
    "SIP_SOLANA_ALLOW_BROADCAST",
    "SIP_SOLANA_SETTLE_KEY",
    "SIP_SOLANA_LOCAL_SIGNERS_DIR",
    "SIP_SOLANA_ALERT_WEBHOOK",
    "SIP_SOLANA_ALERT_MIN_SEVERITY",
    "SIP_SOLANA_POOLS",
    "SIP_SOLANA_PRIVY_APP_ID",
    "SIP_SOLANA_PRIVY_APP_SECRET",
    "SIP_SOLANA_PRIVY_AUTHORIZATION_KEY",
    "SIP_SOLANA_PRIVY_SIGNER_ID",
    "SIP_SOLANA_PRIVY_POLICY_ID",
    "DATABASE_URL",
  ]) {
    delete env[name];
  }
  env["SIP_SOLANA_RPC_URLS"] = `http://127.0.0.1:${rpcPort}`;
  env["SIP_SOLANA_PROGRAM_ID"] = programId;
  env["SIP_SOLANA_SWEEP_MS"] = String(Math.max(5_000, Math.round(windowMs)));
  env["PORT"] = String(statusPort);
  return env;
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** A port nothing is listening on, for the keeper's heartbeat. */
async function freePort(): Promise<number> {
  return await new Promise((done, fail) => {
    const probe = createSocketServer();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface CellResult {
  readonly cell: BenchCell;
  /** Hot links in this cell's fleet, by the same rounding the fleet was built with. */
  readonly hot: number;
  /** Requests the stub answered 429, as the plan would have. */
  readonly throttled: number;
  /** Discovered links whose turn did not rest or settle: THREW, FAILED, INCOMPLETE, or never reached. */
  readonly unserved: number;
  readonly sweepMs: number;
  readonly phases: Record<string, number> | null;
  readonly linksDiscovered: number | null;
  readonly linksTriaged: number | null;
  readonly rpcCalls: Record<string, number>;
  readonly rpcTotal: number;
}

interface KeeperStatusShape {
  readonly sweeps?: number;
  readonly lastSweepMs?: number | null;
  readonly lastSweepPhaseMs?: Record<string, number> | null;
  readonly linksDiscovered?: number | null;
  readonly linksTriaged?: number | null;
  readonly lastSweepError?: string | null;
  readonly wallets?: Record<string, { readonly settle?: string; readonly invest?: string }>;
}

/**
 * THE ONLY OUTCOMES THE BENCH'S FLEET CAN HAVE WHEN NOTHING GOES WRONG: an idle
 * link rests, a hot one settles (dry), and neither reaches a venue because every
 * vault sits at its rent floor. Anything else is something the bench's
 * environment did to the turn — a 429, most of all — and that user was not
 * served.
 */
const SERVED_SETTLE = new Set(["IDLE", "SETTLED"]);
const SERVED_INVEST = new Set(["IDLE"]);

function servedCount(status: KeeperStatusShape): number {
  let served = 0;
  for (const turn of Object.values(status.wallets ?? {})) {
    if (SERVED_SETTLE.has(turn.settle ?? "") && SERVED_INVEST.has(turn.invest ?? "")) served += 1;
  }
  return served;
}

async function readStatus(port: number): Promise<KeeperStatusShape | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    return (await response.json()) as KeeperStatusShape;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const programId = new PublicKey(idl.address);
  const crank = benchKey("crank");
  const chain = new BenchChain({ programId, crank });

  // THE SAMPLER IS SWAPPED BETWEEN CELLS, never inside one: a row of the table
  // is one fleet size at one latency shape, and a draw from the previous shape
  // landing in this sweep would be a millisecond nobody asked for.
  let latency: LatencySampler = createLatency({ p50Ms: 0, p90Ms: 0 }, options.seed);
  // AND SO IS THE PLAN: a fresh bucket per cell, so one row's burst is not
  // another row's refusal.
  let gate: RateGate | null = null;

  const server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      // ONE DRAW PER ROUND TRIP. The keeper makes one HTTP request per RPC call
      // (src/rpc-pool.ts replaces the transport under Connection), so a delay
      // here is a delay on exactly one call, which is what the grid varies.
      await sleep(latency.next());
      // A REFUSAL STILL COSTS THE ROUND TRIP, and it answers nothing: the
      // provider says 429 and the keeper's pool throws (src/rpc-pool.ts).
      if (gate !== null && !gate.admit()) {
        response.statusCode = 429;
        response.end('{"jsonrpc":"2.0","error":{"code":429,"message":"Too many requests for a specific RPC call"},"id":null}');
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        response.statusCode = 400;
        response.end("{}");
        return;
      }
      const answer = (one: unknown): unknown => {
        const call = one as { id?: unknown; method?: unknown; params?: unknown };
        const result = chain.handle(String(call.method), Array.isArray(call.params) ? call.params : []);
        return result.error === undefined
          ? { jsonrpc: "2.0", id: call.id ?? null, result: result.result ?? null }
          : { jsonrpc: "2.0", id: call.id ?? null, error: result.error };
      };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(Array.isArray(payload) ? payload.map(answer) : answer(payload)));
    })();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const rpcPort = typeof address === "object" && address !== null ? address.port : 0;

  const grid = buildGrid(options.links, options.latencies);
  const results: CellResult[] = [];
  const notes: string[] = [];

  for (const cell of grid) {
    latency = createLatency(cell.latency, options.seed);
    gate = options.planRps === null ? null : createRateGate(options.planRps);
    chain.setFleet(
      buildFleet({ links: cell.links, hotRatio: options.hotRatio, hotTxCount: options.hotTxCount, programId, seed: options.seed }),
    );
    chain.takeCalls();
    const statusPort = await freePort();
    const child: ChildProcess = spawn(
      resolve(KEEPER_DIR, "node_modules/.bin/tsx"),
      ["--import", resolve(KEEPER_DIR, "scripts/bench-offline.mts"), resolve(KEEPER_DIR, "bin/keeper.mts")],
      {
        cwd: KEEPER_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        env: childEnv(rpcPort, statusPort, programId.toBase58(), options.windowMs),
      },
    );
    const childLog: string[] = [];
    child.stdout?.on("data", (chunk: Buffer) => childLog.push(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => childLog.push(chunk.toString("utf8")));
    let exited: number | null = null;
    child.on("exit", (code) => {
      exited = code ?? 0;
    });

    const started = Date.now();
    let status: KeeperStatusShape | null = null;
    let booted = false;
    try {
      for (;;) {
        if (exited !== null) throw new Error(`the keeper exited with code ${exited} before its first sweep finished`);
        const snapshot = await readStatus(statusPort);
        if (snapshot !== null) {
          booted = true;
          // EXACT, AND THIS IS WHY. `sweeps` is advanced in the MIDDLE of a
          // sweep, but `lastSweepMs` is null until one has FINISHED
          // (noteSweepCost, in bin/keeper.mts's finally). One process runs one
          // cell, so the first non-null lastSweepMs is this cell's sweep and
          // can be nothing else.
          if (typeof snapshot.lastSweepMs === "number") {
            status = snapshot;
            break;
          }
        }
        const waited = Date.now() - started;
        if (!booted && waited > options.bootTimeoutMs) throw new Error(`the keeper did not answer /status within ${options.bootTimeoutMs} ms`);
        if (waited > options.sweepTimeoutMs) throw new Error(`no sweep finished within ${options.sweepTimeoutMs} ms`);
        await sleep(25);
      }
    } catch (error) {
      child.kill("SIGKILL");
      process.stderr.write(`${childLog.join("")}\n`);
      throw error;
    }
    child.kill("SIGTERM");

    const calls = chain.takeCalls();
    const rpcCalls: Record<string, number> = {};
    let rpcTotal = 0;
    for (const [method, count] of [...calls].sort()) {
      rpcCalls[method] = count;
      rpcTotal += count;
    }
    if (status.lastSweepError !== null && status.lastSweepError !== undefined) notes.push(`a sweep reported an error: ${status.lastSweepError}`);
    if (options.verbose) process.stderr.write(`${childLog.join("")}\n`);
    const hot = hotCount(cell.links, options.hotRatio);
    const throttled = gate?.refused ?? 0;
    const unserved = Math.max(0, cell.links - servedCount(status));
    results.push({
      cell,
      hot,
      throttled,
      unserved,
      sweepMs: status.lastSweepMs as number,
      phases: status.lastSweepPhaseMs ?? null,
      linksDiscovered: status.linksDiscovered ?? null,
      linksTriaged: status.linksTriaged ?? null,
      rpcCalls,
      rpcTotal,
    });
    if (!options.json) {
      const row = results[results.length - 1]!;
      process.stdout.write(
        `  ${String(cell.links).padStart(5)} links @ ${`${cell.latency.p50Ms}:${cell.latency.p90Ms}`.padStart(9)} ms  ` +
          `sweep ${String(Math.round(row.sweepMs)).padStart(7)} ms  ${row.rpcTotal} RPC calls` +
          `${row.throttled > 0 ? `  ${row.throttled} refused 429` : ""}${row.unserved > 0 ? `  ${row.unserved} unserved` : ""}` +
          `  [${rowVerdict(row.sweepMs, options.windowMs, row.throttled + row.unserved)}]\n`,
      );
    }
  }

  server.close();
  if (chain.unmodelled.size > 0) notes.push(`the keeper asked for RPC methods this stub does not model: ${[...chain.unmodelled].sort().join(", ")}`);

  report(options, results, notes);
}

/** Everything the report says about one latency shape: the rows, the lanes and the ceiling. */
interface LatencyReading {
  readonly latency: { readonly p50Ms: number; readonly p90Ms: number };
  readonly rows: readonly CellResult[];
  readonly costs: LaneCosts | null;
  readonly roundTripMs: number | null;
  readonly writeFloor: ReturnType<typeof settleWriteFloor> | null;
  /** At the measured hot share, write floor charged, plan applied: the number to plan on. */
  readonly ceiling: CeilingAnswer | null;
  /** The same fleet priced on reads alone, with no plan: the question c6e38d8 answered. */
  readonly readsOnly: CeilingAnswer | null;
  /** c6e38d8's own method: one straight line through the sweep totals. Printed so the correction is visible. */
  readonly straightLine: number | null;
  readonly measuredFitting: number | null;
  readonly byHotShare: readonly { readonly hotShare: number; readonly ceiling: CeilingAnswer; readonly jupiter: number | null }[];
  readonly backlog: ReturnType<typeof backlogFill>;
}

function readLatency(options: Options, rows: readonly CellResult[], latency: LatencyReading["latency"]): LatencyReading {
  // ONLY CLEAN ROWS PRICE A LANE. A row with a refusal ended its turns early and
  // would price a user at the cost of failing, which is the cheapest thing there is.
  const clean = rows.filter((row) => row.throttled === 0 && row.unserved === 0);
  const costs = laneCosts(
    clean.map((row) => ({
      links: row.cell.links,
      hot: row.hot,
      sweepMs: row.sweepMs,
      triageMs: row.phases?.["triageMs"] ?? 0,
      expensiveMs: row.phases?.["expensiveMs"] ?? 0,
      rpcCalls: row.rpcTotal,
    })),
    options.hotTxCount,
  );
  const trip = costs === null ? null : roundTripMs(costs);
  const writeFloor = trip === null ? null : settleWriteFloor(trip, options.privyMs);
  const ask = (hotShare: number, write: boolean, plan: boolean): CeilingAnswer | null =>
    costs === null || writeFloor === null
      ? null
      : fleetCeiling({
          costs,
          windowMs: options.windowMs,
          hotShare,
          writeMs: write ? writeFloor.ms : 0,
          writeCalls: write ? writeFloor.calls : 0,
          planRps: plan ? options.planRps : null,
        });
  const shares = [...new Set([...SENSITIVITY_HOT_SHARES, options.hotRatio])].sort((a, b) => a - b);
  const points = rows.map((row) => ({ links: row.cell.links, sweepMs: row.sweepMs }));
  const line = fitSweepCost(points);
  return {
    latency,
    rows,
    costs,
    roundTripMs: trip,
    writeFloor,
    ceiling: ask(options.hotRatio, true, true),
    readsOnly: ask(options.hotRatio, false, false),
    straightLine: line === null ? null : ceilingLinks(line, options.windowMs),
    measuredFitting: largestFitting(
      clean.map((row) => ({ links: row.cell.links, sweepMs: row.sweepMs })),
      options.windowMs,
    ),
    byHotShare: shares.flatMap((hotShare) => {
      const ceiling = ask(hotShare, true, true);
      return ceiling === null ? [] : [{ hotShare, ceiling, jupiter: jupiterBuyerCeiling(hotShare, options.windowMs) }];
    }),
    backlog: costs === null || writeFloor === null ? null : backlogFill(costs, options.windowMs, writeFloor.ms),
  };
}

const pct = (share: number): string => `${Math.round(share * 1000) / 10} %`;

/** A ceiling in words, with the term that set it. */
function ceilingWords(answer: CeilingAnswer, planRps: number | null): string {
  const rate = answer.driveRps === null ? "the rate in the req/s column above" : `${answer.driveRps.toFixed(1)} req/s`;
  switch (answer.binding) {
    case "unmeasured":
      return "NOT STATED — no clean row had a hot user to price; raise --hot-ratio or the fleet sizes";
    case "refused":
      return (
        `NONE, AS THE KEEPER IS WRITTEN: its sweep drives ${rate} against a plan of ${planRps} req/s, and src/rpc-pool.ts throws on a 429 ` +
        `instead of backing off, so once the plan's one-second burst is spent the calls over it are REFUSED and the users behind them go unserved ` +
        "(the rows above show the fleet size where that starts). " +
        `A keeper that paced itself could reach ${answer.byPlan ?? "an unknown size"}; this one cannot`
      );
    case "window":
      return (
        `AT MOST ${answer.links} links, set by the window. It drives ${rate} while it sweeps` +
        (planRps === null
          ? " and holds ONLY on a provider plan that grants that sustained — below it, a 429 is a refusal, not a slowdown (pass --plan-rps)"
          : `, inside the plan's ${planRps} req/s`)
      );
  }
}

function report(options: Options, results: readonly CellResult[], notes: readonly string[]): void {
  const readings = options.latencies.flatMap((latency) => {
    const rows = results.filter((row) => row.cell.latency.p50Ms === latency.p50Ms && row.cell.latency.p90Ms === latency.p90Ms);
    return rows.length === 0 ? [] : [readLatency(options, rows, latency)];
  });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          options: { ...options },
          writePath: WRITE_PATH_REFUSAL,
          cells: results.map((row) => ({
            links: row.cell.links,
            hot: row.hot,
            latency: row.cell.latency,
            sweepMs: row.sweepMs,
            verdict: rowVerdict(row.sweepMs, options.windowMs, row.throttled + row.unserved),
            throttled: row.throttled,
            unserved: row.unserved,
            phases: row.phases,
            linksDiscovered: row.linksDiscovered,
            linksTriaged: row.linksTriaged,
            rpcCalls: row.rpcCalls,
            rpcTotal: row.rpcTotal,
          })),
          ceilings: readings.map(({ rows: _rows, ...reading }) => reading),
          notes,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const out = (line: string): void => void process.stdout.write(`${line}\n`);
  out("");
  out(
    `SWEEP WINDOW ${options.windowMs} ms · ${pct(options.hotRatio)} of the fleet hot, ${options.hotTxCount} transactions each · ` +
      `plan ${options.planRps === null ? "not given (no 429s modelled)" : `${options.planRps} req/s, enforced as 429s`} · Privy ${options.privyMs} ms`,
  );
  out("");
  for (const reading of readings) {
    const { latency, rows, costs, writeFloor } = reading;
    out(`latency p50 ${latency.p50Ms} ms / p90 ${latency.p90Ms} ms`);
    out("   links  hot   sweep ms  chainRead  discovery  vaultRead     triage  expensive  RPC calls*  req/s*   429s  unserved   verdict");
    for (const row of rows) {
      const phase = (name: string): string => String(Math.round(row.phases?.[name] ?? 0)).padStart(10);
      out(
        `${String(row.cell.links).padStart(8)} ${String(row.hot).padStart(4)} ${String(Math.round(row.sweepMs)).padStart(10)} ` +
          `${phase("chainReadMs")} ${phase("discoveryMs")} ${phase("vaultReadMs")} ${phase("triageMs")} ${phase("expensiveMs")} ` +
          `${String(row.rpcTotal).padStart(10)} ${(row.sweepMs > 0 ? (row.rpcTotal / row.sweepMs) * 1_000 : 0).toFixed(1).padStart(7)} ` +
          `${String(row.throttled).padStart(6)} ${String(row.unserved).padStart(9)}   ` +
          rowVerdict(row.sweepMs, options.windowMs, row.throttled + row.unserved),
      );
    }
    out("  * RPC calls count the whole keeper process, its boot read (3 calls) included, and req/s is them over the sweep: the rate a");
    out("    plan has to grant. The per-user figures below are fitted clean of the boot read.");
    out(
      `  MEASURED: ${reading.measuredFitting === null ? "no clean fleet size fitted the window" : `${reading.measuredFitting} links fitted the window with nothing refused`}.`,
    );
    if (costs === null || writeFloor === null || reading.ceiling === null || reading.readsOnly === null) {
      out("  LANES: not priced — they need two clean fleet sizes with an idle user among them, and these rows do not have that.");
      out("");
      continue;
    }
    const calls = (value: number | null): string => (value === null ? "?" : value.toFixed(1));
    out(
      `  LANES (measured, the keeper's own triageMs / expensiveMs): fixed ${Math.round(costs.fixedMs)} ms · ` +
        `idle user ${costs.idleMs.toFixed(1)} ms over ${calls(costs.idleCalls)} calls · ` +
        (costs.hotReadMs === null
          ? "hot user NOT MEASURED (no clean row had one)"
          : `hot user at ${costs.hotTxCount} tx ${costs.hotReadMs.toFixed(1)} ms over ${calls(costs.hotCalls)} calls, reads only`),
    );
    out(
      `  WRITE FLOOR per hot user (derived from settle-tick.ts, never run here): ${Math.round(writeFloor.ms)} ms = ` +
        `Privy ${options.privyMs} ms${options.privyMs === 0 ? " (NOT measured, NOT charged)" : " (assumed)"} + CONFIRM_POLL_MS ${CONFIRM_POLL_MS} ms + ` +
        `3 round trips at ${reading.roundTripMs?.toFixed(1)} ms. A floor: the invest leg's Jupiter calls and sends are on top and not charged.`,
    );
    out(`  CEILING at ${pct(options.hotRatio)} hot: ${ceilingWords(reading.ceiling, options.planRps)}.`);
    out(
      `    for the record: priced on reads alone with no plan, as c6e38d8 priced it, this is ${reading.readsOnly.links ?? "unstated"}; ` +
        `c6e38d8's straight line through these totals says ${reading.straightLine ?? "nothing"}.`,
    );
    out("    by hot share (DERIVED from the lanes above; the fleet a sweep sees changes minute by minute):");
    out("      hot    at most   set by       req/s   Jupiter, if every hot user also bought");
    for (const { hotShare, ceiling, jupiter } of reading.byHotShare) {
      out(
        `    ${pct(hotShare).padStart(7)} ${String(ceiling.links ?? "-").padStart(9)}   ${ceiling.binding.padEnd(10)} ` +
          `${(ceiling.driveRps === null ? "?" : ceiling.driveRps.toFixed(1)).padStart(7)}   ` +
          `${jupiter === null ? "-" : `${jupiter} (${JUPITER_KEYLESS_CALLS_PER_MINUTE} req/min keyless)`}`,
      );
    }
    if (reading.backlog !== null) {
      out(
        `  AFTER AN OUTAGE (derived): a trader backlogged to ${MAX_SIGNATURES} transactions costs about ${Math.round(reading.backlog.perUserMs)} ms, ` +
          `walked one getTransaction at a time — ${reading.backlog.users} such users fill the window on their own, whatever the fleet.`,
    );
    }
    out(
      `  ONE SETTLE THAT NEVER CONFIRMS costs ${Math.round(writeFloor.stuckMs)} ms (CONFIRM_TIMEOUT_MS) inside the sequential loop: ` +
        `${writeFloor.stuckMs >= options.windowMs ? "the whole window, on one user" : `${Math.round((writeFloor.stuckMs / options.windowMs) * 100)} % of the window, on one user`}.`,
    );
    out("");
  }

  out("WHAT THIS DOES NOT MEASURE");
  out("  · The write path. The stub accepts no transaction and the keeper runs dry, so signing, sending and confirming are never RUN;");
  out("    they are charged to each hot user as the FLOOR above, so every ceiling here is an upper bound (\"at most\").");
  out(
    `  · Jupiter, the binding external limit on BUYING turns: the keyless tier allows ${JUPITER_KEYLESS_CALLS_PER_MINUTE} requests a minute ` +
      `and a buying turn spends about ${JUPITER_CALLS_PER_BUYING_TURN}, so about ${JUPITER_KEYLESS_CALLS_PER_MINUTE / JUPITER_CALLS_PER_BUYING_TURN} buying turns a minute ` +
      "whatever the sweep does — the last column above.",
  );
  out("  · The tail. The injected lognormal cannot draw a call slower than about 10x its p50, and a real request can wait the pool's");
  out("    30 s timeout: one such call in the sequential loop is half a window. The per-user prices here are floors for that reason too.");
  out("  · The fixed costs a dry run skips: the per-sweep Privy wallet listing (grows with the Privy app's wallets, not with links),");
  out("    the armed claim's DB round trip, the authorization-key check and the alert webhook.");
  out("  · Production latency and production's plan. The real shapes are whatever Helius answers Railway, which only the deployed");
  out("    keeper's /status can say (lastSweepPhaseMs, sweepMsP50, sweepMsP90), and the plan's req/s is the owner's to supply.");
  for (const note of notes) out(`  · ${note}`);
  out("");
}

await main();
