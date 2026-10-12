// ONE WORKER PROCESS of test-local/fence-pg.local.test.ts's SIGTERM drill (ADR
// §4.9 row 6: "two workers over 50 vaults, one SIGTERM'd every 20 s for 10 min:
// overlap audit returns no rows"). Started by that file with `node --import tsx`,
// never by anything else, and it touches only the throwaway database it is given.
//
// WHAT IS REAL: a process of its own with its own Postgres sessions, the store's
// four statements (src/dispatch-store.ts), its pool size, the 10 s heartbeat on a
// timer of its own, and SIGTERM as Railway sends it: stop claiming and sending,
// let a confirm already in flight run for at most the drain, RELEASE every vault
// still held, exit 0.
//
// WHAT IS NOT: the chain. It is a table in the same database (schema
// fence_drill), advanced by the test file one block per slot: a "send" inserts a
// transaction with the vault state it was planned from and its last valid height;
// the ticker lands it, at some block not past that height, or never (a dropped
// send). Landing applies it to the vault's state, and a transaction that lands on
// a state other than the one it was planned from is a DOUBLE — what the fence
// exists to stop, counted by the test file beside the ADR's overlap audit.
//
// THE JOB is the dispatcher's, ADR §3.2 and §3.6, without the money:
//   1. the takeover: the earlier fences' open intents, resolved from the chain
//      (landed), or expired once the finalized height has passed their last valid
//      height; one still able to land ends the job unchanged, due after it expires;
//   2. no plan until the finalized height is above every earlier fence's intent
//      (PriorIntents.planFloor): that height is the plan's plan_cleared_height;
//   3. one to DRILL_SENDS_MAX sends, each planned from a fresh read, gated (the
//      transaction form and the one-statement form in turn), sent, and confirmed
//      before the next;
//   4. complete, due again within DRILL_DUE_MAX_MS — or, under SIGTERM, release.
// Every step it takes is one JSON line on stdout, which the test file counts.

import { randomUUID } from "node:crypto";
import pg from "pg";
import { Secret } from "@sip/solana-log";
import { DispatchStore, createDispatchPool, type ClaimedVault, type GateAnswer, type IntentKind } from "../src/dispatch-store.js";

const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`the drill worker needs ${name}`);
  return value;
};
const num = (name: string): number => Number(env(name));

const URL_RAW = env("DRILL_PG_URL");
const ID = env("DRILL_WORKER_ID");
const SLOTS = num("DRILL_SLOTS");
const SLOT_MS = num("DRILL_SLOT_MS");
const VALIDITY = BigInt(env("DRILL_VALIDITY"));
const FINALITY = BigInt(env("DRILL_FINALITY"));
const DRAIN_MS = num("DRILL_DRAIN_MS");
const HEARTBEAT_MS = num("DRILL_HEARTBEAT_MS");
const DROP_RATE = num("DRILL_DROP_RATE");
const SENDS_MAX = num("DRILL_SENDS_MAX");
const DUE_MAX_MS = num("DRILL_DUE_MAX_MS");

const emit = (event: string, fields: Record<string, unknown> = {}): void => {
  process.stdout.write(`${JSON.stringify({ event, worker: ID, ...fields }, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n`);
};

const dispatchPool = createDispatchPool(new Secret(URL_RAW, "databaseUrl"), "worker", `fence-drill:${ID}`, (message, fields) =>
  emit("pool-warn", { message, ...fields }),
);
// THE CHAIN IS ANOTHER SERVICE: its own pool, so the dispatch pool's two
// connections are the queue's alone, as in production.
const chainPool = new pg.Pool({ connectionString: URL_RAW, max: 2, application_name: `fence-drill-chain:${ID}` });
chainPool.on("error", () => undefined);
const store = new DispatchStore(dispatchPool, ID);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Job {
  readonly claimed: ClaimedVault;
  lost: boolean;
}
const jobs = new Map<string, Job>();
const running = new Set<Promise<void>>();
let terminating = false;
let drainDeadline = Number.POSITIVE_INFINITY;

async function chain(): Promise<{ height: bigint; finalized: bigint }> {
  const { rows } = await chainPool.query("SELECT height, finalized FROM fence_drill.chain");
  return { height: BigInt(String(rows[0]!["height"])), finalized: BigInt(String(rows[0]!["finalized"])) };
}

async function landedAt(signature: string | null): Promise<bigint | null> {
  if (signature === null) return null;
  const { rows } = await chainPool.query("SELECT landed_height FROM fence_drill.tx WHERE signature = $1", [signature]);
  const value = rows[0]?.["landed_height"];
  return value === null || value === undefined ? null : BigInt(String(value));
}

async function stateOf(vault: string): Promise<bigint> {
  const { rows } = await chainPool.query("SELECT state FROM fence_drill.vault WHERE vault_addr = $1", [vault]);
  return BigInt(String(rows[0]!["state"]));
}

/** Waits for a sent transaction: it lands, it expires (finalized past its lvbh), or the drain runs out. */
async function confirm(signature: string, lvbh: bigint): Promise<{ kind: "landed"; height: bigint } | { kind: "expired" } | { kind: "drained" }> {
  for (;;) {
    const landed = await landedAt(signature);
    if (landed !== null) return { kind: "landed", height: landed };
    if ((await chain()).finalized > lvbh) return { kind: "expired" };
    if (terminating && Date.now() > drainDeadline) return { kind: "drained" };
    await sleep(SLOT_MS);
  }
}

const KINDS: readonly IntentKind[] = ["wrap", "convert", "invest"];

async function runJob(job: Job): Promise<void> {
  const { claimed } = job;
  let done = false;
  try {
    // 1. THE TAKEOVER.
    let prior = await store.priorIntents(claimed);
    let view = await chain();
    for (const open of prior.open) {
      const landed = await landedAt(open.signature);
      if (landed !== null) {
        await store.resolveIntent(open.id, "landed", landed);
        emit("takeover-resolved", { vault: claimed.vault, fence: claimed.fence, intent: open.id, outcome: "landed" });
      } else if (view.finalized > open.lastValidBlockHeight) {
        await store.resolveIntent(open.id, "expired", open.lastValidBlockHeight);
        emit("takeover-resolved", { vault: claimed.vault, fence: claimed.fence, intent: open.id, outcome: "expired" });
      }
    }
    prior = await store.priorIntents(claimed);
    if (prior.open.length > 0) {
      // STILL ABLE TO LAND: complete unchanged, due once it has expired, so the lease is not held while waiting.
      const latest = prior.open.reduce((max, open) => (open.lastValidBlockHeight > max ? open.lastValidBlockHeight : max), 0n);
      const blocks = Number(latest - view.height + FINALITY + 1n);
      done = await store.complete(claimed, {
        rests: false,
        lane: "retry",
        streaks: claimed.streaks,
        outcome: "WAITING_INTENT",
        detail: `waiting out ${prior.open.length} open intent(s)`,
        dueInSeconds: Math.max(0, (blocks * SLOT_MS) / 1_000),
      });
      emit("takeover-deferred", { vault: claimed.vault, fence: claimed.fence, open: prior.open.length });
      return;
    }
    // 2. NO PLAN UNTIL THE FINALIZED HEIGHT IS ABOVE EVERY EARLIER INTENT.
    let waited = false;
    while (prior.planFloor !== null && view.finalized <= prior.planFloor) {
      if (terminating || job.lost) break;
      waited = true;
      await sleep(SLOT_MS);
      view = await chain();
    }
    if (prior.planFloor !== null && view.finalized <= prior.planFloor) {
      if (terminating) {
        done = await store.release(claimed, "SIGTERM before planning");
        emit("released", { vault: claimed.vault, fence: claimed.fence, open: false });
      }
      return;
    }
    const planCleared = view.finalized;
    emit("plan", { vault: claimed.vault, fence: claimed.fence, planCleared, floor: prior.planFloor, waited });
    // 3. THE SENDS.
    const sends = 1 + Math.floor(Math.random() * SENDS_MAX);
    let leftOpen = false;
    for (let i = 0; i < sends; i++) {
      if (terminating || job.lost) break;
      const planned = await stateOf(claimed.vault);
      view = await chain();
      const lvbh = view.height + VALIDITY;
      const signature = randomUUID();
      const draft = {
        vault: claimed.vault,
        fence: claimed.fence,
        kind: KINDS[i % KINDS.length]!,
        link: null,
        blockhash: `drill-${view.height}`,
        lastValidBlockHeight: lvbh,
        planClearedHeight: planCleared,
        signature,
        idempotencyKey: null,
        amountRaw: 1n,
      };
      const answer: GateAnswer = i % 2 === 0 ? await store.gate(draft) : await store.gateOneStatement(draft);
      if (answer.kind !== "gated") {
        // DROP THE SIGNED BYTES: nothing goes to the chain.
        emit("gate-refused", { vault: claimed.vault, fence: claimed.fence, answer: answer.kind, detail: answer.detail });
        job.lost = true;
        break;
      }
      await chainPool.query(
        `INSERT INTO fence_drill.tx (signature, vault_addr, fence, worker_id, lvbh, planned_state, dropped, sent_height)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [signature, claimed.vault, claimed.fence.toString(), ID, lvbh.toString(), planned.toString(), Math.random() < DROP_RATE, view.height.toString()],
      );
      emit("sent", { vault: claimed.vault, fence: claimed.fence, intent: answer.intentId, form: i % 2 === 0 ? "transaction" : "one-statement" });
      const outcome = await confirm(signature, lvbh);
      if (outcome.kind === "landed") {
        await store.resolveIntent(answer.intentId, "landed", outcome.height);
      } else if (outcome.kind === "expired") {
        await store.resolveIntent(answer.intentId, "expired", lvbh);
        break;
      } else {
        leftOpen = true;
        break;
      }
    }
    // 4. COMPLETE, OR RELEASE UNDER SIGTERM.
    if (terminating) {
      done = await store.release(claimed, "SIGTERM");
      emit("released", { vault: claimed.vault, fence: claimed.fence, open: leftOpen });
    } else if (!job.lost) {
      done = await store.complete(claimed, {
        rests: false,
        lane: "new",
        streaks: claimed.streaks,
        outcome: "DRILL",
        detail: null,
        dueInSeconds: (Math.random() * DUE_MAX_MS) / 1_000,
      });
      emit("completed", { vault: claimed.vault, fence: claimed.fence, done });
    }
  } catch (error) {
    emit("job-error", { vault: claimed.vault, fence: claimed.fence, detail: error instanceof Error ? error.message : String(error) });
  } finally {
    jobs.delete(claimed.vault);
    if (!done && terminating) emit("left-held", { vault: claimed.vault, fence: claimed.fence });
  }
}

async function beat(): Promise<void> {
  const held = [...jobs.values()].map((job) => job.claimed);
  try {
    const renewed = await store.heartbeat(held);
    for (const job of jobs.values()) {
      if (!renewed.has(job.claimed.vault) && held.some((h) => h.vault === job.claimed.vault)) {
        job.lost = true;
        emit("lease-lost", { vault: job.claimed.vault, fence: job.claimed.fence });
      }
    }
    await store.beatProcess(jobs.size);
  } catch (error) {
    emit("heartbeat-error", { detail: error instanceof Error ? error.message : String(error) });
  }
}

async function main(): Promise<void> {
  await store.registerProcess("worker", "fence-drill", SLOTS);
  const timer = setInterval(() => void beat(), HEARTBEAT_MS);
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  process.on("SIGTERM", () => {
    if (terminating) return;
    terminating = true;
    drainDeadline = Date.now() + DRAIN_MS;
    emit("sigterm", { held: jobs.size });
    resolveStop();
  });
  emit("ready");
  while (!terminating) {
    const free = SLOTS - jobs.size;
    let took = 0;
    if (free > 0) {
      const claimed = await store.claim(free).catch((error: unknown) => {
        emit("claim-error", { detail: error instanceof Error ? error.message : String(error) });
        return [] as const;
      });
      for (const vault of claimed) {
        if (terminating) {
          // CLAIMED AS THE SIGNAL CAME: handed straight back.
          await store.release(vault, "SIGTERM before the job started").catch(() => undefined);
          emit("released", { vault: vault.vault, fence: vault.fence, open: false });
          continue;
        }
        const job: Job = { claimed: vault, lost: false };
        jobs.set(vault.vault, job);
        emit("claimed", { vault: vault.vault, fence: vault.fence });
        const run = runJob(job).finally(() => running.delete(run));
        running.add(run);
        took += 1;
      }
    }
    await Promise.race([sleep(took > 0 ? 5 : 50), stopped]);
  }
  await Promise.allSettled([...running]);
  clearInterval(timer);
  await store.processStopped().catch(() => undefined);
  await dispatchPool.end().catch(() => undefined);
  await chainPool.end().catch(() => undefined);
  emit("exit");
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    emit("fatal", { detail: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  },
);
