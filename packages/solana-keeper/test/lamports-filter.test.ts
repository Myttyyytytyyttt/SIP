// C7, `lamports-filter` (src/lamports-filter.ts): a quiet link is not probed
// for real, for up to thirty minutes.
//
// THE PROPERTY IS CHECKED AGAINST A REAL WALK. Over random histories of one
// wallet — trades that move its lamports, a stranger's zero-value transfers and
// token-only swaps somebody else paid for (the two delay classes that leave the
// fingerprint as it was), wSOL moving in its ATA, finality lagging and our own
// settles landing — the scheduler's filter decides each tick whether the link
// gets a job. Whenever it SKIPS, the real settle turn (runSettleTick, dry, over
// test/settle-world.ts) is run anyway on the same chain, and must agree that
// there is nothing to do — or every event since the last real probe must be of
// a delay class, and that probe less than thirty minutes old. Whenever the
// filter PROBES, the real turn is what decides, and what the scheduler records.
//
// AND THE POST-BOOT STAGGER (RT-19): after a takeover, over the hour that
// follows, no tick makes more than ⌈N × tick / pass⌉ forced probes.

import { describe, expect, it } from "vitest";
import { settleRests } from "../src/doorbell.js";
import { C7_REAL_PROBE_MS, LamportsFilter, linkHash, type LinkFingerprint } from "../src/lamports-filter.js";
import { SettleWorld, WorldKeeper, rng } from "./settle-world.js";

const TICK = 60_000;

const print = (over: Partial<LinkFingerprint> = {}): LinkFingerprint => ({ lamports: 5_000n, wsol: 0n, slot: 100, nonce: 0n, frontier: 0n, ...over });

/** A filter holding a memo for L1 (vault V1) read at slot 100 and probed at `probedAt`. */
function memoised(probedAt = 10_000): LamportsFilter {
  const filter = new LamportsFilter();
  filter.enqueued("V1", new Map([["L1", print()]]), probedAt - 1);
  expect(filter.observe("V1", { claimedAt: probedAt, doneAt: probedAt + 500, rests: true, held: false })).toBe("committed");
  return filter;
}

describe("canSkip: every condition of ADR §2.3.4", () => {
  it("skips only with a memo, the same fingerprint, a slot not behind, the same link state and a probe under 30 minutes old", () => {
    const filter = memoised();
    expect(filter.canSkip("L1", print({ slot: 120 }), 10_000 + C7_REAL_PROBE_MS - 1)).toEqual({ skip: true });
    expect(filter.canSkip("L2", print(), 20_000)).toEqual({ skip: false, reason: "no-memo" });
    expect(filter.canSkip("L1", print({ lamports: 4_999n }), 20_000)).toEqual({ skip: false, reason: "moved" });
    expect(filter.canSkip("L1", print({ wsol: 1n }), 20_000)).toEqual({ skip: false, reason: "moved" });
    expect(filter.canSkip("L1", print({ slot: 99 }), 20_000)).toEqual({ skip: false, reason: "slot-behind" });
    expect(filter.canSkip("L1", print({ nonce: 1n }), 20_000)).toEqual({ skip: false, reason: "settled" });
    expect(filter.canSkip("L1", print({ frontier: 7n }), 20_000)).toEqual({ skip: false, reason: "settled" });
    expect(filter.canSkip("L1", print(), 10_000 + C7_REAL_PROBE_MS)).toEqual({ skip: false, reason: "probe-due" });
    expect(filter.status()).toMatchObject({ skips: 1, refusals: { "no-memo": 1, moved: 2, "slot-behind": 1, settled: 2, "probe-due": 1 } });
  });

  it("commits a memo only from a job claimed AFTER the read and completed, drops it when the job did not rest, and waits otherwise", () => {
    const filter = new LamportsFilter();
    filter.enqueued("V1", new Map([["L1", print()]]), 1_000);
    // A JOB CLAIMED BEFORE THE READ cannot vouch for it.
    expect(filter.observe("V1", { claimedAt: 999, doneAt: 1_500, rests: true, held: false })).toBe("waiting");
    // Held, or claimed and not yet completed: waiting.
    expect(filter.observe("V1", { claimedAt: 1_001, doneAt: 900, rests: true, held: true })).toBe("waiting");
    expect(filter.observe("V1", { claimedAt: 1_001, doneAt: 900, rests: true, held: false })).toBe("waiting");
    expect(filter.observe("V1", { claimedAt: 1_001, doneAt: 1_200, rests: false, held: false })).toBe("dropped");
    expect(filter.realProbeAt("L1")).toBeNull();
    filter.enqueued("V1", new Map([["L1", print()]]), 2_000);
    expect(filter.observe("V1", { claimedAt: 2_001, doneAt: 2_300, rests: true, held: false })).toBe("committed");
    expect(filter.realProbeAt("L1")).toBe(2_001);
    expect(filter.observe("V1", { claimedAt: 2_001, doneAt: 2_300, rests: true, held: false })).toBe("none");
  });

  it("forgets everything on a takeover, and what discovery no longer lists", () => {
    const filter = memoised();
    filter.enqueued("V2", new Map([["L2", print()]]), 50_000);
    filter.prune(new Set(["L1"]), new Set(["V1"]));
    expect(filter.status()).toMatchObject({ memos: 1, pending: 0 });
    filter.takeover();
    expect(filter.status()).toMatchObject({ memos: 0, pending: 0 });
    expect(filter.canSkip("L1", print(), 11_000)).toEqual({ skip: false, reason: "no-memo" });
  });
});

/** What happened to the wallet since its last real probe. */
type Event = "trade" | "gasless-swap" | "stranger-zero-transfer" | "wsol" | "settle-landed";
const DELAY_CLASSES: ReadonlySet<Event> = new Set(["gasless-swap", "stranger-zero-transfer"]);

describe("C7 against the real walk: a skip is never a missed settle, only a bounded delay of the two delay classes", () => {
  it("over 40 random two-hour histories", async () => {
    let skips = 0;
    let probes = 0;
    let delayedSkips = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const random = rng(seed);
      const world = new SettleWorld();
      world.trade(800_000_000);
      world.finalizeTo(world.tip);
      const keeper = new WorldKeeper(world);
      const filter = new LamportsFilter();
      let wsol = 0n;
      let now = 1_000_000;
      let lastRealProbeAt: number | null = null;
      let vaultRests = false;
      let since: Event[] = [];
      for (let tick = 0; tick < 120; tick++) {
        // ── the chain moves ──
        const r = random();
        if (r < 0.12) {
          world.trade((random() < 0.5 ? 1 : -1) * (50_000_000 + Math.floor(random() * 400_000_000)));
          since.push("trade");
        } else if (r < 0.2) {
          world.trade(0);
          since.push("gasless-swap");
        } else if (r < 0.28) {
          world.transfer();
          since.push("stranger-zero-transfer");
        } else if (r < 0.33) {
          wsol += BigInt(1 + Math.floor(random() * 1_000));
          since.push("wsol");
        }
        world.advance(1 + Math.floor(random() * 3));
        // FINALITY LAGS, sometimes.
        world.finalizeTo(random() < 0.8 ? world.tip : world.tip - 2);

        // ── the scheduler's read and decision (the vault is in the full or safety lane) ──
        const fp: LinkFingerprint = {
          lamports: BigInt(world.balance),
          wsol,
          slot: world.tip,
          nonce: world.link.settlementNonce,
          frontier: world.link.frontierSlot,
        };
        const link = world.link.linkAddress.toBase58();
        const verdict = vaultRests ? filter.canSkip(link, fp, now) : { skip: false as const, reason: "no-memo" as const };
        if (verdict.skip) {
          skips += 1;
          // THE TRUTH: what a real turn would say on this chain, now.
          const truth = (await new WorldKeeper(world).turn()).result;
          expect(lastRealProbeAt, `seed ${seed} tick ${tick}`).not.toBeNull();
          expect(now - lastRealProbeAt!, `seed ${seed} tick ${tick}: never past the 30-minute probe`).toBeLessThan(C7_REAL_PROBE_MS);
          if (!settleRests(truth.outcome)) {
            delayedSkips += 1;
            expect(
              since.every((event) => DELAY_CLASSES.has(event)),
              `seed ${seed} tick ${tick}: skipped a ${truth.outcome} after ${since.join(", ")}`,
            ).toBe(true);
          }
        } else {
          probes += 1;
          filter.enqueued("V", new Map([[link, fp]]), now);
          // THE JOB: claimed after the read, the real turn, and our settle landing when it would settle.
          const claimedAt = now + 1_000;
          const turn = (await keeper.turn()).result;
          let rests = settleRests(turn.outcome);
          if (turn.outcome === "SETTLED" && world.settleLands(1_000_000)) {
            world.finalizeTo(world.tip);
            since = ["settle-landed"];
            rests = false;
          } else {
            since = [];
          }
          lastRealProbeAt = claimedAt;
          vaultRests = rests;
          filter.observe("V", { claimedAt, doneAt: claimedAt + 2_000, rests, held: false });
        }
        now += TICK;
      }
    }
    // EACH SIDE OF THE PROPERTY WAS REACHED: skips, probes, and skips the truth would not have rested on.
    expect(skips).toBeGreaterThan(500);
    expect(probes).toBeGreaterThan(500);
    expect(delayedSkips).toBeGreaterThan(0);
  });
});

describe("c7-post-boot-stagger (RT-19)", () => {
  /** A quiet fleet of `n` single-link vaults taken over at `boot`: forced probes per tick over the next hour. */
  function probesPerTick(n: number, stagger: boolean): number[] {
    const filter = new LamportsFilter();
    const links = Array.from({ length: n }, (_, i) => `L${i}`);
    const quiet = print();
    const boot = 50_000_000;
    // THE BOOT PASS: every link probed for real at once.
    if (stagger) filter.planBootPass(links, boot);
    for (const link of links) {
      filter.enqueued(`V-${link}`, new Map([[link, quiet]]), boot);
      filter.observe(`V-${link}`, { claimedAt: boot + 1_000, doneAt: boot + 3_000, rests: true, held: false });
    }
    const out: number[] = [];
    for (let tick = 1; tick <= 60; tick++) {
      const now = boot + tick * TICK;
      let probes = 0;
      for (const link of links) {
        if (filter.canSkip(link, quiet, now).skip) continue;
        probes += 1;
        filter.enqueued(`V-${link}`, new Map([[link, quiet]]), now);
        filter.observe(`V-${link}`, { claimedAt: now + 1_000, doneAt: now + 3_000, rests: true, held: false });
      }
      out.push(probes);
    }
    return out;
  }

  it("over the hour after a takeover, real probes per tick ≤ ⌈N × tick / pass⌉, at N = 1,000 and N = 77", () => {
    for (const n of [1_000, 77]) {
      const bound = Math.ceil((n * TICK) / C7_REAL_PROBE_MS);
      const per = probesPerTick(n, true);
      expect(Math.max(...per), `N = ${n}: ${per.join(",")}`).toBeLessThanOrEqual(bound);
      // AND EVERY LINK WAS STILL PROBED within each half hour.
      expect(per.slice(0, 31).reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(n);
    }
  });

  it("without the stagger the whole fleet piles into one tick thirty minutes after the boot pass", () => {
    const per = probesPerTick(1_000, false);
    expect(Math.max(...per)).toBe(1_000);
  });

  it("spreads the boot pass by sha256 rank, evenly over the pass", () => {
    const filter = new LamportsFilter();
    const links = ["La", "Lb", "Lc", "Ld"];
    filter.planBootPass(links, 0);
    const byHash = [...links].sort((a, b) => (linkHash(a) < linkHash(b) ? -1 : 1));
    expect(byHash.map((link) => filter.bootPhase(link))).toEqual([0, C7_REAL_PROBE_MS / 4, C7_REAL_PROBE_MS / 2, (3 * C7_REAL_PROBE_MS) / 4]);
    // A READ AFTER THE BOOT PASS IS NOT STAGGERED.
    filter.enqueued("V", new Map([["La", print()]]), 1);
    filter.observe("V", { claimedAt: 2, doneAt: 3, rests: true, held: false });
    expect(filter.realProbeAt("La")).toBe(2);
  });
});
