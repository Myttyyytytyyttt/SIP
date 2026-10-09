// What a notification from the chain buys (src/lib/live-push.ts): one read per
// burst, never sooner than the floor, never through a retry-after or a
// backoff, never while hidden — and a hidden tab that heard something reads
// as soon as it is looked at.

import { USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";
import { describe, expect, it } from "vitest";

import {
  EMPTY_PUSH,
  MAX_WATCHED,
  PUSH_DEBOUNCE_MS,
  PUSH_WALLET_FLOOR_MS,
  WALLET_CHANGE_FORGET_MS,
  afterRead,
  historyAhead,
  newestSlotOf,
  notified,
  pushReadDelayMs,
  recallPush,
  rememberPush,
  resynced,
  showReadWanted,
  walletChangesOf,
  watchedAddresses,
  type PushReadInput,
} from "@/lib/live-push";
import { MEASURING_HIDE_MS } from "@/lib/live-pending";
import { MANUAL_FLOOR_MS, POLL_BASE_MS } from "@/lib/live-schedule";
import { VAULT, WALLET_A, liveEntry, liveSnapshot, settledEvent, signature, tokenAccount } from "../../test/fixtures/live-dashboard";

const NOW = 1_789_500_000_000;
const quiet: PushReadInput = { dirty: { since: NOW, slot: 10, urgent: true }, now: NOW, lastReadAt: NOW - 60_000, visible: true, reading: false, failures: 0, retryAt: null };

describe("what a push buys", () => {
  it("nothing, when nothing changed", () => {
    expect(pushReadDelayMs({ ...quiet, dirty: null })).toBeNull();
  });

  it("one read PUSH_DEBOUNCE_MS after the first change, so a settle and the wrap after it are one read", () => {
    expect(PUSH_DEBOUNCE_MS).toBe(1_500);
    expect(pushReadDelayMs(quiet)).toBe(PUSH_DEBOUNCE_MS);
    // A second change 1 s later rides along: the window does not move.
    const state = notified(notified(EMPTY_PUSH, { address: VAULT, slot: 10, now: NOW, wallet: false }), { address: "wsol", slot: 12, now: NOW + 1_000, wallet: false });
    expect(state.dirty).toEqual({ since: NOW, slot: 12, urgent: true, vaultSlot: 12 });
    expect(pushReadDelayMs({ ...quiet, dirty: state.dirty, now: NOW + 1_000 })).toBe(500);
  });

  it("never sooner than MANUAL_FLOOR_MS after the previous read", () => {
    expect(pushReadDelayMs({ ...quiet, lastReadAt: NOW })).toBe(MANUAL_FLOOR_MS);
    expect(pushReadDelayMs({ ...quiet, lastReadAt: NOW - 4_000 })).toBe(MANUAL_FLOOR_MS - 4_000);
    expect(pushReadDelayMs({ ...quiet, lastReadAt: null })).toBe(PUSH_DEBOUNCE_MS);
  });

  it("never before a retry-after: the server's moment wins over the debounce and the floor", () => {
    expect(pushReadDelayMs({ ...quiet, retryAt: NOW + 45_000 })).toBe(45_000);
    expect(pushReadDelayMs({ ...quiet, lastReadAt: NOW, retryAt: NOW + 3_000 })).toBe(MANUAL_FLOOR_MS);
    // A moment already past adds nothing.
    expect(pushReadDelayMs({ ...quiet, retryAt: NOW - 1 })).toBe(PUSH_DEBOUNCE_MS);
  });

  it("nothing at all while the reads are backing off: the backoff's own read covers the change", () => {
    expect(pushReadDelayMs({ ...quiet, failures: 1 })).toBeNull();
  });

  it("nothing while a read is in flight (it re-arms this when it finishes), or while the tab is hidden", () => {
    expect(pushReadDelayMs({ ...quiet, reading: true })).toBeNull();
    expect(pushReadDelayMs({ ...quiet, visible: false })).toBeNull();
  });

  it("at most one read per MANUAL_FLOOR_MS however fast the chain changes: six a minute", () => {
    // The worst minute: the last read long ago, and a change every 100 ms from the first instant.
    let lastReadAt = NOW - POLL_BASE_MS;
    let reads = 0;
    let state = EMPTY_PUSH;
    for (let t = NOW; t < NOW + 60_000; t += 100) {
      state = notified(state, { address: VAULT, slot: t, now: t, wallet: false });
      const delay = pushReadDelayMs({ ...quiet, dirty: state.dirty, now: t, lastReadAt });
      if (delay === 0) {
        reads += 1;
        lastReadAt = t;
        state = afterRead(state, { slot: t, historyRead: true, readAtMs: t });
      }
    }
    expect(reads).toBe(60_000 / MANUAL_FLOOR_MS);
    expect(reads).toBe(6);
  });
});

/**
 * A BUSY TRADER (review 2026-10-09): a read costs at least five of the 60
 * tokens a minute one address gets, and a trading wallet rings every slot.
 */
describe("what a wallet that keeps trading buys", () => {
  it("its first change since the last saving is urgent — the manual floor — and the next ones wait PUSH_WALLET_FLOOR_MS", () => {
    expect(PUSH_WALLET_FLOOR_MS).toBe(30_000);
    const first = notified(EMPTY_PUSH, { address: WALLET_A, slot: 100, now: NOW, wallet: true });
    expect(first.dirty?.urgent).toBe(true);
    const covered = afterRead(first, { slot: 100, historyRead: true, readAtMs: NOW, ends: {} });
    const again = notified(covered, { address: WALLET_A, slot: 120, now: NOW + 2_000, wallet: true });
    expect(again.dirty?.urgent).toBe(false);
    expect(pushReadDelayMs({ ...quiet, dirty: again.dirty, now: NOW + 5_000, lastReadAt: NOW })).toBe(PUSH_WALLET_FLOOR_MS - 5_000);
    // The vault ringing makes it urgent again: that is the keeper's own step.
    const vault = notified(again, { address: VAULT, slot: 121, now: NOW + 6_000, wallet: false });
    expect(vault.dirty?.urgent).toBe(true);
    expect(pushReadDelayMs({ ...quiet, dirty: vault.dirty, now: NOW + 6_000, lastReadAt: NOW })).toBe(MANUAL_FLOOR_MS - 6_000);
  });

  it("a change after a saving ended the last one is urgent again", () => {
    const first = afterRead(notified(EMPTY_PUSH, { address: WALLET_A, slot: 100, now: NOW, wallet: true }), { slot: 100, historyRead: true, readAtMs: NOW, ends: {} });
    const ended = afterRead(first, { slot: 200, historyRead: true, readAtMs: NOW + 60_000, ends: { [WALLET_A]: 150 } });
    expect(notified(ended, { address: WALLET_A, slot: 210, now: NOW + 61_000, wallet: true }).dirty?.urgent).toBe(true);
  });

  it("a socket that came back owes a read, not an urgent one", () => {
    expect(resynced(EMPTY_PUSH, NOW).dirty?.urgent).toBe(false);
  });

  it("a wallet ringing every 400 ms for a minute buys two reads after the first, not six", () => {
    let state = afterRead(notified(EMPTY_PUSH, { address: WALLET_A, slot: 1, now: NOW, wallet: true }), { slot: 1, historyRead: true, readAtMs: NOW, ends: {} });
    let lastReadAt = NOW;
    let reads = 0;
    for (let t = NOW + 400; t <= NOW + 60_000; t += 400) {
      state = notified(state, { address: WALLET_A, slot: t, now: t, wallet: true });
      if (pushReadDelayMs({ ...quiet, dirty: state.dirty, now: t, lastReadAt }) === 0) {
        reads += 1;
        lastReadAt = t;
        state = afterRead(state, { slot: t, historyRead: true, readAtMs: t, ends: {} });
      }
    }
    expect(reads).toBe(60_000 / PUSH_WALLET_FLOOR_MS);
    expect(reads).toBe(2);
  });
});

describe("what outlives a remount", () => {
  it("the push and the last read's balances, per pension key", () => {
    expect(recallPush("pension-remount")).toEqual({ push: EMPTY_PUSH, baseline: null });
    const push = notified(EMPTY_PUSH, { address: WALLET_A, slot: 9, now: NOW, wallet: true });
    rememberPush("pension-remount", { push });
    rememberPush("pension-remount", { baseline: { slot: 8, wallets: { [WALLET_A]: { lamports: "1", nonce: "0" } } } });
    expect(recallPush("pension-remount")).toEqual({ push, baseline: { slot: 8, wallets: { [WALLET_A]: { lamports: "1", nonce: "0" } } } });
    expect(recallPush("another-pension")).toEqual({ push: EMPTY_PUSH, baseline: null });
  });
});

describe("coming back to the tab", () => {
  it("reads at once when the last read is MANUAL_FLOOR_MS old — not a whole sweep", () => {
    expect(showReadWanted({ lastReadAt: NOW, now: NOW + MANUAL_FLOOR_MS, failures: 0, retryAt: null })).toBe(true);
    expect(showReadWanted({ lastReadAt: NOW, now: NOW + MANUAL_FLOOR_MS - 1, failures: 0, retryAt: null })).toBe(false);
    expect(MANUAL_FLOOR_MS).toBeLessThan(POLL_BASE_MS);
    expect(showReadWanted({ lastReadAt: null, now: NOW, failures: 0, retryAt: null })).toBe(true);
  });

  it("does not ask before a retry-after, or through a backoff", () => {
    expect(showReadWanted({ lastReadAt: NOW - POLL_BASE_MS, now: NOW, failures: 0, retryAt: NOW + 1 })).toBe(false);
    expect(showReadWanted({ lastReadAt: NOW - POLL_BASE_MS, now: NOW, failures: 2, retryAt: null })).toBe(false);
  });

  it("reads what the socket heard while hidden as soon as it is visible, under the same floor", () => {
    const state = notified(EMPTY_PUSH, { address: WALLET_A, slot: 50, now: NOW, wallet: true });
    // Hidden: nothing. Visible 30 s later: due at once.
    expect(pushReadDelayMs({ ...quiet, dirty: state.dirty, visible: false })).toBeNull();
    expect(pushReadDelayMs({ ...quiet, dirty: state.dirty, now: NOW + 30_000, lastReadAt: NOW - 5_000 })).toBe(0);
    // Visible 2 s after a read: the floor still holds.
    expect(pushReadDelayMs({ ...quiet, dirty: state.dirty, now: NOW + 30_000, lastReadAt: NOW + 28_000 })).toBe(MANUAL_FLOOR_MS - 2_000);
  });
});

describe("what a read covers", () => {
  const rung = notified(EMPTY_PUSH, { address: WALLET_A, slot: 100, now: NOW, wallet: true });

  it("a read at or past the change's slot covers it; one from before leaves it standing", () => {
    expect(afterRead(rung, { slot: 99, historyRead: true, readAtMs: NOW }).dirty).toEqual({ since: NOW, slot: 100, urgent: true });
    expect(afterRead(rung, { slot: 100, historyRead: true, readAtMs: NOW }).dirty).toBeNull();
    // A snapshot that named no slot cannot be compared: covered, rather than read again and again.
    expect(afterRead(rung, { slot: null, historyRead: true, readAtMs: NOW }).dirty).toBeNull();
  });

  it("hands a wallet's change to the page only once the same read read the history, timed by the server's clock", () => {
    expect(walletChangesOf(rung)).toEqual([]);
    const noHistory = afterRead(rung, { slot: 120, historyRead: false, readAtMs: NOW + 2_000 });
    expect(walletChangesOf(noHistory)).toEqual([]);
    expect(noHistory.dirty).toBeNull();
    const read = afterRead(noHistory, { slot: 130, historyRead: true, readAtMs: NOW + 12_000 });
    expect(walletChangesOf(read)).toEqual([{ wallet: WALLET_A, slot: 100, sinceMs: NOW + 12_000 }]);
  });

  it("keeps the newest slot per wallet, and the clock of the first change for as long as nothing ended it", () => {
    const first = afterRead(rung, { slot: 100, historyRead: true, readAtMs: NOW });
    const again = notified(first, { address: WALLET_A, slot: 140, now: NOW + 20_000, wallet: true });
    // Until a read covers the newer one, the older stays drawn — no flicker.
    expect(walletChangesOf(again)).toEqual([{ wallet: WALLET_A, slot: 100, sinceMs: NOW }]);
    const covered = afterRead(again, { slot: 150, historyRead: true, readAtMs: NOW + 25_000 });
    expect(walletChangesOf(covered)).toEqual([{ wallet: WALLET_A, slot: 140, sinceMs: NOW }]);
  });

  it("starts a new clock once a saving or the frontier ended the last change, or once it is no longer drawn", () => {
    const first = afterRead(rung, { slot: 100, historyRead: true, readAtMs: NOW, ends: { [WALLET_A]: 50 } });
    expect(first.wallets[WALLET_A]!.covered).toEqual({ slot: 100, atMs: NOW, open: true });
    // Ended by a settlement at 120.
    const settled = afterRead(notified(first, { address: WALLET_A, slot: 140, now: NOW, wallet: true }), { slot: 150, historyRead: true, readAtMs: NOW + 60_000, ends: { [WALLET_A]: 120 } });
    expect(walletChangesOf(settled)).toEqual([{ wallet: WALLET_A, slot: 140, sinceMs: NOW + 60_000 }]);
    // A change the same read also ended is not open.
    const both = afterRead(notified(first, { address: WALLET_A, slot: 140, now: NOW, wallet: true }), { slot: 150, historyRead: true, readAtMs: NOW + 60_000, ends: { [WALLET_A]: 145 } });
    expect(both.wallets[WALLET_A]!.covered).toMatchObject({ slot: 140, open: false });
    // No longer drawn: a change past the horizon starts again.
    const late = afterRead(notified(first, { address: WALLET_A, slot: 140, now: NOW, wallet: true }), { slot: 150, historyRead: true, readAtMs: NOW + WALLET_CHANGE_FORGET_MS + 1 });
    expect(walletChangesOf(late)).toEqual([{ wallet: WALLET_A, slot: 140, sinceMs: NOW + WALLET_CHANGE_FORGET_MS + 1 }]);
  });

  it("the vault and its token accounts mark a change but are no wallet's activity", () => {
    const vault = notified(EMPTY_PUSH, { address: VAULT, slot: 100, now: NOW, wallet: false });
    expect(vault.dirty).not.toBeNull();
    expect(walletChangesOf(afterRead(vault, { slot: 100, historyRead: true, readAtMs: NOW }))).toEqual([]);
  });

  it("forgets a change no row would draw any more", () => {
    expect(WALLET_CHANGE_FORGET_MS).toBe(MEASURING_HIDE_MS);
    const covered = afterRead(rung, { slot: 100, historyRead: true, readAtMs: NOW });
    expect(walletChangesOf(afterRead(covered, { slot: 200, historyRead: true, readAtMs: NOW + WALLET_CHANGE_FORGET_MS }))).toHaveLength(1);
    expect(walletChangesOf(afterRead(covered, { slot: 200, historyRead: true, readAtMs: NOW + WALLET_CHANGE_FORGET_MS + 1 }))).toEqual([]);
  });

  it("a socket that came back owes one read, covered by any answer", () => {
    const state = resynced(EMPTY_PUSH, NOW);
    expect(pushReadDelayMs({ ...quiet, dirty: state.dirty })).toBe(PUSH_DEBOUNCE_MS);
    expect(afterRead(state, { slot: 1, historyRead: false, readAtMs: NOW }).dirty).toBeNull();
    // And it does not move a change already waiting.
    expect(resynced(rung, NOW + 5).dirty).toEqual(rung.dirty);
  });
});

describe("what one dashboard watches", () => {
  it("each wallet linked to THIS vault, the vault, and its USDC and wSOL accounts — nothing else", () => {
    const snapshot = liveSnapshot({
      wallets: [
        { wallet: WALLET_A, lamports: "1", link: { address: "la", status: "this_vault", vault: VAULT, epoch: "1", settlementNonce: "0", frontierSlot: "0" } },
        { wallet: "Elsewhere", lamports: "1", link: { address: "lb", status: "other_vault", vault: "Other", epoch: "1", settlementNonce: "0", frontierSlot: "0" } },
        { wallet: "Unlinked", lamports: "1", link: { address: "lc", status: "missing", vault: null, epoch: null, settlementNonce: null, frontierSlot: null } },
      ],
      links: { status: "exists", items: [{ wallet: "Discovered", address: "ld", epoch: "1", settlementNonce: "0", frontierSlot: "0" }] },
    });
    expect(watchedAddresses(snapshot)).toEqual(["Discovered", WALLET_A, VAULT, `${USDC_MINT}-ata`, `${WSOL_MINT}-ata`].sort());
  });

  it("nothing before there is a vault, or a snapshot", () => {
    expect(watchedAddresses(null)).toEqual([]);
    const base = liveSnapshot();
    expect(watchedAddresses(liveSnapshot({ vault: { ...base.vault, status: "missing" } }))).toEqual([]);
  });

  it("at most MAX_WATCHED addresses", () => {
    const wallets = Array.from({ length: 20 }, (_, index) => ({
      wallet: `W${String(index).padStart(2, "0")}`,
      lamports: "1",
      link: { address: `l${index}`, status: "this_vault" as const, vault: VAULT, epoch: "1", settlementNonce: "0", frontierSlot: "0" },
    }));
    const watched = watchedAddresses(liveSnapshot({ wallets, vaultTokenAccounts: { status: "exists", items: [tokenAccount(USDC_MINT, "0", "0", 6), tokenAccount(WSOL_MINT, "0", "0", 9)] } }));
    expect(MAX_WATCHED).toBe(13);
    expect(watched).toHaveLength(MAX_WATCHED);
    expect(watched).toContain(VAULT);
  });
});

/**
 * A VAULT CHANGE GETS ITS DEBOUNCE (diagnosis 10-09, push D4). It arrived
 * while a busy wallet's change was waiting out the 30 s floor and inherited
 * that change's `since`: no debounce at all, a read possibly 0.2 s after the
 * confirmation, before the wrap that follows a settle.
 */
describe("a change that turns urgent", () => {
  it("opens the window again, so the vault's change waits PUSH_DEBOUNCE_MS like any first change", () => {
    const covered = afterRead(notified(EMPTY_PUSH, { address: WALLET_A, slot: 100, now: NOW, wallet: true }), { slot: 100, historyRead: true, readAtMs: NOW, ends: {} });
    const busy = notified(covered, { address: WALLET_A, slot: 120, now: NOW + 2_000, wallet: true });
    expect(busy.dirty).toMatchObject({ since: NOW + 2_000, urgent: false });
    const vault = notified(busy, { address: VAULT, slot: 121, now: NOW + 40_000, wallet: false });
    expect(vault.dirty).toMatchObject({ since: NOW + 40_000, urgent: true, vaultSlot: 121 });
    // Long after the last read: the debounce, not zero.
    expect(pushReadDelayMs({ ...quiet, dirty: vault.dirty, now: NOW + 40_000, lastReadAt: NOW - 60_000 })).toBe(PUSH_DEBOUNCE_MS);
  });

  it("keeps the window of a change that was urgent already: a chain that keeps ringing does not postpone its read", () => {
    const first = notified(EMPTY_PUSH, { address: VAULT, slot: 10, now: NOW, wallet: false });
    const second = notified(first, { address: WALLET_A, slot: 11, now: NOW + 1_000, wallet: true });
    expect(second.dirty?.since).toBe(NOW);
  });
});

/**
 * A VAULT'S CHANGE IS COVERED ONLY ONCE THE HISTORY SHOWS IT (diagnosis 10-09,
 * push D4): the snapshot and the history come from separate calls, maybe
 * separate nodes, and a read that took the new balance with a page that had
 * not indexed the settle left the settled row to the next sweep.
 */
describe("what a read covers of the vault's own changes", () => {
  const rung = notified(EMPTY_PUSH, { address: VAULT, slot: 500, now: NOW, wallet: false });

  it("is covered by a read whose history reaches the change's slot", () => {
    expect(afterRead(rung, { slot: 500, historyRead: true, readAtMs: NOW, historySlot: 500 }).dirty).toBeNull();
    expect(afterRead(rung, { slot: 510, historyRead: true, readAtMs: NOW, historySlot: 505 }).dirty).toBeNull();
  });

  it("stays for ONE follow-up read after the floor when the history has not reached it", () => {
    const behind = afterRead(rung, { slot: 500, historyRead: true, readAtMs: NOW, historySlot: 499 });
    expect(behind.dirty).toMatchObject({ slot: 500, vaultSlot: 500, urgent: true, followUp: true });
    // Read again after the manual floor, not a sweep.
    expect(pushReadDelayMs({ ...quiet, dirty: behind.dirty, now: NOW + 1_000, lastReadAt: NOW + 1_000 })).toBe(MANUAL_FLOOR_MS);
    // The follow-up is covered by any answer at or past the slot, whatever its history says.
    expect(afterRead(behind, { slot: 500, historyRead: true, readAtMs: NOW + 12_000, historySlot: 499 }).dirty).toBeNull();
    expect(afterRead(behind, { slot: 500, historyRead: false, readAtMs: NOW + 12_000 }).dirty).toBeNull();
  });

  it("a read with no history, or none held, owes the follow-up too", () => {
    expect(afterRead(rung, { slot: 500, historyRead: false, readAtMs: NOW, historySlot: 900 }).dirty?.followUp).toBe(true);
    expect(afterRead(rung, { slot: 500, historyRead: true, readAtMs: NOW, historySlot: null }).dirty?.followUp).toBe(true);
    expect(afterRead(rung, { slot: 500, historyRead: true, readAtMs: NOW }).dirty?.followUp).toBe(true);
  });

  it("a snapshot from before the change still leaves it standing, follow-up or not", () => {
    expect(afterRead(rung, { slot: 499, historyRead: true, readAtMs: NOW, historySlot: 600 }).dirty).toEqual(rung.dirty);
  });

  it("a newer vault change while the follow-up waits owes a follow-up of its own; a wallet's does not reset it", () => {
    const behind = afterRead(rung, { slot: 500, historyRead: true, readAtMs: NOW, historySlot: 1 });
    const wallet = notified(behind, { address: WALLET_A, slot: 520, now: NOW + 1_000, wallet: true });
    expect(wallet.dirty).toMatchObject({ vaultSlot: 500, followUp: true, slot: 520 });
    const newer = notified(behind, { address: VAULT, slot: 530, now: NOW + 1_000, wallet: false });
    expect(newer.dirty).toMatchObject({ vaultSlot: 530, slot: 530 });
    expect(newer.dirty?.followUp).toBeUndefined();
  });

  it("only wallets rang: the history is not asked for (their rule is walletChangesOf's)", () => {
    const wallet = notified(EMPTY_PUSH, { address: WALLET_A, slot: 500, now: NOW, wallet: true });
    expect(wallet.dirty?.vaultSlot).toBeUndefined();
    expect(afterRead(wallet, { slot: 500, historyRead: true, readAtMs: NOW, historySlot: 1 }).dirty).toBeNull();
  });

  it("a socket that came back still owes one read, covered by any answer", () => {
    expect(afterRead(resynced(EMPTY_PUSH, NOW), { slot: 1, historyRead: false, readAtMs: NOW }).dirty).toBeNull();
  });

  it("the follow-up buys at most one extra read per vault change: a busy minute is still six", () => {
    let lastReadAt = NOW - POLL_BASE_MS;
    let reads = 0;
    let state = EMPTY_PUSH;
    for (let t = NOW; t < NOW + 60_000; t += 100) {
      state = notified(state, { address: VAULT, slot: t, now: t, wallet: false });
      if (pushReadDelayMs({ ...quiet, dirty: state.dirty, now: t, lastReadAt }) === 0) {
        reads += 1;
        lastReadAt = t;
        // A history that never catches up.
        state = afterRead(state, { slot: t, historyRead: true, readAtMs: t, historySlot: 0 });
      }
    }
    expect(reads).toBe(6);
  });
});

/**
 * A HISTORY AHEAD OF ITS SNAPSHOT (diagnosis 10-09, inventory D4): a saving
 * newer than the snapshot drew "+$0.43" in the feed beside a Saved so far and
 * a Pending without it, until a second read at least 10 s later.
 */
describe("whether the history is ahead of the snapshot", () => {
  const settled = (slot: number, ok = true) => ({ ...liveEntry(signature(slot % 200), 1, [settledEvent("3911799")], slot), ok });

  it("is, for a saving past the snapshot's slot", () => {
    expect(historyAhead([settled(4_243)], 4_242)).toBe(true);
  });

  it("is not, for one at or before it, or one that failed on chain", () => {
    expect(historyAhead([settled(4_242)], 4_242)).toBe(false);
    expect(historyAhead([settled(4_100)], 4_242)).toBe(false);
    expect(historyAhead([settled(4_300, false)], 4_242)).toBe(false);
  });

  it("is, for a wrap, a conversion or a buy past it — they move the figures too — and not for upkeep or a rule", () => {
    expect(historyAhead([liveEntry("c", 1, [{ kind: "converted", lamportsSpent: "1", usdcReceivedRaw: "1" } as never], 4_300)], 4_242)).toBe(true);
    expect(historyAhead([liveEntry("i", 1, [{ kind: "invested", mint: null, symbol: null, usdcSpentRaw: "1", receivedRaw: "1", receivedUi: null } as never], 4_300)], 4_242)).toBe(true);
    expect(historyAhead([liveEntry("u", 1, [{ kind: "upkeep" } as never], 4_300)], 4_242)).toBe(false);
    expect(historyAhead([liveEntry("r", 1, [{ kind: "rule_changed", mode: 1, skimBps: null, volumeBps: 200, paused: false, maxContribution: null, walletReserve: null } as never], 4_300)], 4_242)).toBe(false);
  });

  it("cannot be, against a snapshot that named no slot", () => {
    expect(historyAhead([settled(4_300)], null)).toBe(false);
  });

  it("the newest slot of a history is its highest, and none for an empty one", () => {
    expect(newestSlotOf([settled(10), settled(30), settled(20)])).toBe(30);
    expect(newestSlotOf([])).toBeNull();
  });
});
