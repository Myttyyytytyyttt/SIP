// The scheduler's selection (src/scheduler-select.ts) IS the legacy doorbell's
// (src/doorbell.ts), ported from one process's memory to vault_work rows.
//
// THE CLAIM UNDER TEST IS AN EQUALITY, tick by tick, over random histories: the
// legacy Doorbell and the DueSelector are fed the same discovery, the same
// deliveries at the same times, the same pauses, watched sets and full-pass
// requests, and the same turns — the Doorbell through ingest() and
// recordTurn(), the selector through the rows a receiver and a job would leave
// (bell_at, rests, claimed_at). Then:
//   * the VAULTS each turns are the same set, every tick, and so is whether the
//     tick is a full pass;
//   * for a vault with ONE link (two of today's three) the lane is the same;
//   * for a vault with several links — whose job turns them all — the port's
//     lane is never LESS urgent than the most urgent legacy lane of its links.
// A failing history names its seed.

import { describe, expect, it } from "vitest";
import { LANE_PRIORITY } from "../src/dispatch-store.js";
import { BELL_ANSWER_MARGIN_MS, Doorbell, HOLD_MS, SAFETY_MIN_PER_SWEEP, SAFETY_PASS_MS, type DoorLink, type Lane } from "../src/doorbell.js";
import { DueSelector, moreUrgent, type SelectLane, type SelectLink, type SelectTrust, type VaultBellState } from "../src/scheduler-select.js";
import { rng } from "./settle-world.js";

const TICK = 60_000;
const TRUSTED: SelectTrust = { enabled: true, trusted: true, reason: null };

/** A delivery naming `addresses`, shaped as Helius RAW (a signature and a slot): it rings and counts as heard. */
function delivery(addresses: readonly string[], n: number): unknown {
  return [{ slot: 1_000 + n, blockTime: null, transaction: { signatures: [`sig-${n}`], message: { accountKeys: [...addresses] } } }];
}

interface World {
  readonly links: SelectLink[];
  readonly vaultRows: Map<string, { bellAt: number | null; rests: boolean | null; claimedAt: number | null }>;
}

/**
 * One history, both ways. `multi`: vaults of 1–3 links, each turned whole; else one link a vault.
 * Returns how many ticks were compared, and how many were full passes and selections.
 */
function runHistory(
  seed: number,
  multi: boolean,
  ticks = 90,
): { compared: number; full: number; selections: number; bells: number; lanes: Record<SelectLane, number> } {
  const random = rng(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const legacy = new Doorbell(true);
  const port = new DueSelector();
  let serial = 0;
  let vaultSerial = 0;
  const world: World = { links: [], vaultRows: new Map() };
  const addVault = (): void => {
    vaultSerial += 1;
    const vault = `V${String(vaultSerial).padStart(4, "0")}`;
    const count = multi ? 1 + Math.floor(random() * 3) : 1;
    for (let i = 0; i < count; i++) {
      serial += 1;
      // LINK ADDRESSES ARE NOT IN VAULT ORDER: the slice rotates over links, as in production.
      world.links.push({ link: `L${(serial * 7919) % 100_003}`.padEnd(8, "x"), wallet: `W${serial}`, vault });
    }
  };
  for (let i = 0; i < (multi ? 25 : 40); i++) addVault();
  let now = 10_000_000;
  let paused = false;
  let watched: Set<string> | null = null;
  let compared = 0;
  let full = 0;
  let selections = 0;
  let bells = 0;
  let deliveries = 0;
  const lanesSeen: Record<SelectLane, number> = { bell: 0, busy: 0, new: 0, full: 0, safety: 0 };

  /**
   * Rings IN TIME ORDER, as both receivers do: the legacy one at ingest, the
   * fleet's at its write's clock_timestamp(). A ring earlier than one already
   * made is not a thing either side can see.
   */
  let lastRingAt = Number.NEGATIVE_INFINITY;
  const ring = (address: string, at: number): void => {
    if (at <= lastRingAt) throw new Error(`the history rang at ${at} after ${lastRingAt}: out of order`);
    lastRingAt = at;
    const known = new Set(world.links.flatMap((l) => [l.wallet, l.vault]));
    legacy.ingest(delivery([address], (deliveries += 1)), known, at);
    // THE RECEIVER: the address's vault, through the live links; bell_at is the write's time.
    for (const vault of new Set(world.links.filter((l) => l.wallet === address || l.vault === address).map((l) => l.vault))) {
      const row = world.vaultRows.get(vault) ?? { bellAt: null, rests: null, claimedAt: null };
      world.vaultRows.set(vault, { ...row, bellAt: at });
    }
    bells += 1;
  };

  for (let tick = 0; tick < ticks; tick++) {
    // ── between two selects: deliveries, discovery changes, pauses, the webhook ──
    const ringCount = random() < 0.5 ? Math.floor(random() * 4) : 0;
    const from = Math.max(lastRingAt + 1, now - TICK);
    const times = Array.from({ length: ringCount }, () => from + Math.floor(random() * (now - from))).sort((a, b) => a - b);
    for (const at of new Set(times)) {
      if (world.links.length === 0) break;
      const link = pick(world.links);
      ring(random() < 0.6 ? link.wallet : link.vault, at);
    }
    if (random() < 0.08) addVault();
    if (random() < 0.06 && world.links.length > 4) {
      // A VAULT GOES WHOLE (every link of it unlinked), and never comes back under its name.
      const gone = pick(world.links).vault;
      for (let i = world.links.length - 1; i >= 0; i--) if (world.links[i]!.vault === gone) world.links.splice(i, 1);
    }
    if (random() < 0.05) paused = !paused;
    if (random() < 0.04) {
      legacy.requestFullPass("a test's request");
      port.requestFullPass("a test's request");
    }
    if (random() < 0.07) {
      const all = world.links.flatMap((l) => [l.wallet, l.vault]);
      watched = random() < 0.3 ? null : new Set(all.filter(() => random() < 0.9));
      legacy.setWatched(watched, [], now);
    }

    // ── the select, both ways ──
    const doorLinks: (DoorLink & SelectLink)[] = world.links.map((l) => ({ ...l }));
    const legacyTrust = legacy.trust(now);
    const trust: SelectTrust = { enabled: true, trusted: legacyTrust.trusted, reason: legacyTrust.reason };
    const rows = new Map<string, VaultBellState>(world.vaultRows);
    const legacySel = legacy.select({ links: doorLinks, now, sweepMs: TICK, protocolPaused: paused, live: true });
    const portSel = port.select({ links: world.links, vaults: rows, now, tickMs: TICK, protocolPaused: paused, trust, watched });

    const legacyLanes = new Map<string, Lane[]>();
    for (const turn of legacySel.turns) legacyLanes.set(turn.link.vault, [...(legacyLanes.get(turn.link.vault) ?? []), turn.lane]);
    const where = `seed ${seed}, tick ${tick}`;
    expect(portSel.fullReason === null, `${where}: full pass or not`).toBe(legacySel.fullReason === null);
    expect([...portSel.vaults.keys()].sort(), `${where}: the vaults turned`).toEqual([...legacyLanes.keys()].sort());
    for (const [vault, lanes] of legacyLanes) {
      const linksOfVault = world.links.filter((l) => l.vault === vault).length;
      const legacyBest = lanes.reduce((best, lane) => moreUrgent(best, lane as SelectLane), lanes[0] as SelectLane);
      const portLane = portSel.vaults.get(vault)!;
      if (linksOfVault === 1) expect(portLane, `${where}: vault ${vault}'s lane`).toBe(legacyBest);
      else expect(LANE_PRIORITY[portLane], `${where}: vault ${vault} no less urgent`).toBeLessThanOrEqual(LANE_PRIORITY[legacyBest]);
    }
    for (const lane of portSel.vaults.values()) lanesSeen[lane] += 1;
    compared += 1;
    if (legacySel.fullReason !== null) full += 1;
    else selections += 1;

    // ── the turns: every link of every turned vault (a vault job), at the same start ──
    const startedAt = now + 1_000 + Math.floor(random() * 4_000);
    const lateRing = random() < 0.15;
    let lateAt = startedAt + 100;
    for (const vault of portSel.vaults.keys()) {
      const vaultLinks = world.links.filter((l) => l.vault === vault);
      // A BELL DURING THE TURN, sometimes: rung after it started, before it ended.
      if (lateRing && random() < 0.3) ring(pick(vaultLinks).wallet, (lateAt += 10));
      let allRest = true;
      for (const link of vaultLinks) {
        const rests = random() < 0.75;
        allRest &&= rests;
        const lane = legacySel.turns.find((t) => t.link.link === link.link)?.lane ?? "full";
        legacy.recordTurn(link, lane, rests, startedAt + 2_000, rests ? "IDLE" : "RETRY", startedAt);
      }
      const row = world.vaultRows.get(vault) ?? { bellAt: null, rests: null, claimedAt: null };
      world.vaultRows.set(vault, { ...row, rests: allRest, claimedAt: startedAt });
    }
    // THE INTERVAL: usually a tick, sometimes an overrun (a skipped tick) or a bell's hold.
    const r = random();
    now += r < 0.8 ? TICK : r < 0.9 ? TICK * 2 + 7_000 : HOLD_MS + BELL_ANSWER_MARGIN_MS;
  }
  return { compared, full, selections, bells, lanes: lanesSeen };
}

describe("the scheduler's selection equals the legacy doorbell's choice on the same inputs", () => {
  it("one link a vault: the same vaults, the same lanes, every tick of 60 random histories", () => {
    let selections = 0;
    let full = 0;
    const lanes: Record<SelectLane, number> = { bell: 0, busy: 0, new: 0, full: 0, safety: 0 };
    for (let seed = 1; seed <= 60; seed++) {
      const run = runHistory(seed, false);
      selections += run.selections;
      full += run.full;
      for (const lane of Object.keys(lanes) as SelectLane[]) lanes[lane] += run.lanes[lane];
    }
    // BOTH KINDS OF TICK, AND EVERY LANE, WERE EXERCISED, or the equality says little.
    expect(selections).toBeGreaterThan(1_000);
    expect(full).toBeGreaterThan(100);
    for (const lane of Object.keys(lanes) as SelectLane[]) expect(lanes[lane], lane).toBeGreaterThan(100);
  });

  it("several links a vault, turned whole: the same vaults every tick, and never a less urgent lane", () => {
    let selections = 0;
    for (let seed = 101; seed <= 160; seed++) selections += runHistory(seed, true).selections;
    expect(selections).toBeGreaterThan(1_000);
  });

  it("sizes the slice from the REAL interval, as the legacy doorbell does: an overrunning tick takes a bigger slice", () => {
    const legacy = new Doorbell(true);
    const port = new DueSelector();
    const links: SelectLink[] = Array.from({ length: 6_000 }, (_, i) => ({ link: `L${String(i).padStart(5, "0")}`, wallet: `W${i}`, vault: `V${i}` }));
    const known = new Set(links.flatMap((l) => [l.wallet, l.vault]));
    legacy.ingest(delivery(["nobody"], 1), known, 1);
    const rows = new Map<string, VaultBellState>(links.map((l) => [l.vault, { bellAt: null, rests: true, claimedAt: 1 }]));
    for (const link of links) legacy.recordTurn(link, "full", true, 2, "IDLE", 1);
    const sizes: number[] = [];
    for (const now of [10 * TICK, 11 * TICK, 15 * TICK, 16 * TICK]) {
      const legacySel = legacy.select({ links, now, sweepMs: TICK, protocolPaused: false, live: true });
      const portSel = port.select({ links, vaults: rows, now, tickMs: TICK, protocolPaused: false, trust: TRUSTED, watched: null });
      expect([...portSel.vaults.keys()].sort()).toEqual(legacySel.turns.map((t) => t.link.vault).sort());
      sizes.push(portSel.vaults.size);
    }
    // The boot pass, a tick's 200, a FOUR-tick gap's 800, a tick's 200 again.
    expect(sizes).toEqual([6_000, 200, 800, 200]);
  });

  it("a fleet larger than the safety floor rotates exactly as the legacy slice does", () => {
    // 120 single-link vaults, everything resting and trusted: only the slice turns.
    const legacy = new Doorbell(true);
    const port = new DueSelector();
    const links: SelectLink[] = Array.from({ length: 120 }, (_, i) => ({ link: `L${String(i).padStart(3, "0")}`, wallet: `W${i}`, vault: `V${i}` }));
    const known = new Set(links.flatMap((l) => [l.wallet, l.vault]));
    let now = 1_000_000;
    legacy.ingest(delivery(["nobody"], 1), known, now - 1);
    const rows = new Map<string, VaultBellState>();
    for (let tick = 0; tick < 12; tick++) {
      const legacySel = legacy.select({ links, now, sweepMs: TICK, protocolPaused: false, live: true });
      const portSel = port.select({ links, vaults: rows, now, tickMs: TICK, protocolPaused: false, trust: TRUSTED, watched: null });
      expect([...portSel.vaults.keys()].sort()).toEqual(legacySel.turns.map((t) => t.link.vault).sort());
      if (tick >= 2) {
        expect(portSel.vaults.size).toBe(SAFETY_MIN_PER_SWEEP);
        expect(portSel.safetySlice).toBe(SAFETY_MIN_PER_SWEEP);
      }
      for (const link of links) {
        legacy.recordTurn(link, "safety", true, now + 2_000, "IDLE", now + 1_000);
        rows.set(link.vault, { bellAt: null, rests: true, claimedAt: now + 1_000 });
      }
      now += TICK;
    }
  });
});

describe("the selection's own rules", () => {
  const one: SelectLink = { link: "L1", wallet: "W1", vault: "V1" };
  const resting = (claimedAt: number, bellAt: number | null = null): Map<string, VaultBellState> =>
    new Map([["V1", { bellAt, rests: true, claimedAt }]]);

  it("starts with a full pass, and a takeover starts another", () => {
    const selector = new DueSelector();
    const first = selector.select({ links: [one], vaults: new Map(), now: 0, tickMs: TICK, protocolPaused: false, trust: TRUSTED, watched: null });
    expect(first.fullReason).toMatch(/took the lock/);
    expect(first.vaults.get("V1")).toBe("full");
    const second = selector.select({ links: [one], vaults: resting(1_000), now: TICK, tickMs: TICK, protocolPaused: false, trust: TRUSTED, watched: null });
    expect(second.fullReason).toBeNull();
    selector.takeover();
    const third = selector.select({ links: [one], vaults: resting(1_000), now: 2 * TICK, tickMs: TICK, protocolPaused: false, trust: TRUSTED, watched: null });
    expect(third.fullReason).toMatch(/just took the lock/);
  });

  it("is a full pass every tick while the doorbell is off or not trusted, with the reason it was given", () => {
    const selector = new DueSelector();
    for (let tick = 0; tick < 3; tick++) {
      const sel = selector.select({
        links: [one],
        vaults: resting(1_000),
        now: tick * TICK,
        tickMs: TICK,
        protocolPaused: false,
        trust: { enabled: false, trusted: false, reason: "the webhook is the legacy keeper's" },
        watched: null,
      });
      // THE LEGACY ORDER: a doorbell that is off says so before anything else, the first tick included.
      expect(sel.fullReason).toBe("the webhook is the legacy keeper's");
    }
  });

  it("keeps a bell until a resting job claimed the margin after it rang has answered it, and the hold has passed", () => {
    const selector = new DueSelector();
    // Past the first full pass, link already known.
    selector.select({ links: [one], vaults: new Map(), now: 0, tickMs: TICK, protocolPaused: false, trust: TRUSTED, watched: null });
    const rang = 100_000;
    // A JOB CLAIMED TOO SOON AFTER THE BELL rests and answers nothing: still a bell after the hold.
    const tooSoon = resting(rang + BELL_ANSWER_MARGIN_MS - 1, rang);
    const late = rang + HOLD_MS + 60_000;
    expect(selector.select({ links: [one], vaults: tooSoon, now: late, tickMs: TICK, protocolPaused: false, trust: TRUSTED, watched: null }).vaults.get("V1")).toBe("bell");
    // ANSWERED: inside the hold still a bell, past it gone.
    const answered = resting(rang + BELL_ANSWER_MARGIN_MS, rang);
    expect(selector.select({ links: [one], vaults: answered, now: rang + HOLD_MS, tickMs: TICK, protocolPaused: false, trust: TRUSTED, watched: null }).vaults.get("V1")).toBe("bell");
    const after = selector.select({ links: [one], vaults: answered, now: rang + HOLD_MS + 1, tickMs: TICK, protocolPaused: false, trust: TRUSTED, watched: null });
    expect(after.vaults.has("V1")).toBe(true); // the safety floor still turns a fleet of one
    expect(after.vaults.get("V1")).toBe("safety");
    // AND STAYS ANSWERED when a later job does not rest: the vault is busy, not rung again.
    const busyLater = new Map<string, VaultBellState>([["V1", { bellAt: rang, rests: false, claimedAt: rang + 200_000 }]]);
    expect(selector.select({ links: [one], vaults: busyLater, now: rang + HOLD_MS + TICK, tickMs: TICK, protocolPaused: false, trust: TRUSTED, watched: null }).vaults.get("V1")).toBe("busy");
    // A NEW BELL is a new bell, unanswered.
    const rangAgain = new Map<string, VaultBellState>([["V1", { bellAt: rang + 500_000, rests: true, claimedAt: rang + 200_000 }]]);
    expect(selector.select({ links: [one], vaults: rangAgain, now: rang + 900_000, tickMs: TICK, protocolPaused: false, trust: TRUSTED, watched: null }).vaults.get("V1")).toBe("bell");
  });

  it("turns everyone when the protocol is unpaused, and the first requested reason is the one kept", () => {
    const selector = new DueSelector();
    selector.select({ links: [one], vaults: new Map(), now: 0, tickMs: TICK, protocolPaused: true, trust: TRUSTED, watched: null });
    const unpaused = selector.select({ links: [one], vaults: resting(1_000), now: TICK, tickMs: TICK, protocolPaused: false, trust: TRUSTED, watched: null });
    expect(unpaused.fullReason).toBe("the protocol was unpaused");
    selector.requestFullPass("first");
    selector.requestFullPass("second");
    expect(selector.fullPassPending).toBe("first");
  });

  it("holds every link as new while the managed webhook watches none of it", () => {
    const selector = new DueSelector();
    selector.select({ links: [one], vaults: new Map(), now: 0, tickMs: TICK, protocolPaused: false, trust: TRUSTED, watched: new Set() });
    const sel = selector.select({ links: [one], vaults: resting(1_000), now: TICK, tickMs: TICK, protocolPaused: false, trust: TRUSTED, watched: new Set() });
    expect(sel.vaults.get("V1")).toBe("new");
  });

  it("slices by the governor's pass: a longer pass turns fewer quiet links a tick, never fewer than the floor", () => {
    const links: SelectLink[] = Array.from({ length: 6_000 }, (_, i) => ({ link: `L${String(i).padStart(5, "0")}`, wallet: `W${i}`, vault: `V${i}` }));
    const rows = new Map<string, VaultBellState>(links.map((l) => [l.vault, { bellAt: null, rests: true, claimedAt: 1 }]));
    const sizes: number[] = [];
    for (const passMs of [SAFETY_PASS_MS, 2 * SAFETY_PASS_MS, 4 * SAFETY_PASS_MS]) {
      const selector = new DueSelector();
      selector.select({ links, vaults: rows, now: 0, tickMs: TICK, passMs, protocolPaused: false, trust: TRUSTED, watched: null });
      sizes.push(selector.select({ links, vaults: rows, now: TICK, tickMs: TICK, passMs, protocolPaused: false, trust: TRUSTED, watched: null }).safetySlice);
    }
    expect(sizes).toEqual([200, 100, 50]);
  });
});
