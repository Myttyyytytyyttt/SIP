#!/usr/bin/env node
// HOW MANY SIMULTANEOUS USERS FIT IN A SWEEP — measured, without real users and
// without hammering anybody's RPC.
//
//   pnpm --dir packages/solana-keeper bench:ceiling
//   pnpm --dir packages/solana-keeper bench:ceiling -- --links 1,25,100 --latency 86:122 --hot-ratio 0.02
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
// So these numbers are the READ path and the loop overhead. Signing, sending and
// confirming are NOT in them — and the confirm in particular is the one that can
// swallow a whole sweep on its own (settle-tick.ts's CONFIRM_TIMEOUT_MS is
// 60_000, inside the sequential loop).
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
import { buildFleet, benchKey } from "../src/bench/fleet.js";
import { buildGrid, ceilingLinks, fitSweepCost, largestFitting, parseCountList, parseLatencyList, sweepVerdict, type BenchCell } from "../src/bench/grid.js";
import { createLatency, type LatencySampler } from "../src/bench/latency.js";
import { idl } from "../src/idl.js";
import { JUPITER_CALLS_PER_ROUTE_BUILD, JUPITER_KEYLESS_CALLS_PER_MINUTE } from "../src/sweep-cost.js";

const KEEPER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Options {
  readonly links: readonly number[];
  readonly latencies: readonly { readonly p50Ms: number; readonly p90Ms: number }[];
  readonly hotRatio: number;
  readonly hotTxCount: number;
  readonly windowMs: number;
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

  const server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      // ONE DRAW PER ROUND TRIP. The keeper makes one HTTP request per RPC call
      // (src/rpc-pool.ts replaces the transport under Connection), so a delay
      // here is a delay on exactly one call, which is what the grid varies.
      await sleep(latency.next());
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
    results.push({
      cell,
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
          `sweep ${String(Math.round(row.sweepMs)).padStart(7)} ms  ${row.rpcTotal} RPC calls  [${sweepVerdict(row.sweepMs, options.windowMs)}]\n`,
      );
    }
  }

  server.close();
  if (chain.unmodelled.size > 0) notes.push(`the keeper asked for RPC methods this stub does not model: ${[...chain.unmodelled].sort().join(", ")}`);

  report(options, results, notes);
}

function report(options: Options, results: readonly CellResult[], notes: readonly string[]): void {
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          options: { ...options },
          writePath: WRITE_PATH_REFUSAL,
          cells: results.map((row) => ({
            links: row.cell.links,
            latency: row.cell.latency,
            sweepMs: row.sweepMs,
            verdict: sweepVerdict(row.sweepMs, options.windowMs),
            phases: row.phases,
            linksDiscovered: row.linksDiscovered,
            linksTriaged: row.linksTriaged,
            rpcCalls: row.rpcCalls,
            rpcTotal: row.rpcTotal,
          })),
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
  out(`SWEEP WINDOW ${options.windowMs} ms · ${Math.round(options.hotRatio * 1000) / 10} % of the fleet hot, ${options.hotTxCount} transactions each`);
  out("");
  for (const latency of options.latencies) {
    const rows = results.filter((row) => row.cell.latency.p50Ms === latency.p50Ms && row.cell.latency.p90Ms === latency.p90Ms);
    if (rows.length === 0) continue;
    out(`latency p50 ${latency.p50Ms} ms / p90 ${latency.p90Ms} ms`);
    out("   links   sweep ms   per link   chainRead  discovery  vaultRead     triage  expensive   RPC calls   verdict");
    for (const row of rows) {
      const phase = (name: string): string => String(Math.round(row.phases?.[name] ?? 0)).padStart(10);
      out(
        `${String(row.cell.links).padStart(8)} ${String(Math.round(row.sweepMs)).padStart(10)} ` +
          `${(row.cell.links === 0 ? "-" : (row.sweepMs / row.cell.links).toFixed(1)).padStart(10)} ` +
          `${phase("chainReadMs")} ${phase("discoveryMs")} ${phase("vaultReadMs")} ${phase("triageMs")} ${phase("expensiveMs")} ` +
          `${String(row.rpcTotal).padStart(11)}   ${sweepVerdict(row.sweepMs, options.windowMs)}`,
      );
    }
    const points = rows.map((row) => ({ links: row.cell.links, sweepMs: row.sweepMs }));
    const fit = fitSweepCost(points);
    const measured = largestFitting(points, options.windowMs);
    if (fit === null) {
      out(`  measured: ${measured === null ? "no fleet size fitted the window" : `${measured} links still fit`}; two fleet sizes are needed before a per-link cost can be drawn`);
    } else {
      const ceiling = ceilingLinks(fit, options.windowMs);
      out(
        `  measured: ${measured === null ? "no fleet size fitted the window" : `${measured} links fitted the window`}. ` +
          `Fitted over ${fit.points} sweeps: ${Math.round(fit.fixedMs)} ms fixed + ${fit.perLinkMs.toFixed(1)} ms per link.`,
      );
      out(`  EXTRAPOLATED (a straight line through the rows above, not a sweep anyone ran): the window fills at about ${ceiling === null ? "no size — the fitted per-link cost is not positive" : `${ceiling} links`}.`);
    }
    out("");
  }

  out("WHAT THIS DOES NOT MEASURE");
  out(`  · ${WRITE_PATH_REFUSAL}.`);
  out("  · A confirmation that never lands. settle-tick.ts polls for up to CONFIRM_TIMEOUT_MS = 60_000 ms inside this same");
  out("    sequential loop, so one live wallet can burn an entire sweep on its own. That is a property of the write path.");
  out(
    `  · Jupiter, which is the binding external limit on ACTIVE users and not this process: the keyless tier allows ` +
      `${JUPITER_KEYLESS_CALLS_PER_MINUTE} requests a minute and an invest turn spends about ${JUPITER_CALLS_PER_ROUTE_BUILD * 6}, ` +
      `so roughly ${Math.floor(JUPITER_KEYLESS_CALLS_PER_MINUTE / (JUPITER_CALLS_PER_ROUTE_BUILD * 6))}-3 buying turns a minute whatever the sweep does.`,
  );
  out("  · Production latency. These rows used the shapes asked for on the command line; the real ones are whatever Helius");
  out("    answers Railway, which only the deployed keeper's own /status can say (lastSweepPhaseMs, sweepMsP50, sweepMsP90).");
  for (const note of notes) out(`  · ${note}`);
  out("");
}

await main();
