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
import { BACKFILL_PAGES, BACKFILL_ROUNDS, backfillLinkSettlements, backfillSpend, chainSaysSettled, forgetBackfillSpend, holdsSettlement, settlementWallets, shouldBackfill } from "@/lib/live-backfill";
import { toLiveDashboard } from "@/lib/live-model";
import type { LiveActivityJson, LiveEntryJson, LiveLinkActivityJson, LiveSnapshotJson, VaultEventJson } from "@/lib/live-types";
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

/** One page of a WALLET's link, as the route answers it: its own cursor, never `nextBefore`. */
const linkPage = (entries: readonly LiveEntryJson[], nextBeforeLink: string | null, over: Partial<LiveLinkActivityJson> = {}): LiveLinkActivityJson => ({
  scope: "link",
  vault: "VaultP1aceho1der11111111111111111111111111",
  wallet: WALLET_A,
  address: "LinkP1aceho1der111111111111111111111111111",
  status: "exists",
  nextBeforeLink,
  entries,
  filtered: 0,
  unread: 0,
  gap: false,
  ...over,
});

const ok = (body: LiveLinkActivityJson): ApiResult<LiveLinkActivityJson> => ({ ok: true, status: 200, body });
const rateLimited: ApiResult<LiveLinkActivityJson> = { ok: false, status: 429, code: "rate_limited", message: "", retryAfterSeconds: 12, body: {} };

/** A fake /api/solana-live that answers from a script, and records who was asked for what. */
function pages(script: readonly ApiResult<LiveLinkActivityJson>[]): {
  fetchPage: (wallet: string, before: string | null) => Promise<ApiResult<LiveLinkActivityJson>>;
  asked: { wallet: string; before: string | null }[];
} {
  const asked: { wallet: string; before: string | null }[] = [];
  return {
    asked,
    fetchPage: async (wallet: string, before: string | null) => {
      asked.push({ wallet, before });
      return script[asked.length - 1] ?? ok(linkPage([], null));
    },
  };
}

const HEAD = upkeepPage(1, signature(16));

/** A page of ONE wallet's link: nearly pure settlements, which is the point of it. */
const settlements = (from: number, count: number, nextBeforeLink: string | null): LiveLinkActivityJson =>
  linkPage(
    Array.from({ length: count }, (_, index) => liveEntry(signature(from + index), seconds(NOW_MS - (19 + index) * 3_600_000), [settledEvent("36600000")])),
    nextBeforeLink,
  );

describe("the state says a settlement exists and the loaded page holds none", () => {
  it("goes to the WALLET'S LINK for it, at that stream's own head", async () => {
    const { fetchPage, asked } = pages([ok(settlements(40, 1, null))]);
    const snapshot = liveSnapshot();

    expect(chainSaysSettled(snapshot)).toBe(true);
    expect(holdsSettlement(HEAD.entries)).toBe(false);
    const links = settlementWallets(snapshot);
    expect(links).toEqual([WALLET_A]);
    expect(shouldBackfill({ chainSettled: true, loadedHasSettlement: false, wallets: links.length, manualBusy: false, rounds: 0, done: false, retryAt: null, now: NOW_MS })).toBe(true);

    const filled = await backfillLinkSettlements({ wallets: links, fetchPage });

    // A LINK STREAM STARTS AT ITS OWN HEAD. The vault's cursor is a different
    // stream's and may never be handed to it.
    expect(asked).toEqual([{ wallet: WALLET_A, before: null }]);
    expect(filled.found).toBe(true);
    expect(filled.failure).toBeNull();
    expect(holdsSettlement(filled.entries)).toBe(true);
  });

  it("stops asking a wallet once its link reaches the beginning", async () => {
    const { fetchPage, asked } = pages([ok(settlements(40, 1, null)), ok(settlements(50, 1, null))]);
    await backfillLinkSettlements({ wallets: [WALLET_A], fetchPage });
    expect(asked).toHaveLength(1);
  });

  it("pages a second wallet out of the SAME budget, not a fresh one", async () => {
    const other = "OtherWa11etP1aceho1der11111111111111111111";
    const { fetchPage, asked } = pages([ok(settlements(40, 1, signature(80))), ok(settlements(50, 1, signature(90)))]);

    const filled = await backfillLinkSettlements({ wallets: [WALLET_A, other], fetchPage });

    expect(BACKFILL_PAGES).toBe(2);
    expect(filled.pages).toBe(BACKFILL_PAGES);
    // Both pages went to the first wallet, whose stream had not ended: the
    // bound is the ROUND's, so two wallets cost what one did.
    expect(asked.map((call) => call.wallet)).toEqual([WALLET_A, WALLET_A]);
  });

  /**
   * THE TWO STREAMS ARE KEPT APART, and the model is what puts them back
   * together: the feed stays the vault's contiguous page, while the
   * settlements come from both.
   */
  it("leaves the dashboard holding the settlement, through the two stores the hook keeps", async () => {
    const { fetchPage } = pages([ok(settlements(40, 1, null))]);
    const filled = await backfillLinkSettlements({ wallets: [WALLET_A], fetchPage });

    const view = toLiveDashboard({
      snapshot: liveSnapshot(),
      activity: liveActivity(mergeHead([], { entries: HEAD.entries, gap: true }), { nextBefore: HEAD.nextBefore }),
      linkEntries: appendOlder([], filled.entries),
      privyWallets: [WALLET_A],
    });

    // What the head page alone could not say, and said wrongly instead.
    expect(view.stats.loadedSettlements).toBe(1);
    expect(view.stats.settledOutsideHistory).toBe(false);
    expect(view.stats.lastSettlementAt).not.toBeNull();
    expect(view.chart).not.toBeNull();
    // The FEED is still the vault's own page, to the row.
    expect(view.rows).toHaveLength(0);
    expect(view.hiddenUpkeep).toBe(15);
  });
});

describe("what it costs, because reads are rationed", () => {
  it("asks for no more than BACKFILL_PAGES pages when the stream still holds none", async () => {
    const { fetchPage, asked } = pages([ok(linkPage([upkeep(20)], signature(40))), ok(linkPage([upkeep(40)], signature(60))), ok(settlements(60, 1, null))]);

    const filled = await backfillLinkSettlements({ wallets: [WALLET_A], fetchPage });

    expect(asked).toHaveLength(BACKFILL_PAGES);
    expect(filled.pages).toBe(BACKFILL_PAGES);
    expect(filled.found).toBe(false);
  });

  it("does not pay again on the next poll: a clean round is the answer, found or not", () => {
    expect(shouldBackfill({ chainSettled: true, loadedHasSettlement: false, wallets: 1, manualBusy: false, rounds: 1, done: true, retryAt: null, now: NOW_MS })).toBe(false);
    expect(shouldBackfill({ chainSettled: true, loadedHasSettlement: false, wallets: 1, manualBusy: false, rounds: BACKFILL_ROUNDS, done: false, retryAt: null, now: NOW_MS })).toBe(false);
  });

  it("keeps the rows a failed round did read, and may be retried once", async () => {
    const { fetchPage, asked } = pages([ok(settlements(40, 1, signature(60))), rateLimited]);

    const filled = await backfillLinkSettlements({ wallets: [WALLET_A], fetchPage });

    expect(asked).toHaveLength(2);
    expect(filled.entries).toHaveLength(1);
    expect(filled.failure?.status).toBe(429);
    expect(shouldBackfill({ chainSettled: true, loadedHasSettlement: false, wallets: 1, manualBusy: false, rounds: 1, done: false, retryAt: null, now: NOW_MS })).toBe(true);
  });

  it("stops on a history the route could not read, which is not an empty one", async () => {
    const { fetchPage, asked } = pages([ok(linkPage([], null, { status: "unreadable" }))]);

    const filled = await backfillLinkSettlements({ wallets: [WALLET_A], fetchPage });

    expect(asked).toHaveLength(1);
    expect(filled.unreadable).toBe(true);
    expect(filled.found).toBe(false);
  });
});

describe("when the backfill stands down", () => {
  const base = { chainSettled: true, loadedHasSettlement: false, wallets: 1, manualBusy: false, rounds: 0, done: false, retryAt: null, now: NOW_MS };

  it("never runs when the state records no settlement: there is nothing to go looking for", () => {
    expect(shouldBackfill({ ...base, chainSettled: false })).toBe(false);
  });

  it("never runs when the loaded history already holds one", () => {
    expect(shouldBackfill({ ...base, loadedHasSettlement: true })).toBe(false);
  });

  it("never runs when there is no link to page: no wallet, nothing to ask", () => {
    expect(shouldBackfill({ ...base, wallets: 0 })).toBe(false);
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
      shouldBackfill({ chainSettled: chainSaysSettled(elsewhere), loadedHasSettlement: false, wallets: 1, manualBusy: false, rounds: 0, done: false, retryAt: null, now: NOW_MS }),
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
      shouldBackfill({ chainSettled: true, loadedHasSettlement: holdsSettlement(page.entries), wallets: 1, manualBusy: false, rounds: 0, done: false, retryAt: null, now: NOW_MS }),
    ).toBe(false);
  });
});

describe("what a round costs, and how often it is paid", () => {
  const key = (name: string): string => `PensionKey-${name}`;
  const decision = (spend: { rounds: number; done: boolean; retryAt: number | null }, now = NOW_MS) => ({
    chainSettled: true,
    loadedHasSettlement: false,
    wallets: 1,
    manualBusy: false,
    ...spend,
    now,
  });

  it("is remembered across mounts, because the hook's refs are not", () => {
    // The app has separate routes, so /wallets and back remounts the hook. A
    // round that already answered must not be re-bought out of the same 60
    // read tokens a minute the activity page is paid from.
    const mine = key("across-mounts");
    expect(backfillSpend(mine)).toEqual({ rounds: 0, done: false, retryAt: null });
    expect(shouldBackfill(decision(backfillSpend(mine)))).toBe(true);

    const spend = backfillSpend(mine);
    spend.rounds += 1;
    spend.done = true;

    // The next mount asks the same question and gets the answer already paid for.
    expect(backfillSpend(mine)).toEqual({ rounds: 1, done: true, retryAt: null });
    expect(shouldBackfill(decision(backfillSpend(mine)))).toBe(false);
  });

  it("is a different answer for a different pension key", () => {
    const mine = key("mine");
    backfillSpend(mine).done = true;
    expect(backfillSpend(key("someone-else")).done).toBe(false);
    expect(shouldBackfill(decision(backfillSpend(key("someone-else"))))).toBe(true);
  });

  it("is forgotten when a gap page throws the loaded history away", () => {
    const mine = key("gap");
    const spend = backfillSpend(mine);
    spend.rounds = 1;
    spend.done = true;

    forgetBackfillSpend(mine);

    expect(backfillSpend(mine)).toEqual({ rounds: 0, done: false, retryAt: null });
    expect(shouldBackfill(decision(backfillSpend(mine)))).toBe(true);
  });

  it("does not aim its retry at the bucket it just emptied", () => {
    // The mount round costs ~21 read tokens and this one up to 32, of 60 that
    // refill at one a second. A 429 that says "12 s" is worth waiting out.
    const failed = { rounds: 1, done: false, retryAt: NOW_MS + 12_000 };
    expect(shouldBackfill(decision(failed, NOW_MS))).toBe(false);
    expect(shouldBackfill(decision(failed, NOW_MS + 11_999))).toBe(false);
    expect(shouldBackfill(decision(failed, NOW_MS + 12_000))).toBe(true);
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

const CALLS_BACKFILL = /await\s+backfillLinkSettlements\s*\(/;

describe("the dashboard's own read path calls it", () => {
  const source = code(readFileSync(HOOK, "utf8"));

  it("imports the rule and the round from this module", () => {
    expect(source).toMatch(/import\s*\{[^}]*backfillLinkSettlements[^}]*\}\s*from\s*["']@\/lib\/live-backfill["']/);
    expect(source).toContain("shouldBackfill(");
    expect(source).toContain("chainSaysSettled(");
    expect(source).toContain("settlementWallets(");
  });

  it("runs it inside the read that just loaded the head page, not in some other path", () => {
    expect(CALLS_BACKFILL.test(source)).toBe(true);
    // `read` is defined before `loadOlder`: the call belongs to the read path,
    // which is the one the poll and the first mount both go through.
    expect(source.search(CALLS_BACKFILL)).toBeLessThan(source.indexOf("const loadOlder"));
  });

  it("pages the LINKS, never the vault, which is the whole point of the round", () => {
    const round = source.slice(source.search(CALLS_BACKFILL), source.indexOf("const loadOlder"));
    expect(round).toMatch(/api\.linkActivity\(/);
    expect(round).not.toContain("api.activity(");
  });

  /**
   * THE TWO STREAMS MAY NOT SHARE A STORE, and this is the scan that keeps it
   * so. Every window total on the screen rests on the vault page being one
   * contiguous slice; a wallet's link is a slice of a different stream. Poured
   * into `entries` it would move the oldest loaded settlement backwards while
   * leaving holes above it, and a link page carrying `gap` would make mergeHead
   * throw the vault's whole loaded history away.
   */
  it("writes what it read into the LINK store, and touches neither the vault's rows nor its cursor", () => {
    const round = source.slice(source.search(CALLS_BACKFILL), source.indexOf("const loadOlder"));
    expect(round).toContain("setLinkEntries(");
    expect(round).not.toContain("setEntries(");
    expect(round).not.toContain("setActivityMeta(");
    expect(round).not.toContain("setOlder(");
  });

  it("counts what it spent PER PENSION KEY in this module, not in a ref that dies with the mount", () => {
    expect(source).toMatch(/import\s*\{[^}]*backfillSpend[^}]*\}\s*from\s*["']@\/lib\/live-backfill["']/);
    expect(source).toContain("backfillSpend(pensionKey)");
    // The refs that used to hold it are gone, not merely unread.
    expect(source).not.toContain("backfillRounds");
    expect(source).not.toContain("backfillDone");
  });

  it("lets a gap page buy the round again, because a gap threw the history away", () => {
    expect(source).toMatch(/page\.body\.gap\)\s*forgetBackfillSpend\(pensionKey\)/);
  });

  it("keeps its own failure off the control nobody pressed", () => {
    const round = source.slice(source.search(CALLS_BACKFILL), source.indexOf("const loadOlder"));
    expect(round).not.toContain("wordsFor(");
    expect(round).not.toContain("message:");
    // It is remembered where the rule can read it instead.
    expect(round).toContain("spend.retryAt =");
  });

  it("would still CATCH a hook that stopped calling it: the scan is not toothless", () => {
    expect(CALLS_BACKFILL.test(code("const filled = await backfillLinkSettlements({ wallets, fetchPage });"))).toBe(true);
    expect(CALLS_BACKFILL.test(code("// await backfillLinkSettlements() used to be called here"))).toBe(false);
    expect(CALLS_BACKFILL.test(code("const page = await api.activity({ owner, before });"))).toBe(false);
  });
});
