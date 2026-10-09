// THE WALLETS SCREENS FOLLOW THE CHAIN (diagnosis 10-09, inventory D2): the
// Manage wallets modal showed the vault as it was when the page mounted. What
// counts as the vault moving, how often it may be read again, and the one read
// a floor keeps instead of losing — src/lib/vault-follow.ts.

import { USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";
import { describe, expect, it } from "vitest";

import { MANUAL_FLOOR_MS, POLL_BASE_MS } from "@/lib/live-schedule";
import {
  VAULT_FOLLOW_FLOOR_MS,
  VAULT_OPEN_FLOOR_MS,
  VAULT_POLL_MS,
  createFloorGate,
  vaultMoved,
  vaultPollDelayMs,
  vaultStampOf,
} from "@/lib/vault-follow";
import { PRICES, liveSnapshot, policyState, tokenAccount } from "../../test/fixtures/live-dashboard";

const base = liveSnapshot();
const stamp = vaultStampOf(base);
const withTokens = (wsol: string, usdc: string) =>
  liveSnapshot({ vaultTokenAccounts: { status: "exists", items: [tokenAccount(WSOL_MINT, wsol, "0", 9), tokenAccount(USDC_MINT, usdc, "0", 6)] } });

describe("what counts as the vault moving between two live reads", () => {
  it("nothing, for the same chain state read again — prices and the slot move on every read and are no part of it", () => {
    const again = liveSnapshot({ slot: 9_999, readAtMs: 1, prices: { ...PRICES!, usdcRawPerSol: "1" } });
    expect(vaultMoved(stamp, vaultStampOf(again))).toBe(false);
  });

  it("a saving: the vault's lamports", () => {
    expect(vaultMoved(stamp, vaultStampOf(liveSnapshot({ vault: { ...base.vault, lamports: "205197039" } })))).toBe(true);
  });

  it("the vault account itself: a rule changed, a counter moved", () => {
    expect(vaultMoved(stamp, vaultStampOf(liveSnapshot({ vault: { ...base.vault, state: { ...base.vault.state!, paused: true } } })))).toBe(true);
  });

  it("a conversion or a buy: a token amount", () => {
    expect(vaultMoved(vaultStampOf(withTokens("10", "0")), vaultStampOf(withTokens("0", "4150000")))).toBe(true);
    expect(vaultMoved(vaultStampOf(withTokens("10", "0")), vaultStampOf(withTokens("10", "0")))).toBe(false);
  });

  it("the investment policy: signed, changed or taken away", () => {
    expect(vaultMoved(stamp, vaultStampOf(liveSnapshot({ policy: { ...base.policy, state: policyState({ enabled: false }) } })))).toBe(true);
    expect(vaultMoved(stamp, vaultStampOf(liveSnapshot({ policy: { status: "missing", address: "p" } })))).toBe(true);
  });

  it("never from nothing: the first read, or a pension with no vault, has nothing to compare", () => {
    expect(vaultMoved(null, stamp)).toBe(false);
    expect(vaultMoved(stamp, null)).toBe(false);
    expect(vaultStampOf(null)).toBeNull();
    expect(vaultStampOf(liveSnapshot({ vault: { ...base.vault, status: "missing" } }))).toBeNull();
  });

  it("never from a part one read could not read: a flaky token listing must not buy a vault read every half minute", () => {
    const unread = liveSnapshot({ vaultTokenAccounts: { status: "unreadable", items: [] } });
    expect(vaultMoved(stamp, vaultStampOf(unread))).toBe(false);
    expect(vaultMoved(vaultStampOf(unread), stamp)).toBe(false);
    const policyUnread = liveSnapshot({ policy: { status: "unreadable", address: "p" } });
    expect(vaultMoved(stamp, vaultStampOf(policyUnread))).toBe(false);
    const oneUnread = liveSnapshot({
      vaultTokenAccounts: { status: "exists", items: [{ ...tokenAccount(WSOL_MINT, "0", "0", 9), status: "unreadable", amountRaw: null }] },
    });
    expect(vaultMoved(stamp, vaultStampOf(oneUnread))).toBe(false);
  });

  it("a token account that appeared is a move: the vault's first conversion creates its USDC account", () => {
    const before = liveSnapshot({
      vaultTokenAccounts: { status: "exists", items: [{ ...tokenAccount(USDC_MINT, "0", "0", 6), status: "missing", amountRaw: null }] },
    });
    expect(vaultMoved(vaultStampOf(before), vaultStampOf(withTokens("0", "4150000")))).toBe(true);
  });
});

describe("how often the vault screen reads", () => {
  it("/wallets polls at the keeper's sweep, counted from the last answer", () => {
    expect(VAULT_POLL_MS).toBe(POLL_BASE_MS);
    expect(vaultPollDelayMs({ answeredAt: 1_000, now: 1_000 })).toBe(VAULT_POLL_MS);
    expect(vaultPollDelayMs({ answeredAt: 1_000, now: 41_000 })).toBe(20_000);
    expect(vaultPollDelayMs({ answeredAt: 1_000, now: 1_000 + 2 * VAULT_POLL_MS })).toBe(0);
    expect(vaultPollDelayMs({ answeredAt: null, now: 5 })).toBe(VAULT_POLL_MS);
  });

  it("a read the live store prompts at most twice a minute — 24 of /api/solana-vault's 60 client tokens at 12 a read — and an opened modal at the manual floor", () => {
    expect(VAULT_FOLLOW_FLOOR_MS).toBe(30_000);
    expect((60_000 / VAULT_FOLLOW_FLOOR_MS) * 12).toBeLessThanOrEqual(60 / 2);
    expect(VAULT_OPEN_FLOOR_MS).toBe(MANUAL_FLOOR_MS);
  });
});

function gateHarness() {
  const clock = { now: 1_000_000 };
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  let runs = 0;
  const gate = createFloorGate({
    run: () => {
      runs += 1;
      gate.started();
    },
    now: () => clock.now,
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
  });
  const armed = () => timers.filter((timer) => !timer.cleared).map((timer) => timer.ms);
  const fire = () => {
    const timer = timers.find((entry) => !entry.cleared);
    if (timer === undefined) throw new Error("no timer armed");
    timer.cleared = true;
    timer.run();
  };
  return { gate, clock, armed, fire, runs: () => runs };
}

describe("one read under a floor, never lost", () => {
  it("reads at once when nothing was read yet, or the last read began a floor ago", () => {
    const h = gateHarness();
    h.gate.ask(VAULT_FOLLOW_FLOOR_MS);
    expect(h.runs()).toBe(1);
    h.clock.now += VAULT_FOLLOW_FLOOR_MS;
    h.gate.ask(VAULT_FOLLOW_FLOOR_MS);
    expect(h.runs()).toBe(2);
  });

  it("inside the floor, keeps ONE read for the moment it ends, however many ask", () => {
    const h = gateHarness();
    h.gate.started();
    h.clock.now += 5_000;
    for (let ask = 0; ask < 4; ask += 1) h.gate.ask(VAULT_FOLLOW_FLOOR_MS);
    expect(h.runs()).toBe(0);
    expect(h.armed()).toEqual([VAULT_FOLLOW_FLOOR_MS - 5_000]);
    h.fire();
    expect(h.runs()).toBe(1);
    expect(h.armed()).toEqual([]);
  });

  it("keeps the earliest moment asked for: the modal opening does not wait out the live store's floor", () => {
    const h = gateHarness();
    h.gate.started();
    h.clock.now += 2_000;
    h.gate.ask(VAULT_FOLLOW_FLOOR_MS);
    h.gate.ask(VAULT_OPEN_FLOOR_MS);
    expect(h.armed()).toEqual([VAULT_OPEN_FLOOR_MS - 2_000]);
    h.gate.ask(VAULT_FOLLOW_FLOOR_MS);
    expect(h.armed()).toEqual([VAULT_OPEN_FLOOR_MS - 2_000]);
  });

  it("a read that begins by another path — a write's refresh — covers what was asked, and the kept one is dropped", () => {
    const h = gateHarness();
    h.gate.started();
    h.clock.now += 1_000;
    h.gate.ask(VAULT_FOLLOW_FLOOR_MS);
    expect(h.armed()).toHaveLength(1);
    h.gate.started();
    expect(h.armed()).toEqual([]);
    // And the floor counts from that read.
    h.clock.now += 1_000;
    h.gate.ask(VAULT_OPEN_FLOOR_MS);
    expect(h.armed()).toEqual([VAULT_OPEN_FLOOR_MS - 1_000]);
  });

  it("drops the kept read on dispose: a new key, or the screen leaving", () => {
    const h = gateHarness();
    h.gate.started();
    h.gate.ask(VAULT_OPEN_FLOOR_MS);
    h.gate.dispose();
    expect(h.armed()).toEqual([]);
    expect(h.runs()).toBe(0);
  });
});
