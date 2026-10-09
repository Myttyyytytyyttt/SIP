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
  WALLET_CHANGE_FORGET_MS,
  afterRead,
  notified,
  pushReadDelayMs,
  resynced,
  showReadWanted,
  walletChangesOf,
  watchedAddresses,
  type PushReadInput,
} from "@/lib/live-push";
import { MEASURING_HIDE_VOLUME_MS } from "@/lib/live-pending";
import { MANUAL_FLOOR_MS, POLL_BASE_MS } from "@/lib/live-schedule";
import { VAULT, WALLET_A, liveSnapshot, tokenAccount } from "../../test/fixtures/live-dashboard";

const NOW = 1_789_500_000_000;
const quiet: PushReadInput = { dirty: { since: NOW, slot: 10 }, now: NOW, lastReadAt: NOW - 60_000, visible: true, reading: false, failures: 0, retryAt: null };

describe("what a push buys", () => {
  it("nothing, when nothing changed", () => {
    expect(pushReadDelayMs({ ...quiet, dirty: null })).toBeNull();
  });

  it("one read PUSH_DEBOUNCE_MS after the first change, so a settle and the wrap after it are one read", () => {
    expect(PUSH_DEBOUNCE_MS).toBe(1_500);
    expect(pushReadDelayMs(quiet)).toBe(PUSH_DEBOUNCE_MS);
    // A second change 1 s later rides along: the window does not move.
    const state = notified(notified(EMPTY_PUSH, { address: VAULT, slot: 10, now: NOW, wallet: false }), { address: "wsol", slot: 12, now: NOW + 1_000, wallet: false });
    expect(state.dirty).toEqual({ since: NOW, slot: 12 });
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
    expect(afterRead(rung, { slot: 99, historyRead: true, readAtMs: NOW }).dirty).toEqual({ since: NOW, slot: 100 });
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

  it("keeps the newest slot per wallet, and moves the clock to the read that covered a newer change", () => {
    const first = afterRead(rung, { slot: 100, historyRead: true, readAtMs: NOW });
    const again = notified(first, { address: WALLET_A, slot: 140, now: NOW + 20_000, wallet: true });
    // Until a read covers the newer one, the older stays drawn — no flicker.
    expect(walletChangesOf(again)).toEqual([{ wallet: WALLET_A, slot: 100, sinceMs: NOW }]);
    const covered = afterRead(again, { slot: 150, historyRead: true, readAtMs: NOW + 25_000 });
    expect(walletChangesOf(covered)).toEqual([{ wallet: WALLET_A, slot: 140, sinceMs: NOW + 25_000 }]);
  });

  it("the vault and its token accounts mark a change but are no wallet's activity", () => {
    const vault = notified(EMPTY_PUSH, { address: VAULT, slot: 100, now: NOW, wallet: false });
    expect(vault.dirty).not.toBeNull();
    expect(walletChangesOf(afterRead(vault, { slot: 100, historyRead: true, readAtMs: NOW }))).toEqual([]);
  });

  it("forgets a change no row would draw any more", () => {
    expect(WALLET_CHANGE_FORGET_MS).toBe(MEASURING_HIDE_VOLUME_MS);
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
