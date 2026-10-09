// What one read of a live pension puts on screen, and that it puts it there in
// ONE update (UI plan 2026-10-09, §5 item 7): the snapshot, its head page and
// the round's link rows together, so no figure moves apart from the rows that
// explain it. Every screen below goes through the REAL toLiveDashboard and the
// REAL pendingSteps, built from the store the way the hook builds its view.

import { SPYX_MINT, USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";
import { describe, expect, it } from "vitest";

import { EMPTY_LIVE_DATA, commitRead, forgottenData, historyComplete, paintFirst, withOlderPage, type LiveData, type ReadCommit } from "@/lib/live-commit";
import { toLiveDashboard } from "@/lib/live-model";
import { pendingSteps, type PendingKind } from "@/lib/live-pending";
import { historyAhead } from "@/lib/live-push";
import type { LiveActivityJson, LiveDashboard, LiveEntryJson, LiveSnapshotJson, VaultEventJson } from "@/lib/live-types";
import type { ApiResult } from "@/lib/vault-api";
import { NOW_MS, WALLET_A, liveActivity, liveEntry, liveSnapshot, seconds, settledEvent, signature, tokenAccount } from "../../test/fixtures/live-dashboard";

const RENT = 1_285_240n;
const converted = (): VaultEventJson => ({ kind: "converted", lamportsSpent: "200000000", usdcReceivedRaw: "20007742" }) as VaultEventJson;
const invested = (): VaultEventJson =>
  ({ kind: "invested", mint: SPYX_MINT, symbol: "SPYx", usdcSpentRaw: "20000000", receivedRaw: "2625673", receivedUi: "0.0287" }) as unknown as VaultEventJson;

/** A vault at `slot`, read at `readAtMs`, holding `free` lamports over its rent, and wSOL, USDC and SPYx raw. */
function vaultAt(input: { readonly slot: number; readonly readAtMs: number; readonly free: bigint; readonly usdc: bigint; readonly spyx?: bigint }): LiveSnapshotJson {
  const base = liveSnapshot();
  return liveSnapshot({
    slot: input.slot,
    readAtMs: input.readAtMs,
    vault: { ...base.vault, lamports: (RENT + input.free).toString(), rentFloor: RENT.toString(), withdrawableLamports: input.free.toString() },
    vaultTokenAccounts: {
      status: "exists",
      items: [
        tokenAccount(WSOL_MINT, "0", "0", 9),
        tokenAccount(USDC_MINT, input.usdc.toString(), "x", 6),
        tokenAccount(SPYX_MINT, (input.spyx ?? 0n).toString(), "x", 8),
      ],
    },
  });
}

const ok = (body: LiveActivityJson): ApiResult<LiveActivityJson> => ({ ok: true, status: 200, body });
const refused = (retryAfterSeconds: number | null): ApiResult<LiveActivityJson> => ({ ok: false, status: 429, code: "rate_limited", message: "", retryAfterSeconds, body: {} });

/** A read's commit, the way the hook gathers it. */
const readOf = (snapshot: LiveSnapshotJson, page: ApiResult<LiveActivityJson> | null, extra: Partial<ReadCommit> = {}): ReadCommit => ({
  snapshot,
  history: page === null ? null : { page, until: null, early: false, answeredAt: snapshot.readAtMs },
  linkRows: [],
  at: snapshot.readAtMs,
  ...extra,
});
/** A later read: it asked `until` the newest row held. */
const pollOf = (held: LiveData, snapshot: LiveSnapshotJson, page: ApiResult<LiveActivityJson>, extra: Partial<ReadCommit> = {}): ReadCommit =>
  readOf(snapshot, page, { history: { page, until: held.entries[0]?.signature ?? null, early: false, answeredAt: snapshot.readAtMs }, ...extra });

/** The screen the hook draws from a store (use-live-dashboard.ts, the view). */
function screenOf(data: LiveData): LiveDashboard {
  const snapshot = data.snapshot!;
  return toLiveDashboard({
    snapshot,
    activity:
      data.activityMeta === null ? null : { vault: snapshot.vault.address, status: data.activityMeta.status, nextBefore: data.activityMeta.nextBefore, entries: data.entries, gap: false },
    linkEntries: data.linkEntries,
    privyWallets: [WALLET_A],
  });
}

/** The rows that end each of the keeper's two steps. */
const ENDED_BY: Readonly<Record<Exclude<PendingKind, "measuring">, string>> = { converting: "converted", buying: "invested" };

/**
 * THE INVARIANT: the converting and buying lines that `after` no longer draws,
 * among those `before` drew, whose ending row `after` does not bring. Empty is
 * the only right answer for a commit whose read had the row.
 */
function linesLostWithoutTheirRow(before: LiveData, after: LiveData): string[] {
  const kinds = (data: LiveData): Set<PendingKind> => new Set(pendingSteps(screenOf(data)).map((step) => step.kind));
  const had = kinds(before);
  const has = kinds(after);
  const shown = new Set(screenOf(before).rows.map((row) => row.signature));
  const arrived = screenOf(after).rows.filter((row) => row.ok && !shown.has(row.signature));
  return (["converting", "buying"] as const).filter((kind) => had.has(kind) && !has.has(kind) && !arrived.some((row) => row.event.kind === ENDED_BY[kind]));
}

// ── the cycle the owner watched: a saving lands, the keeper converts it, then buys ──

const T = NOW_MS;
/** A saving a minute ago: 0.2 SOL free, so the conversion is under way. */
const SAVED = liveEntry(signature(1), seconds(T - 60_000), [settledEvent("200000000")], 4_200);
const CONVERTED = liveEntry(signature(2), seconds(T + 50_000), [converted()], 4_380);
const INVESTED = liveEntry(signature(3), seconds(T + 110_000), [invested()], 4_480);

/** The first read: the saving's SOL in the vault, its row on screen. */
const FIRST = commitRead(EMPTY_LIVE_DATA, readOf(vaultAt({ slot: 4_242, readAtMs: T, free: 200_000_000n, usdc: 0n }), ok(liveActivity([SAVED], { nextBefore: signature(99) }))));
/** After the conversion: no SOL, the USDC it brought. */
const AFTER_CONVERT = vaultAt({ slot: 4_400, readAtMs: T + 60_000, free: 0n, usdc: 20_007_742n });

describe("a converting or buying line leaves in the same commit as the row that ended it", () => {
  it("is the starting point: a saving's SOL on its way to USDC", () => {
    expect(pendingSteps(screenOf(FIRST)).map((step) => step.kind)).toEqual(["converting"]);
  });

  it("a read that brings the conversion takes the line away WITH the 'Converted' row — one commit, one transition", () => {
    const after = commitRead(FIRST, pollOf(FIRST, AFTER_CONVERT, ok(liveActivity([CONVERTED]))));
    expect(pendingSteps(screenOf(after)).map((step) => step.kind)).not.toContain("converting");
    expect(screenOf(after).rows.map((row) => row.signature)).toContain(CONVERTED.signature);
    expect(linesLostWithoutTheirRow(FIRST, after)).toEqual([]);
  });

  it("and that is exactly what the old two commits broke: the snapshot drawn alone took the line away with no row", () => {
    // What every later read used to draw for a second: the new snapshot over the old rows.
    const snapshotFirst: LiveData = { ...FIRST, snapshot: AFTER_CONVERT };
    expect(linesLostWithoutTheirRow(FIRST, snapshotFirst)).toEqual(["converting"]);
  });

  it("a history AHEAD of its snapshot is committed with the re-read the hook buys, so the line and the row still go together", () => {
    // The snapshot answered before the convert landed; the page answered after it.
    const behind = vaultAt({ slot: 4_300, readAtMs: T + 58_000, free: 200_000_000n, usdc: 0n });
    const page = ok(liveActivity([CONVERTED]));
    expect(historyAhead([CONVERTED], behind.slot)).toBe(true);
    // The re-read answered: the commit stands on it.
    const reread = commitRead(FIRST, pollOf(FIRST, AFTER_CONVERT, page));
    expect(linesLostWithoutTheirRow(FIRST, reread)).toEqual([]);
    expect(pendingSteps(screenOf(reread)).map((step) => step.kind)).not.toContain("converting");
    // The re-read was refused: the first snapshot is committed with the row, and the line stays beside it — never gone without it.
    const keptFirst = commitRead(FIRST, pollOf(FIRST, behind, page));
    expect(linesLostWithoutTheirRow(FIRST, keptFirst)).toEqual([]);
    expect(pendingSteps(screenOf(keptFirst)).map((step) => step.kind)).toContain("converting");
  });

  it("the buy goes the same way: the line leaves with the row that bought the basket", () => {
    const converted = commitRead(FIRST, pollOf(FIRST, AFTER_CONVERT, ok(liveActivity([CONVERTED]))));
    expect(pendingSteps(screenOf(converted)).map((step) => step.kind)).toEqual(["buying"]);
    const bought = vaultAt({ slot: 4_500, readAtMs: T + 120_000, free: 0n, usdc: 7_742n, spyx: 2_625_673n });
    const after = commitRead(converted, pollOf(converted, bought, ok(liveActivity([INVESTED]))));
    expect(pendingSteps(screenOf(after))).toEqual([]);
    expect(linesLostWithoutTheirRow(converted, after)).toEqual([]);
    expect(linesLostWithoutTheirRow(converted, { ...converted, snapshot: bought })).toEqual(["buying"]);
  });

  it("the first paint's early draw can never be the commit that takes a line away: it draws only onto an empty store", () => {
    expect(paintFirst(FIRST, AFTER_CONVERT, T + 60_000)).toBe(FIRST);
  });

  it("a read whose history FAILED is the one exception, and says so: its snapshot is current, the feed says it could not read", () => {
    const after = commitRead(FIRST, pollOf(FIRST, AFTER_CONVERT, refused(2)));
    expect(linesLostWithoutTheirRow(FIRST, after)).toEqual(["converting"]);
    expect(after.activityTrouble).not.toBeNull();
    expect(after.entries).toBe(FIRST.entries);
  });
});

// ── the commit itself ──────────────────────────────────────────────────────────

describe("commitRead", () => {
  const head = (entries: readonly LiveEntryJson[], overrides: Partial<LiveActivityJson> = {}) => ok(liveActivity(entries, overrides));

  it("commits the snapshot, a first head page and where the loaded history ends, and counts one read", () => {
    expect(FIRST.snapshot?.slot).toBe(4_242);
    expect(FIRST.entries.map((entry) => entry.signature)).toEqual([SAVED.signature]);
    expect(FIRST.activityMeta).toEqual({ status: "exists", nextBefore: signature(99) });
    expect(FIRST.activityTrouble).toBeNull();
    expect(FIRST.readId).toBe(1);
    expect(FIRST.committedAt).toBe(T);
  });

  it("puts a later page on top and keeps the head page's cursor: a poll does not say where the history ends", () => {
    const after = commitRead(FIRST, pollOf(FIRST, AFTER_CONVERT, head([CONVERTED], { nextBefore: null })));
    expect(after.entries.map((entry) => entry.signature)).toEqual([CONVERTED.signature, SAVED.signature]);
    expect(after.activityMeta?.nextBefore).toBe(signature(99));
    expect(historyComplete(after)).toBe(false);
    expect(after.readId).toBe(2);
    expect(after.committedAt).toBe(T + 60_000);
  });

  it("lets a gap replace the head, and its cursor with it", () => {
    const after = commitRead(FIRST, pollOf(FIRST, AFTER_CONVERT, head([CONVERTED], { gap: true, nextBefore: null })));
    expect(after.entries.map((entry) => entry.signature)).toEqual([CONVERTED.signature]);
    expect(historyComplete(after)).toBe(true);
  });

  it("keeps the rows and the cursor of a page that failed, and carries its retry-after from when it answered", () => {
    const failed = commitRead(FIRST, pollOf(FIRST, AFTER_CONVERT, refused(3)));
    expect(failed.entries).toBe(FIRST.entries);
    expect(failed.activityMeta).toBe(FIRST.activityMeta);
    expect(failed.activityTrouble).toEqual({ retryAt: T + 60_000 + 3_000, attempts: 0 });
    // The early re-read it buys counts toward that trouble; a read that reads clears it.
    const early = commitRead(failed, readOf(AFTER_CONVERT, refused(null), { history: { page: refused(null), until: SAVED.signature, early: true, answeredAt: T + 63_000 } }));
    expect(early.activityTrouble).toEqual({ retryAt: null, attempts: 1 });
    expect(commitRead(early, pollOf(early, AFTER_CONVERT, head([]))).activityTrouble).toBeNull();
  });

  it("says the history could not be read for a 200 the route marked unreadable, with no retry-after it did not give", () => {
    const after = commitRead(FIRST, pollOf(FIRST, AFTER_CONVERT, head([], { status: "unreadable" })));
    expect(after.activityTrouble).toEqual({ retryAt: null, attempts: 0 });
    expect(after.entries).toBe(FIRST.entries);
  });

  it("leaves the history alone when the read asked for none (no vault, or a caller that draws no history)", () => {
    const failed = commitRead(FIRST, pollOf(FIRST, AFTER_CONVERT, refused(3)));
    const chip = commitRead(failed, readOf(AFTER_CONVERT, null));
    expect(chip.entries).toBe(failed.entries);
    expect(chip.activityMeta).toBe(failed.activityMeta);
    expect(chip.activityTrouble).toBe(failed.activityTrouble);
    expect(chip.snapshot).toBe(AFTER_CONVERT);
    expect(chip.readId).toBe(failed.readId + 1);
  });

  it("puts the round's rows in the LINK list, never in the vault's, and touches neither its cursor nor its trouble", () => {
    const linked = liveEntry(signature(40), seconds(T - 86_400_000), [settledEvent("1000")], 3_000);
    const after = commitRead(FIRST, readOf(AFTER_CONVERT, null, { linkRows: [linked] }));
    expect(after.linkEntries.map((entry) => entry.signature)).toEqual([linked.signature]);
    expect(after.entries).toBe(FIRST.entries);
    expect(after.activityMeta).toBe(FIRST.activityMeta);
    // Read again, it is held once.
    expect(commitRead(after, readOf(AFTER_CONVERT, null, { linkRows: [linked] })).linkEntries).toHaveLength(1);
  });

  it("keeps an older page loaded while the read was out under the new head", () => {
    const older = withOlderPage(FIRST, liveActivity([liveEntry(signature(5), seconds(T - 7_200_000), [settledEvent("1")], 4_000)], { nextBefore: null }));
    const after = commitRead(older, pollOf(FIRST, AFTER_CONVERT, head([CONVERTED])));
    expect(after.entries.map((entry) => entry.signature)).toEqual([CONVERTED.signature, SAVED.signature, signature(5)]);
    expect(historyComplete(after)).toBe(true);
  });
});

describe("what is not a read of the chain's present", () => {
  it("the first paint's early draw: the snapshot alone onto an empty store, the clock moved, the count not", () => {
    const early = paintFirst(EMPTY_LIVE_DATA, AFTER_CONVERT, T + 1_500);
    expect(early).toEqual({ ...EMPTY_LIVE_DATA, snapshot: AFTER_CONVERT, committedAt: T + 1_500 });
    // Its read commits next, and only then does the count move.
    expect(commitRead(early, readOf(AFTER_CONVERT, ok(liveActivity([CONVERTED])))).readId).toBe(1);
  });

  it("an older page: appended, its cursor taken, the count and the clock left as they were", () => {
    const older = withOlderPage(FIRST, liveActivity([liveEntry(signature(5), seconds(T - 7_200_000), [settledEvent("1")], 4_000)], { nextBefore: signature(98) }));
    expect(older.entries.map((entry) => entry.signature)).toEqual([SAVED.signature, signature(5)]);
    expect(older.activityMeta?.nextBefore).toBe(signature(98));
    expect(older.readId).toBe(FIRST.readId);
    expect(older.committedAt).toBe(FIRST.committedAt);
  });

  it("a pension key that changed: everything forgotten but the count, which never goes back", () => {
    expect(forgottenData(FIRST)).toEqual({ ...EMPTY_LIVE_DATA, readId: 1 });
  });

  it("the history is complete only once a page named no older one", () => {
    expect(historyComplete(EMPTY_LIVE_DATA)).toBe(false);
    expect(historyComplete({ activityMeta: { status: "exists", nextBefore: null } })).toBe(true);
    expect(historyComplete({ activityMeta: { status: "exists", nextBefore: "x" } })).toBe(false);
  });
});
