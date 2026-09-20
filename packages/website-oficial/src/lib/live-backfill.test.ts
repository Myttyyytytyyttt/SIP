// A PAGE OF SIGNATURES IS NOT A PAGE OF SETTLEMENTS.
//
// 2026-09-19, mainnet: twelve of the vault's fifteen newest signatures were
// keeper upkeep, so the one real settlement — 0.0366 SOL at 00:50:21Z — sat at
// position 24 and no page the dashboard loaded held it. The screen then said
// "SETTLEMENTS 1 — 0 in loaded history", "LAST SETTLEMENT none yet" and "The
// chart starts with your first settlement", over a pension that had settled
// nineteen hours earlier, while "saved so far" (which reads state, not history)
// stayed right.
//
// This is the first half of the answer: when the state says a settlement
// happened and the loaded page holds none, page back for it — bounded, once,
// and never against a manual "Load older". The second half is that nothing is
// claimed which the state contradicts, whatever the paging finds
// (live-model.test.ts, and settlement-not-in-history.test.ts on the screen).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { appendOlder, mergeHead } from "@/lib/live-activity-store";
import { BACKFILL_PAGES, BACKFILL_ROUNDS, backfillSettlements, chainSaysSettled, holdsSettlement, shouldBackfill } from "@/lib/live-backfill";
import { toLiveDashboard } from "@/lib/live-model";
import type { LiveActivityJson, LiveEntryJson, LiveSnapshotJson, VaultEventJson } from "@/lib/live-types";
import type { ApiResult } from "@/lib/vault-api";

import { NOW_MS, WALLET_A, liveActivity, liveEntry, liveSnapshot, seconds, settledEvent, signature } from "../../test/fixtures/live-dashboard";

const UPKEEP = { kind: "upkeep" } as VaultEventJson;

/** The keeper's own account-keeping, which is what the newest signatures mostly are. */
const upkeep = (seed: number): LiveEntryJson => liveEntry(signature(seed), seconds(NOW_MS - seed * 60_000), [UPKEEP]);

/** Fifteen signatures, not one of them a settlement: the page that started all this. */
const upkeepPage = (from: number, nextBefore: string | null): LiveActivityJson =>
  liveActivity(
    Array.from({ length: 15 }, (_, index) => upkeep(from + index)),
    { nextBefore },
  );

const settlementPage = (from: number, nextBefore: string | null): LiveActivityJson =>
  liveActivity([upkeep(from), liveEntry(signature(from + 1), seconds(NOW_MS - 19 * 3_600_000), [settledEvent("36600000")])], { nextBefore });

const ok = (body: LiveActivityJson): ApiResult<LiveActivityJson> => ({ ok: true, status: 200, body });
const rateLimited: ApiResult<LiveActivityJson> = { ok: false, status: 429, code: "rate_limited", message: "", retryAfterSeconds: 12, body: {} };

/** A fake /api/solana-live that answers `before` from a script, and records what was asked. */
function pages(script: readonly ApiResult<LiveActivityJson>[]): { fetchPage: (before: string) => Promise<ApiResult<LiveActivityJson>>; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetchPage: async (before: string) => {
      asked.push(before);
      return script[asked.length - 1] ?? ok(liveActivity([], { nextBefore: null }));
    },
  };
}

const HEAD = upkeepPage(1, signature(16));

describe("the state says a settlement exists and the loaded page holds none", () => {
  it("pages back for it ITSELF, and stops at the page that holds it", async () => {
    const { fetchPage, asked } = pages([ok(upkeepPage(20, signature(40))), ok(settlementPage(40, signature(60)))]);

    expect(chainSaysSettled(liveSnapshot())).toBe(true);
    expect(holdsSettlement(HEAD.entries)).toBe(false);
    expect(
      shouldBackfill({ chainSettled: true, loadedHasSettlement: false, cursor: HEAD.nextBefore, manualBusy: false, rounds: 0, done: false }),
    ).toBe(true);

    const filled = await backfillSettlements({ cursor: HEAD.nextBefore!, fetchPage });

    // It asked from where the loaded history ended, then from where that page did.
    expect(asked).toEqual([signature(16), signature(40)]);
    expect(filled.pages).toBe(2);
    expect(filled.found).toBe(true);
    expect(filled.failure).toBeNull();
    expect(filled.cursor).toBe(signature(60));
    expect(holdsSettlement(filled.entries)).toBe(true);
  });

  it("leaves the dashboard holding the settlement, through the store the hook uses", async () => {
    const { fetchPage } = pages([ok(upkeepPage(20, signature(40))), ok(settlementPage(40, null))]);
    const filled = await backfillSettlements({ cursor: HEAD.nextBefore!, fetchPage });

    const held = appendOlder(mergeHead([], { entries: HEAD.entries, gap: true }), filled.entries);
    const view = toLiveDashboard({
      snapshot: liveSnapshot(),
      activity: liveActivity(held, { nextBefore: filled.cursor }),
      privyWallets: [WALLET_A],
    });

    // What the head page alone could not say, and said wrongly instead.
    expect(view.stats.loadedSettlements).toBe(1);
    expect(view.stats.settledOutsideHistory).toBe(false);
    expect(view.stats.lastSettlementAt).not.toBeNull();
    expect(view.chart).not.toBeNull();
  });
});

describe("what it costs, because reads are rationed", () => {
  it("asks for no more than BACKFILL_PAGES older pages when they still hold none", async () => {
    const { fetchPage, asked } = pages([ok(upkeepPage(20, signature(40))), ok(upkeepPage(40, signature(60))), ok(settlementPage(60, null))]);

    const filled = await backfillSettlements({ cursor: HEAD.nextBefore!, fetchPage });

    expect(BACKFILL_PAGES).toBe(2);
    expect(asked).toEqual([signature(16), signature(40)]);
    expect(filled.pages).toBe(BACKFILL_PAGES);
    expect(filled.found).toBe(false);
    // The third page was NOT read, even though it held the settlement: at 1 + up
    // to 15 upstream calls a page, and 60 read tokens a client's minute, the
    // bound is the point. The cursor it stopped at is what "Load older" reads.
    expect(filled.cursor).toBe(signature(60));
  });

  it("does not pay again on the next poll: a clean round is the answer, found or not", () => {
    // `done` is what the hook sets after a round that came back without failing.
    expect(shouldBackfill({ chainSettled: true, loadedHasSettlement: false, cursor: signature(60), manualBusy: false, rounds: 1, done: true })).toBe(false);
    // …and the rounds themselves are capped whatever `done` says.
    expect(
      shouldBackfill({ chainSettled: true, loadedHasSettlement: false, cursor: signature(60), manualBusy: false, rounds: BACKFILL_ROUNDS, done: false }),
    ).toBe(false);
  });

  it("keeps the rows a failed round did read, leaves the cursor where the failure found it, and may be retried once", async () => {
    const { fetchPage, asked } = pages([ok(upkeepPage(20, signature(40))), rateLimited]);

    const filled = await backfillSettlements({ cursor: HEAD.nextBefore!, fetchPage });

    expect(asked).toEqual([signature(16), signature(40)]);
    expect(filled.entries).toHaveLength(15);
    // The page that failed did not move where the history ends.
    expect(filled.cursor).toBe(signature(40));
    expect(filled.failure?.status).toBe(429);
    expect(filled.found).toBe(false);
    expect(shouldBackfill({ chainSettled: true, loadedHasSettlement: false, cursor: filled.cursor, manualBusy: false, rounds: 1, done: false })).toBe(true);
  });

  it("stops on a history the route could not read, which is not an empty one", async () => {
    const { fetchPage, asked } = pages([ok(liveActivity([], { status: "unreadable", nextBefore: null }))]);

    const filled = await backfillSettlements({ cursor: HEAD.nextBefore!, fetchPage });

    expect(asked).toHaveLength(1);
    expect(filled.unreadable).toBe(true);
    expect(filled.found).toBe(false);
    // An unreadable page moves nothing: the cursor is still where it was asked from.
    expect(filled.cursor).toBe(signature(16));
  });
});

describe("when the backfill stands down", () => {
  const base = { chainSettled: true, loadedHasSettlement: false, cursor: signature(16), manualBusy: false, rounds: 0, done: false };

  it("never runs when the state records no settlement: there is nothing to go looking for", () => {
    expect(shouldBackfill({ ...base, chainSettled: false })).toBe(false);
  });

  it("never runs when the loaded history already holds one", () => {
    expect(shouldBackfill({ ...base, loadedHasSettlement: true })).toBe(false);
  });

  it("never runs when the history already reaches the beginning", () => {
    expect(shouldBackfill({ ...base, cursor: null })).toBe(false);
  });

  it("stands down while a manual Load older is in flight: one reader of the tail", () => {
    expect(shouldBackfill({ ...base, manualBusy: true })).toBe(false);
  });

  it("runs in the ordinary case", () => {
    expect(shouldBackfill(base)).toBe(true);
  });
});

describe("what counts as the state saying a settlement exists", () => {
  const withVault = (lifetimeSaved: string, settlementNonce: string | null): LiveSnapshotJson => {
    const snapshot = liveSnapshot();
    return {
      ...snapshot,
      vault: { ...snapshot.vault, state: { ...snapshot.vault.state!, lifetimeSaved } },
      wallets: [{ ...snapshot.wallets[0]!, link: { ...snapshot.wallets[0]!.link, settlementNonce } }],
    };
  };

  it("the vault's own total, which only ever moves on a settlement", () => {
    expect(chainSaysSettled(withVault("36600000", "0"))).toBe(true);
  });

  it("a link's settlement nonce, even with the vault's total unread", () => {
    const snapshot = withVault("0", "3");
    expect(chainSaysSettled(snapshot)).toBe(true);
  });

  it("a link the snapshot DISCOVERED, for a wallet Privy does not list", () => {
    const snapshot = withVault("0", "0");
    expect(
      chainSaysSettled({
        ...snapshot,
        links: { status: "exists", items: [{ wallet: "OtherWa11etP1aceho1der11111111111111111111", address: "link", epoch: "12", settlementNonce: "1", frontierSlot: "9" }] },
      }),
    ).toBe(true);
  });

  it("neither, when nothing has settled: a nonce nobody could read does not vote", () => {
    expect(chainSaysSettled(withVault("0", "0"))).toBe(false);
    expect(chainSaysSettled(withVault("0", null))).toBe(false);
  });

  it("NOT a nonce from a wallet still seated in ANOTHER vault", () => {
    // What commit 0e3c95f is about: a Privy wallet whose TradingLink names an
    // older vault is read with status "other_vault" and its own nonce
    // (readers.ts:952). On a NEW vault that has never settled, counting it sent
    // every mount paging back two pages — up to 32 of the client's 60 read
    // tokens a minute — for a row that cannot be in this vault's history.
    const snapshot = withVault("0", "3");
    const elsewhere: LiveSnapshotJson = {
      ...snapshot,
      wallets: [{ ...snapshot.wallets[0]!, link: { ...snapshot.wallets[0]!.link, status: "other_vault", vault: "AnotherVaultP1aceho1der111111111111111111" } }],
    };

    expect(chainSaysSettled(elsewhere)).toBe(false);
    expect(
      shouldBackfill({ chainSettled: chainSaysSettled(elsewhere), loadedHasSettlement: false, cursor: signature(16), manualBusy: false, rounds: 0, done: false }),
    ).toBe(false);
  });

  it("decides it the same way the SCREEN does, so the claim and the fetch cannot disagree", () => {
    // live-model.ts scopes its own "the state says settled" to this_vault
    // links, and said "none yet" while the fetch went looking anyway.
    const snapshot = withVault("0", "3");
    const elsewhere: LiveSnapshotJson = {
      ...snapshot,
      wallets: [{ ...snapshot.wallets[0]!, link: { ...snapshot.wallets[0]!.link, status: "other_vault", vault: "AnotherVaultP1aceho1der111111111111111111" } }],
    };
    const view = toLiveDashboard({ snapshot: elsewhere, activity: liveActivity(HEAD.entries, { nextBefore: signature(16) }), privyWallets: [WALLET_A] });

    expect(view.stats.settledOutsideHistory).toBe(false);
    expect(chainSaysSettled(elsewhere)).toBe(false);

    // And where the state DOES say so, both say so, over the same page.
    const settled = liveSnapshot();
    const claimed = toLiveDashboard({ snapshot: settled, activity: liveActivity(HEAD.entries, { nextBefore: signature(16) }), privyWallets: [WALLET_A] });
    expect(claimed.stats.settledOutsideHistory).toBe(true);
    expect(chainSaysSettled(settled)).toBe(true);
  });

  it("agrees with the screen about what the LOADED history holds, slot filter and all", () => {
    // The model drops a settlement newer than the snapshot's slot from the
    // curve's arithmetic; neither its claim nor this decision may follow it
    // there, or the backfill goes looking for a row already on the screen.
    const newer = liveEntry(signature(2), seconds(NOW_MS - 30_000), [settledEvent("36600000")], 99_999);
    const page = liveActivity([newer, ...HEAD.entries], { nextBefore: signature(16) });
    const view = toLiveDashboard({ snapshot: liveSnapshot(), activity: page, privyWallets: [WALLET_A] });

    expect(holdsSettlement(page.entries)).toBe(true);
    expect(view.stats.settledOutsideHistory).toBe(false);
    expect(view.stats.loadedSettlements).toBe(0); // the slot filter, still doing its job
    expect(
      shouldBackfill({ chainSettled: true, loadedHasSettlement: holdsSettlement(page.entries), cursor: signature(16), manualBusy: false, rounds: 0, done: false }),
    ).toBe(false);
  });
});

// ── and it has to be WIRED, which no unit of it can prove on its own ──────────
//
// The dashboard's read path lives in a React hook, and this package has no DOM
// to render one in (node environment; no jsdom, no testing-library). The rule
// still has to hold — a backfill nothing calls is the same screen as no
// backfill — so the hook's source is read here, the way no-mock-import.test.ts
// reads the live panels'. The last case keeps the scan honest.

const HOOK = fileURLToPath(new URL("../hooks/use-live-dashboard.ts", import.meta.url));

/** The file's CODE, with its prose removed: a comment about backfilling is not a call. */
const code = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join("\n");

const CALLS_BACKFILL = /await\s+backfillSettlements\s*\(/;

describe("the dashboard's own read path calls it", () => {
  const source = code(readFileSync(HOOK, "utf8"));

  it("imports the rule and the round from this module", () => {
    expect(source).toMatch(/import\s*\{[^}]*backfillSettlements[^}]*\}\s*from\s*["']@\/lib\/live-backfill["']/);
    expect(source).toContain("shouldBackfill(");
    expect(source).toContain("chainSaysSettled(");
  });

  it("runs it inside the read that just loaded the head page, not in some other path", () => {
    expect(CALLS_BACKFILL.test(source)).toBe(true);
    // `read` is defined before `loadOlder`: the call belongs to the read path,
    // which is the one the poll and the first mount both go through.
    expect(source.search(CALLS_BACKFILL)).toBeLessThan(source.indexOf("const loadOlder"));
    // And it pages through the SAME api.activity every other read uses.
    expect(source).toMatch(/fetchPage:\s*\(before\)\s*=>\s*api\.activity\(/);
  });

  it("takes the tail before it awaits, so a manual Load older cannot page from the same cursor", () => {
    const took = source.indexOf("olderBusyRef.current = true");
    expect(took).toBeGreaterThan(-1);
    expect(took).toBeLessThan(source.search(CALLS_BACKFILL));
    // The manual button consults the same flag rather than state alone.
    expect(source).toMatch(/older\.busy\s*\|\|\s*olderBusyRef\.current/);
  });

  it("forgets what it spent when the pension key changes: a different pension starts again", () => {
    expect(source).toContain("backfillRounds.current = 0");
    expect(source).toContain("backfillDone.current = false");
  });

  it("would still CATCH a hook that stopped calling it: the scan is not toothless", () => {
    expect(CALLS_BACKFILL.test(code("const filled = await backfillSettlements({ cursor, fetchPage });"))).toBe(true);
    expect(CALLS_BACKFILL.test(code("// await backfillSettlements() used to be called here"))).toBe(false);
    expect(CALLS_BACKFILL.test(code("const page = await api.activity({ owner, before });"))).toBe(false);
  });
});
