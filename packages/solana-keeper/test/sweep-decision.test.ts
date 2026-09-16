// The sweep's own decisions, pinned where bin/keeper.mts cannot be reached: what
// a failed batched vault read raises, and when it stops being weather.

import { describe, expect, it } from "vitest";
import { INVEST_FAILED_CRITICAL_STREAK, investFailedStreak, wrapShortStreak, type WrapReport } from "../src/invest-decision.js";
import type { InvestOutcome } from "../src/invest-tick.js";
import type { CarryBook, LossCarry } from "../src/settle-decision.js";
import {
  VAULT_READ_ALERT_KEY,
  VAULT_READ_CRITICAL_STREAK,
  createCarryWatch,
  foldInvestTurn,
  vaultReadAlert,
  type VaultInvestSweep,
} from "../src/sweep-decision.js";

describe("the batched vault read's alert", () => {
  it("warns while it could be weather and pages critical from the third sweep in a row", () => {
    expect(vaultReadAlert(1, "429 Too Many Requests")).toMatchObject({ key: VAULT_READ_ALERT_KEY, severity: "warn" });
    expect(vaultReadAlert(VAULT_READ_CRITICAL_STREAK - 1, "429 Too Many Requests").severity).toBe("warn");
    expect(vaultReadAlert(VAULT_READ_CRITICAL_STREAK, "429 Too Many Requests").severity).toBe("critical");
    expect(vaultReadAlert(9, "429 Too Many Requests").severity).toBe("critical");
  });

  it("raises the escalation under the SAME key, so the keeper can clear the standing warning first", () => {
    // The alerter dedupes by key alone with a 30-minute repeat window, so a
    // critical under a new key would be a second condition and one under this
    // key, left standing, would be swallowed. keeper.mts clears it at the streak.
    expect(vaultReadAlert(1, "x").key).toBe(vaultReadAlert(VAULT_READ_CRITICAL_STREAK, "x").key);
  });

  it("names no vault and no wallet: the batch is one request for every link", () => {
    expect(VAULT_READ_ALERT_KEY).not.toContain(":");
  });

  it("counts the sweeps and carries the upstream summary it was given", () => {
    expect(vaultReadAlert(1, "429 Too Many Requests").detail).toBe("1 sweep in a row: 429 Too Many Requests");
    expect(vaultReadAlert(3, "429 Too Many Requests").detail).toBe("3 sweeps in a row: 429 Too Many Requests");
    expect(vaultReadAlert(3, "429 Too Many Requests").context).toEqual({ sweeps: 3 });
  });
});

describe("a vault's invest turns folded across one sweep", () => {
  type Turn = { readonly outcome: InvestOutcome; readonly detail: string; readonly wrap?: WrapReport };
  const wrap = (short: boolean): WrapReport => ({
    free: 9_000_000n,
    allowance: short ? 1_000_000n : 9_000_000n,
    wrapped: short ? 1_000_000n : 9_000_000n,
    short,
  });
  /** Three links on one vault settle in one sweep: three turns, one fold. */
  const fold = (...turns: readonly Turn[]): VaultInvestSweep =>
    turns.reduce<VaultInvestSweep | undefined>((carry, turn) => foldInvestTurn(carry, turn), undefined)!;

  it("advances a vault's failed streak ONCE for the sweep, however many wallets are linked to it", () => {
    const folded = fold({ outcome: "FAILED", detail: "leg 1" }, { outcome: "FAILED", detail: "leg 1" }, { outcome: "FAILED", detail: "leg 1" });
    expect(investFailedStreak(0, folded.outcome)).toBe(1);
    expect(investFailedStreak(1, folded.outcome)).toBe(2);
    // THE DEFECT, in one line: counted per turn, the same three links reached the
    // critical streak — "three sweeps in a row" — inside a single sweep.
    const perTurn = (["FAILED", "FAILED", "FAILED"] as const).reduce((streak, outcome) => investFailedStreak(streak, outcome), 0);
    expect(perTurn).toBe(INVEST_FAILED_CRITICAL_STREAK);
  });

  it("lets one FAILED turn decide the sweep, and keeps the first failure's words", () => {
    expect(fold({ outcome: "INVESTED", detail: "bought" }, { outcome: "FAILED", detail: "leg 2 broke" }, { outcome: "IDLE", detail: "nothing" })).toMatchObject({
      outcome: "FAILED",
      detail: "leg 2 broke",
    });
    expect(fold({ outcome: "FAILED", detail: "first" }, { outcome: "FAILED", detail: "second" }).detail).toBe("first");
  });

  it("holds the streak on REFUSED only while nothing else happened, in either order", () => {
    // REFUSED neither advances the run nor ends it: it has its own alert.
    expect(investFailedStreak(2, fold({ outcome: "REFUSED", detail: "a" }, { outcome: "REFUSED", detail: "b" }).outcome)).toBe(2);
    // A resting turn in the same sweep ends it, and must not be masked by a REFUSED sibling.
    expect(investFailedStreak(2, fold({ outcome: "REFUSED", detail: "a" }, { outcome: "IDLE", detail: "b" }).outcome)).toBe(0);
    expect(investFailedStreak(2, fold({ outcome: "IDLE", detail: "b" }, { outcome: "REFUSED", detail: "a" }).outcome)).toBe(0);
    expect(investFailedStreak(2, fold({ outcome: "REFUSED", detail: "a" }, { outcome: "INVESTED", detail: "b" }).outcome)).toBe(0);
  });

  it("keeps a short turn's wrap report whatever the later turns saw, and the latest one when none was short", () => {
    expect(fold({ outcome: "INVESTED", detail: "a", wrap: wrap(true) }, { outcome: "INVESTED", detail: "b", wrap: wrap(false) }).wrap?.short).toBe(true);
    expect(fold({ outcome: "INVESTED", detail: "a", wrap: wrap(false) }, { outcome: "INVESTED", detail: "b", wrap: wrap(true) }).wrap?.short).toBe(true);
    // A turn that read no wrap at all does not blank out one that did.
    expect(fold({ outcome: "INVESTED", detail: "a", wrap: wrap(false) }, { outcome: "IDLE", detail: "b" }).wrap?.short).toBe(false);
    expect(fold({ outcome: "IDLE", detail: "a" }, { outcome: "IDLE", detail: "b" }).wrap).toBeUndefined();
  });

  it("advances the wrap-short streak once per sweep too", () => {
    const short = { outcome: "INVESTED", detail: "wrapped a slice", wrap: wrap(true) } as const;
    expect(wrapShortStreak(0, fold(short, short, short).wrap?.short === true)).toBe(1);
    expect(wrapShortStreak(2, fold(short, { outcome: "IDLE", detail: "nothing to wrap", wrap: wrap(false) }).wrap?.short === true)).toBe(3);
  });
});

describe("the pending carries /status shows", () => {
  const LINK = "Link1111111111111111111111111111111111111111";
  const OTHER = "Link2222222222222222222222222222222222222222";
  const WALLET = "Wa11et11111111111111111111111111111111111111";
  // The book's own key shape: `epoch:settlementNonce:frontierSlot`. The watch
  // never parses it — it is shown so an operator can match it to a link.
  const STATE = "300000000:8:300000900";
  const carry = (lossLamports: bigint, walletSignedTxCount = 30): LossCarry => ({ lossLamports, walletSignedTxCount });
  const book = (...links: readonly (readonly [string, string, LossCarry])[]): CarryBook =>
    links.reduce<CarryBook>((acc, [link, state, value]) => {
      const entries = acc.get(link) ?? new Map<string, LossCarry>();
      entries.set(state, value);
      return acc.set(link, entries);
    }, new Map());

  const wallets = (pairs: Record<string, string>) => (link: string): string | null => pairs[link] ?? null;

  it("names the wallet, the loss and when the wait started", () => {
    const watch = createCarryWatch();
    const at = Date.parse("2026-09-16T00:00:00.000Z");
    expect(watch.observe(book([LINK, STATE, carry(500_000_000n)]), wallets({ [LINK]: WALLET }), at)).toEqual([
      {
        wallet: WALLET,
        link: LINK,
        state: STATE,
        lossLamports: 500_000_000n,
        walletSignedTxCount: 30,
        since: "2026-09-16T00:00:00.000Z",
      },
    ]);
  });

  it("keeps the wait when a settle that did not land re-records the same carry every sweep", () => {
    const watch = createCarryWatch();
    const first = Date.parse("2026-09-16T00:00:00.000Z");
    watch.observe(book([LINK, STATE, carry(500_000_000n)]), wallets({ [LINK]: WALLET }), first);
    // recordCarry writes a FRESH object under the same key each sweep; the wait
    // is the loss's, not the object's, so it must not restart.
    const later = watch.observe(book([LINK, STATE, carry(500_000_000n)]), wallets({ [LINK]: WALLET }), first + 10 * 60_000);
    expect(later[0]!.since).toBe("2026-09-16T00:00:00.000Z");
  });

  it("shows the longest wait first", () => {
    const watch = createCarryWatch();
    const at = Date.parse("2026-09-16T00:00:00.000Z");
    watch.observe(book([LINK, STATE, carry(1n)]), wallets({}), at);
    const both = watch.observe(book([LINK, STATE, carry(1n)], [OTHER, STATE, carry(2n)]), wallets({}), at + 60_000);
    expect(both.map((pending) => pending.link)).toEqual([LINK, OTHER]);
  });

  it("forgets the wait of a carry the book no longer holds, so a returning one waits anew", () => {
    const watch = createCarryWatch();
    const at = Date.parse("2026-09-16T00:00:00.000Z");
    watch.observe(book([LINK, STATE, carry(1n)]), wallets({}), at);
    expect(watch.observe(new Map(), wallets({}), at + 60_000)).toEqual([]);
    const returned = watch.observe(book([LINK, STATE, carry(1n)]), wallets({}), at + 120_000);
    expect(returned[0]!.since).toBe(new Date(at + 120_000).toISOString());
  });

  it("names a null wallet for a link this sweep no longer discovered, rather than hiding the loss", () => {
    const watch = createCarryWatch();
    const [pending] = watch.observe(book([LINK, STATE, carry(7n)]), wallets({}), Date.now());
    expect(pending).toMatchObject({ wallet: null, link: LINK, lossLamports: 7n });
  });

  it("NEVER touches the book: a poll must not forget a loss the way carryFor prunes one", () => {
    const watch = createCarryWatch();
    // Two states under one link, one of them stale — exactly what carryFor deletes.
    const held = book([LINK, STATE, carry(5n)], [LINK, "300000000:7:300000500", carry(6n)]);
    const before = [...held].map(([link, entries]) => [link, [...entries]] as const);
    watch.observe(held, wallets({ [LINK]: WALLET }), Date.now());
    watch.observe(held, wallets({ [LINK]: WALLET }), Date.now() + 60_000);
    expect([...held].map(([link, entries]) => [link, [...entries]] as const)).toEqual(before);
    expect(held.get(LINK)!.size).toBe(2);
  });
});
