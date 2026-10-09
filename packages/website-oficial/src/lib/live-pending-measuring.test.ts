// A trading wallet the push saw change, and no saving for it yet (owner,
// 2026-10-09: "hago una trade y si vuelvo a saverfi no veo nada en processing").
// Through the REAL model: a snapshot, a page of history and the push's changes
// put through toLiveDashboard, never a hand-written view.

import { describe, expect, it } from "vitest";

import { formatSolAtMost } from "@/lib/amounts";
import { PENDING_COPY } from "@/lib/live-copy";
import { toLiveDashboard } from "@/lib/live-model";
import {
  MEASURING_HIDE_MS,
  MEASURING_STALL_MS,
  VOLUME_MAX_WAIT_MS,
  VOLUME_MIN_OWED_LAMPORTS,
  anyActive,
  nextInvestmentOf,
  pendingLines,
  pendingSteps,
} from "@/lib/live-pending";
import { EMPTY_PUSH, afterRead, baselineOf, heardLate, movedSince, notified, walletChangesOf, walletEnds, type PushState } from "@/lib/live-push";
import { pendingPollWanted } from "@/lib/live-schedule";
import type { LiveDashboard, LiveEntryJson, LiveSnapshotJson, LiveWalletChange } from "@/lib/live-types";
import { NOW_MS, WALLET_A, liveActivity, liveEntry, liveSnapshot, seconds, settledEvent, signature } from "../../test/fixtures/live-dashboard";
import { DEFAULT_SWEEP_MS } from "../../../solana-keeper/src/config";
import { VOLUME_MAX_WAIT_SECONDS, VOLUME_MIN_OWED_LAMPORTS as KEEPER_VOLUME_MIN_OWED } from "../../../solana-keeper/src/volume-base";

/** The link's frontier in the fixture's snapshot. */
const FRONTIER = 999;
/** A slot past the frontier: the trade nobody has measured yet. */
const TRADE_SLOT = 5_000;

interface Setup {
  readonly changes?: readonly LiveWalletChange[];
  readonly entries?: readonly LiveEntryJson[];
  readonly linkEntries?: readonly LiveEntryJson[];
  readonly frontier?: string | null;
  readonly linkStatus?: "this_vault" | "other_vault" | "missing";
  readonly mode?: 0 | 1;
  readonly paused?: boolean;
  readonly protocolPaused?: boolean;
  readonly policy?: "missing";
  /** The server's clock at this read, ms after the change was first covered. */
  readonly after?: number;
  /** The trading wallet's balance; the fixture's 0.42 SOL when absent. */
  readonly lamports?: string | null;
}

/** A change first covered at NOW_MS; the dashboard read `after` ms later. */
const change = (slot = TRADE_SLOT, wallet = WALLET_A): LiveWalletChange => ({ wallet, slot, sinceMs: NOW_MS });

function dashboard(setup: Setup = {}): LiveDashboard {
  const base = liveSnapshot();
  const link = base.wallets[0]!.link;
  const snapshot: LiveSnapshotJson = liveSnapshot({
    slot: 6_000,
    readAtMs: NOW_MS + (setup.after ?? 0),
    vault: { ...base.vault, state: { ...base.vault.state!, skimMode: setup.mode ?? 0, paused: setup.paused ?? false } },
    config: { ...base.config, paused: setup.protocolPaused ?? false },
    ...(setup.policy === "missing" ? { policy: { status: "missing", address: base.policy.address } } : {}),
    wallets: [
      {
        wallet: WALLET_A,
        lamports: setup.lamports === undefined ? "420000000" : setup.lamports,
        link: { ...link, status: setup.linkStatus ?? "this_vault", frontierSlot: setup.frontier === undefined ? String(FRONTIER) : setup.frontier },
      },
    ],
  });
  return toLiveDashboard({
    snapshot,
    activity: liveActivity(setup.entries ?? []),
    ...(setup.linkEntries === undefined ? {} : { linkEntries: setup.linkEntries }),
    privyWallets: [WALLET_A],
    walletChanges: setup.changes ?? [change()],
  });
}

/** The fixture's snapshot as dashboard() builds it, with the link's frontier at FRONTIER. */
const baseSnapshot = (): LiveSnapshotJson => {
  const base = liveSnapshot();
  return { ...base, wallets: [{ ...base.wallets[0]!, link: { ...base.wallets[0]!.link, frontierSlot: String(FRONTIER) } }] };
};

const measuring = (data: LiveDashboard) => pendingSteps(data).filter((step) => step.kind === "measuring");
const settleAt = (slot: number, wallet = WALLET_A, ok = true): LiveEntryJson => ({
  ...liveEntry(signature(slot % 200), seconds(NOW_MS), [{ ...settledEvent("20000000"), wallet } as never], slot),
  ok,
});

describe("a trading wallet that changed past its frontier", () => {
  it("is being checked, with a loader, named as the page names the wallet", () => {
    const data = dashboard();
    const steps = measuring(data);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "measuring", state: "active", rest: null, since: NOW_MS, mode: 0 });
    const label = data.wallets[0]!.label;
    expect(steps[0]!.wallet).toEqual({ address: WALLET_A, label });
    expect(pendingLines(steps)[0]).toMatchObject({ key: `measuring:${WALLET_A}`, active: true, title: PENDING_COPY.measuring(label), sub: PENDING_COPY.measuringSub.profit });
  });

  it("comes before the keeper's own steps: trades are measured before anything is converted", () => {
    const data = dashboard({ entries: [liveEntry(signature(3), seconds(NOW_MS - 60_000), [{ kind: "wrapped", lamports: "18000000" } as never])] });
    expect(pendingSteps(data).map((step) => step.kind)).toEqual(["measuring", "converting", "buying"]);
  });

  it("is nothing once the frontier has reached the change's slot: the keeper measured it", () => {
    expect(measuring(dashboard({ frontier: String(TRADE_SLOT) }))).toEqual([]);
    expect(measuring(dashboard({ frontier: String(TRADE_SLOT - 1) }))).toHaveLength(1);
    // A link whose frontier was not read is no evidence either way: the history decides.
    expect(measuring(dashboard({ frontier: null }))).toHaveLength(1);
  });

  it("is nothing when a settlement of that wallet landed at or after the change: the keeper's own settle changes the wallet too", () => {
    expect(measuring(dashboard({ entries: [settleAt(TRADE_SLOT)] }))).toEqual([]);
    expect(measuring(dashboard({ entries: [settleAt(TRADE_SLOT + 7)] }))).toEqual([]);
    // From a wallet's link stream as well as from the vault's page.
    expect(measuring(dashboard({ linkEntries: [settleAt(TRADE_SLOT)] }))).toEqual([]);
  });

  it("is still being checked over an OLDER settlement, another wallet's, or one that failed", () => {
    expect(measuring(dashboard({ entries: [settleAt(TRADE_SLOT - 1)] }))).toHaveLength(1);
    expect(measuring(dashboard({ entries: [settleAt(TRADE_SLOT, "AnotherWa11et")] }))).toHaveLength(1);
    expect(measuring(dashboard({ entries: [settleAt(TRADE_SLOT, WALLET_A, false)] }))).toHaveLength(1);
  });

  it("leads with the wallet's name, so a title cut short on a phone still says which wallet", () => {
    for (const title of [PENDING_COPY.measuring("Trading wallet 1"), PENDING_COPY.measuringWaiting("Imported wallet 2")]) {
      expect(title).toMatch(/^(Trading wallet 1|Imported wallet 2): /);
    }
  });

  it("says 'activity', never 'trade': a transfer into the wallet changes it too", () => {
    const line = pendingLines(measuring(dashboard()))[0]!;
    expect(line.title).toMatch(/latest activity/);
    expect(line.title).not.toMatch(/trade/i);
  });

  it("does not need an investment policy: settling does not", () => {
    expect(measuring(dashboard({ policy: "missing" }))).toHaveLength(1);
  });

  it("adds nothing to Next investment", () => {
    expect(nextInvestmentOf(pendingSteps(dashboard()))).toEqual(nextInvestmentOf(pendingSteps(dashboard({ changes: [] }))));
  });
});

describe("nothing while no saving can follow", () => {
  it("the vault paused, or the protocol: settle.rs refuses either", () => {
    expect(measuring(dashboard({ paused: true }))).toEqual([]);
    expect(measuring(dashboard({ protocolPaused: true }))).toEqual([]);
  });

  it("a wallet whose link is not this vault's", () => {
    expect(measuring(dashboard({ linkStatus: "other_vault" }))).toEqual([]);
    expect(measuring(dashboard({ linkStatus: "missing" }))).toEqual([]);
  });

  it("a change the push never handed over", () => {
    expect(measuring(dashboard({ changes: [] }))).toEqual([]);
  });

  it("a wallet holding no more than its rent floor and reserve: settle.rs refuses to pay out of it", () => {
    // Moving the SOL out is itself the change that rang.
    const empty = dashboard({ lamports: "0" });
    expect(empty.wallets[0]!.canSettle).toBe(false);
    expect(measuring(empty)).toEqual([]);
    // Exactly floor + reserve is already too little; one lamport over is enough.
    expect(measuring(dashboard({ lamports: String(890_880 + 50_000_000) }))).toEqual([]);
    expect(measuring(dashboard({ lamports: String(890_880 + 50_000_000 + 1) }))).toHaveLength(1);
    // A balance nobody could read is no evidence either way.
    expect(dashboard({ lamports: null }).wallets[0]!.canSettle).toBeNull();
    expect(measuring(dashboard({ lamports: null }))).toHaveLength(1);
  });
});

/**
 * A CHANGE NOBODY HEARD (review 2026-10-09): the socket was not listening when
 * the trade happened — the page was on /wallets, or a phone dropped the
 * backgrounded socket. The next read compares the wallet's balance with the
 * last read's.
 */
describe("a trade made while the socket was not listening", () => {
  const read = (slot: number, lamports: string, nonce = "3"): LiveSnapshotJson => {
    const base = baseSnapshot();
    return liveSnapshot({ ...base, slot, readAtMs: NOW_MS, wallets: [{ ...base.wallets[0]!, lamports, link: { ...base.wallets[0]!.link, settlementNonce: nonce } }] });
  };
  const after = (before: LiveSnapshotJson, now: LiveSnapshotJson, entries: readonly LiveEntryJson[] = [], push: PushState = EMPTY_PUSH): LiveDashboard => {
    const state = afterRead(heardLate(push, movedSince(baselineOf(before), now)), { slot: now.slot, historyRead: true, readAtMs: now.readAtMs, ends: walletEnds(now, entries) });
    return toLiveDashboard({ snapshot: now, activity: liveActivity(entries), privyWallets: [WALLET_A], walletChanges: walletChangesOf(state) });
  };

  it("is still being checked when the balance moved since the last read, at the earliest slot it could have", () => {
    const steps = measuring(after(read(4_000, "420000000"), read(6_000, "395000000")));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ state: "active", since: NOW_MS });
    expect(movedSince(baselineOf(read(4_000, "1")), read(6_000, "2"))).toEqual([{ wallet: WALLET_A, slot: 4_001 }]);
  });

  it("is nothing when the balance did not move, or there is no earlier read (a fresh tab starts from this one)", () => {
    expect(measuring(after(read(4_000, "420000000"), read(6_000, "420000000")))).toEqual([]);
    expect(movedSince(null, read(6_000, "395000000"))).toEqual([]);
  });

  it("is nothing when a settlement explains it: the link's count moved, or a settlement row lands after the last read", () => {
    expect(measuring(after(read(4_000, "420000000", "3"), read(6_000, "395000000", "4")))).toEqual([]);
    expect(measuring(after(read(4_000, "420000000"), read(6_000, "395000000"), [settleAt(4_001)]))).toEqual([]);
  });

  it("does not move a change the socket already named at a newer slot", () => {
    const heard = notified(EMPTY_PUSH, { address: WALLET_A, slot: 5_500, now: NOW_MS, wallet: true });
    const state = heardLate(heard, movedSince(baselineOf(read(4_000, "1")), read(6_000, "2")));
    expect(state.wallets[WALLET_A]!.pendingSlot).toBe(5_500);
  });
});

describe("a loader that stops claiming progress", () => {
  it("runs for MEASURING_STALL_MS — two of the keeper's sweeps — after a read first saw the change, then rests quietly, without a loader", () => {
    // The keeper decides within about a sweep; a span with no profit sends nothing, so nothing on chain would end the step.
    expect(MEASURING_STALL_MS).toBe(2 * DEFAULT_SWEEP_MS);
    expect(measuring(dashboard({ after: MEASURING_STALL_MS }))[0]).toMatchObject({ state: "active" });
    const late = measuring(dashboard({ after: MEASURING_STALL_MS + 1 }));
    expect(late[0]).toMatchObject({ state: "waiting", rest: "slow" });
    expect(anyActive(late)).toBe(false);
    const label = dashboard().wallets[0]!.label;
    expect(pendingLines(late)[0]).toMatchObject({ active: false, title: PENDING_COPY.measuringWaiting(label), sub: PENDING_COPY.measuringRest.profit });
  });

  it("leaves the page after MEASURING_HIDE_MS, on a volume vault too: a plain transfer owes nothing, and an hour's line would say otherwise", () => {
    expect(MEASURING_HIDE_MS).toBe(15 * 60_000);
    expect(measuring(dashboard({ after: MEASURING_HIDE_MS }))).toHaveLength(1);
    expect(measuring(dashboard({ after: MEASURING_HIDE_MS + 1 }))).toEqual([]);
    expect(measuring(dashboard({ mode: 1, after: MEASURING_HIDE_MS }))[0]).toMatchObject({ state: "waiting", rest: "slow" });
    expect(measuring(dashboard({ mode: 1, after: MEASURING_HIDE_MS + 1 }))).toEqual([]);
    expect(MEASURING_HIDE_MS).toBeLessThan(VOLUME_MAX_WAIT_MS);
  });

  it("a wallet that keeps trading does not keep the loader turning: later trades move the slot, not the clock", () => {
    // Review 2026-10-09: every covering read restarted the clock, so a bot trading every few seconds kept the spinner for as long as it ran.
    let push: PushState = EMPTY_PUSH;
    let data = dashboard({ changes: [] });
    for (let t = 0; t <= 6 * 60_000; t += 10_000) {
      push = notified(push, { address: WALLET_A, slot: TRADE_SLOT + t, now: NOW_MS + t, wallet: true });
      const snapshot = liveSnapshot({ ...baseSnapshot(), slot: TRADE_SLOT + t + 5, readAtMs: NOW_MS + t + 2_000 });
      push = afterRead(push, { slot: snapshot.slot, historyRead: true, readAtMs: snapshot.readAtMs, ends: walletEnds(snapshot, []) });
      data = toLiveDashboard({ snapshot, activity: liveActivity([]), privyWallets: [WALLET_A], walletChanges: walletChangesOf(push) });
    }
    const steps = measuring(data);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ state: "waiting", rest: "slow", since: NOW_MS + 2_000 });
    expect(anyActive(steps)).toBe(false);
  });

  it("a saving ends the stretch: the next trade after it starts a clock of its own", () => {
    let push = afterRead(notified(EMPTY_PUSH, { address: WALLET_A, slot: TRADE_SLOT, now: NOW_MS, wallet: true }), {
      slot: TRADE_SLOT + 1,
      historyRead: true,
      readAtMs: NOW_MS,
      ends: { [WALLET_A]: FRONTIER },
    });
    const settled = [settleAt(TRADE_SLOT + 50)];
    push = notified(push, { address: WALLET_A, slot: TRADE_SLOT + 100, now: NOW_MS + 180_000, wallet: true });
    push = afterRead(push, { slot: TRADE_SLOT + 101, historyRead: true, readAtMs: NOW_MS + 181_000, ends: { [WALLET_A]: TRADE_SLOT + 50 } });
    const data = dashboard({ changes: walletChangesOf(push), entries: settled, after: 181_000 });
    expect(measuring(data)[0]).toMatchObject({ state: "active", since: NOW_MS + 181_000 });
  });

  it("while active, asks for the faster cadence like any step under way (a fallback for a missed push)", () => {
    const steps = pendingSteps(dashboard());
    expect(anyActive(steps)).toBe(true);
    expect(pendingPollWanted({ active: anyActive(steps), activeSince: NOW_MS, now: NOW_MS, activityRetryAt: null })).toBe(true);
  });
});

describe("the words, by mode", () => {
  it("PROFIT: a saving follows only if the trades since the last one made a profit", () => {
    expect(pendingLines(measuring(dashboard({ mode: 0 })))[0]!.sub).toBe(PENDING_COPY.measuringSub.profit);
    expect(PENDING_COPY.measuringSub.profit).toMatch(/only if your trades since the last one made a profit/);
  });

  it("VOLUME: a saving follows once 0.001 SOL is owed, or an hour after the oldest unsaved trade — the volume keeper's own numbers", () => {
    expect(pendingLines(measuring(dashboard({ mode: 1 })))[0]!.sub).toBe(PENDING_COPY.measuringSub.volume);
    expect(VOLUME_MIN_OWED_LAMPORTS).toBe(KEEPER_VOLUME_MIN_OWED);
    expect(VOLUME_MAX_WAIT_MS).toBe(VOLUME_MAX_WAIT_SECONDS * 1_000);
    const owed = `${formatSolAtMost(VOLUME_MIN_OWED_LAMPORTS, 4)} SOL`;
    expect(PENDING_COPY.measuringSub.volume).toContain(owed);
    expect(PENDING_COPY.measuringRest.volume).toContain(owed);
    expect(PENDING_COPY.measuringSub.volume).toMatch(/an hour/);
  });

  it("never names the keeper, a slot or a frontier", () => {
    for (const text of [...Object.values(PENDING_COPY.measuringSub), ...Object.values(PENDING_COPY.measuringRest), PENDING_COPY.measuring("W"), PENDING_COPY.measuringWaiting("W")]) {
      expect(text).not.toMatch(/keeper|slot|frontier|lamport/i);
    }
  });
});
