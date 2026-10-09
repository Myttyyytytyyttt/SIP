// How a step over the feed ends, and how the rows say what they are
// (LivePending.tsx, 10-09): "done" only once the transaction that did it is on
// the page, an honest heading, the below-lg card held up for a minute, and every
// copy drawn from one track.

import { ANTHROPIC_MINT, SPYX_MINT, USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CARD_HOLD_MS,
  DONE_HOLD_MS,
  PendingRows,
  advancePending,
  doneOf,
  headingOf,
  nextDue,
  pendingRowsOf,
  releasePending,
  startTrack,
  stillOf,
  viewOf,
  type PendingTrack,
} from "@/components/live/LivePending";
import { REVEAL_MS } from "@/components/live/Reveal";
import { LIVE_COPY, PENDING_COPY } from "@/lib/live-copy";
import { toLiveDashboard } from "@/lib/live-model";
import { pendingLines, pendingSteps, type PendingLine, type PendingStep } from "@/lib/live-pending";
import type { LiveDashboard, VaultEventJson } from "@/lib/live-types";

import { NOW_MS, liveActivity, liveEntry, liveSnapshot, seconds, signature, tokenAccount } from "../../../test/fixtures/live-dashboard";

const wrapped = { kind: "wrapped", lamports: "18000000" } as VaultEventJson;
const converted = { kind: "converted", lamportsSpent: "18000000", usdcReceivedRaw: "1800000" } as VaultEventJson;

/** The vault holding `wsol` lamports of wSOL and no free SOL or USDC, over these history rows. */
function vault(wsol: string, entries: ReturnType<typeof liveEntry>[], nowMs = NOW_MS): LiveDashboard {
  const base = liveSnapshot();
  return toLiveDashboard({
    snapshot: liveSnapshot({
      readAtMs: nowMs,
      vault: { ...base.vault, lamports: "1285240", withdrawableLamports: "0" },
      vaultTokenAccounts: { status: "exists", items: [tokenAccount(WSOL_MINT, wsol, "0", 9), tokenAccount(USDC_MINT, "0", "0", 6)] },
    }),
    activity: liveActivity(entries),
    privyWallets: [],
  });
}

const WRAP = liveEntry(signature(1), seconds(NOW_MS - 60_000), [wrapped]);
/** SOL wrapped a minute ago, the conversion under way. */
const converting = (): LiveDashboard => vault("18000000", [WRAP]);
const inputOf = (data: LiveDashboard) => {
  const steps = pendingSteps(data);
  return { data, steps, lines: pendingLines(steps, data.nowMs) };
};

describe("doneOf: a step ends as done only on the transaction that did it", () => {
  it("is done when the read that ended it brought a successful conversion newer than the step's clock", () => {
    const before = converting();
    const step = pendingSteps(before)[0]!;
    expect(step.kind).toBe("converting");
    const after = vault("0", [liveEntry(signature(2), seconds(NOW_MS + 20_000), [converted]), WRAP], NOW_MS + 30_000);
    expect(doneOf(step, "converting", after, before)).toEqual({
      key: "converting",
      kind: "converting",
      title: LIVE_COPY.pendingDone.convertedAt("12:00 UTC"),
      sub: LIVE_COPY.pendingDone.convertedSub,
      tone: "quiet",
    });
  });

  it("says when its transaction landed, with the day when the read that brought it is on the next one", () => {
    const before = converting();
    const step = pendingSteps(before)[0]!;
    // Landed at 23:59:30 UTC on Sep 16, read a minute later, past midnight.
    const late = NOW_MS + 12 * 3_600_000 - 30_000;
    const after = vault("0", [liveEntry(signature(2), seconds(late), [converted]), WRAP], late + 60_000);
    expect(doneOf(step, "converting", after, before)?.title).toBe(LIVE_COPY.pendingDone.convertedAt("yesterday, 23:59 UTC"));
  });

  it("says no time when the chain gave the transaction none, rather than a guessed one", () => {
    // A step with no clock of its own (slow) credits a landed conversion that has no block time.
    const step = { ...pendingSteps(converting())[0]!, since: null };
    const untimed = { ...liveEntry(signature(2), seconds(NOW_MS + 20_000), [converted]), blockTime: null };
    expect(doneOf(step, "converting", vault("0", [untimed, WRAP], NOW_MS + 30_000), converting())?.title).toBe(LIVE_COPY.pendingDone.converted);
  });

  it("is not done when the step ended any other way: no new conversion on the page, or one that failed", () => {
    const before = converting();
    const step = pendingSteps(before)[0]!;
    // The SOL went (withdrawn), and no conversion came with it.
    expect(doneOf(step, "converting", vault("0", [WRAP], NOW_MS + 30_000), before)).toBeNull();
    const failed = { ...liveEntry(signature(2), seconds(NOW_MS + 20_000), [converted]), ok: false };
    expect(doneOf(step, "converting", vault("0", [failed, WRAP], NOW_MS + 30_000), before)).toBeNull();
  });

  it("does not credit a conversion that was already on the page", () => {
    const old = liveEntry(signature(3), seconds(NOW_MS - 120_000), [converted]);
    const before = vault("18000000", [WRAP, old]);
    const step = pendingSteps(before)[0]!;
    expect(doneOf(step, "converting", vault("0", [WRAP, old], NOW_MS + 30_000), before)).toBeNull();
  });
});

/**
 * A BASKET IS BOUGHT ONE TRANSACTION PER LEG (solana-keeper invest-tick.ts),
 * and a turn can stop after some landed, the rest under the basket's minimum:
 * the done row names the legs on the page, never the basket the step meant.
 */
describe("doneOf: a buy names only the legs that landed", () => {
  const BUYING: PendingStep = { kind: "buying", state: "active", rest: null, amountRaw: 1_200_000n, valueUsdcRaw: 1_200_000n, symbols: ["SPYx", "ANTHROPIC"], since: NOW_MS - 60_000 };
  const invested = (mint: string, symbol: string | null) =>
    ({ kind: "invested", mint, symbol, usdcSpentRaw: "600000", receivedRaw: "1", receivedUi: "0.01" }) as VaultEventJson;
  const before = vault("0", [WRAP]);
  const bought = (...entries: ReturnType<typeof liveEntry>[]) => doneOf(BUYING, "buying", vault("0", [...entries, WRAP], NOW_MS + 30_000), before);

  it("says only SPYx when the ANTHROPIC leg did not land", () => {
    const done = bought(liveEntry(signature(5), seconds(NOW_MS + 10_000), [invested(SPYX_MINT, "SPYx")], 4_100));
    expect(done).toEqual({ key: "buying", kind: "buying", title: LIVE_COPY.pendingDone.boughtAt("SPYx", "12:00 UTC"), sub: LIVE_COPY.pendingDone.boughtSub, tone: "invest" });
  });

  it("names both legs, in the order they landed, when both did", () => {
    const done = bought(
      liveEntry(signature(6), seconds(NOW_MS + 12_000), [invested(ANTHROPIC_MINT, null)], 4_101),
      liveEntry(signature(5), seconds(NOW_MS + 10_000), [invested(SPYX_MINT, "SPYx")], 4_100),
    );
    expect(done?.title).toBe("Bought SPYx and ANTHROPIC · 12:00 UTC");
    expect(done?.title).toBe(LIVE_COPY.pendingDone.boughtAt("SPYx and ANTHROPIC", "12:00 UTC"));
  });

  it("claims nothing when a landed leg is one this app cannot name", () => {
    expect(bought(liveEntry(signature(5), seconds(NOW_MS + 10_000), [invested("UnknownMint11111111111111111111111111111111", null)], 4_100))).toBeNull();
  });
});

describe("the track", () => {
  it("holds a step whose transaction landed as done for DONE_HOLD_MS, then lets it close, then forgets it", () => {
    const start = startTrack(inputOf(converting()));
    const after = vault("0", [liveEntry(signature(2), seconds(NOW_MS + 20_000), [converted]), WRAP], NOW_MS + 30_000);
    const track = advancePending(start, inputOf(after), 1_000);
    expect([...track.done.keys()]).toEqual(["converting"]);
    expect(track.leaving.size).toBe(0);
    expect(nextDue(track)).toBe(1_000 + DONE_HOLD_MS);
    const rows = pendingRowsOf(track, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ show: "done", key: "converting", leaving: false });

    const closing = releasePending(track, 1_000 + DONE_HOLD_MS);
    expect(closing.done.size).toBe(0);
    expect(pendingRowsOf(closing, new Set())[0]).toMatchObject({ show: "done", leaving: true });
    expect(releasePending(closing, 1_000 + DONE_HOLD_MS + REVEAL_MS).leaving.size).toBe(0);
  });

  it("sends a step that ended with no transaction to show on its way out at once, its loader still", () => {
    const start = startTrack(inputOf(converting()));
    const track = advancePending(start, inputOf(vault("0", [WRAP], NOW_MS + 30_000)), 1_000);
    expect(track.done.size).toBe(0);
    expect(pendingRowsOf(track, new Set())[0]).toMatchObject({ show: "line", key: "converting", leaving: true, still: true });
    expect(nextDue(track)).toBe(1_000 + REVEAL_MS);
  });

  it("gives a step that comes back its row back: no done and no exit over a live line", () => {
    const start = startTrack(inputOf(converting()));
    const gone = advancePending(start, inputOf(vault("0", [WRAP], NOW_MS + 30_000)), 1_000);
    const back = advancePending(gone, inputOf(vault("18000000", [WRAP], NOW_MS + 50_000)), 1_100);
    expect(back.leaving.size).toBe(0);
    expect(pendingRowsOf(back, new Set()).map((row) => [row.show, row.leaving])).toEqual([["line", false]]);
  });

  it("holds the card up CARD_HOLD_MS after its last step ended, and not while a step stands", () => {
    const start = startTrack(inputOf(converting()));
    expect(start.cardUntil).toBeNull();
    const ended = advancePending(start, inputOf(vault("0", [WRAP], NOW_MS + 30_000)), 1_000);
    expect(ended.cardUntil).toBe(1_000 + CARD_HOLD_MS);
    expect(releasePending(ended, 1_000 + CARD_HOLD_MS - 1).cardUntil).toBe(1_000 + CARD_HOLD_MS);
    expect(releasePending(ended, 1_000 + CARD_HOLD_MS).cardUntil).toBeNull();
    // A new step during the hold: the card is up for it, and the hold is over.
    expect(advancePending(ended, inputOf(converting()), 2_000).cardUntil).toBeNull();
  });

  it("hands back the same track when the settled read did not move, or nothing was due", () => {
    const track: PendingTrack = startTrack(inputOf(converting()));
    expect(advancePending(track, inputOf(track.data), 1_000)).toBe(track);
    expect(releasePending(track, 9_999_999)).toBe(track);
    expect(nextDue(track)).toBeNull();
  });
});

describe("stillOf: the loaders the page is no longer sure of", () => {
  const active: PendingLine = { key: "converting", kind: "converting", active: true, rest: null, title: PENDING_COPY.converting, sub: "", amount: "$1.80", amountSpoken: "" };

  it("stills a step under way in the settled read that the newer snapshot no longer has under way", () => {
    expect([...stillOf([active], [])]).toEqual(["converting"]);
    expect([...stillOf([active], [{ ...active, active: false, rest: "slow" }])]).toEqual(["converting"]);
  });

  it("stills nothing once the read has settled, or while the snapshot agrees", () => {
    expect(stillOf([active], [active]).size).toBe(0);
  });
});

describe("the heading", () => {
  const line = (active: boolean): PendingLine => ({ key: "buying", kind: "buying", active, rest: active ? null : "paused", title: "", sub: "", amount: "$5.00", amountSpoken: null });

  it("is 'In progress' only while a step is under way, and 'Waiting' when every one rests", () => {
    expect(headingOf([line(true)])).toBe(LIVE_COPY.pendingHeading.active);
    expect(headingOf([line(false)])).toBe(LIVE_COPY.pendingHeading.waiting);
    expect(headingOf([line(false), { ...line(true), key: "converting", kind: "converting" }])).toBe(LIVE_COPY.pendingHeading.active);
  });

  it("is nothing with no step standing: over done rows alone, or a card held up over nothing, neither word is true", () => {
    expect(headingOf([])).toBeNull();
  });

  it("is never read out", () => {
    const out = renderToStaticMarkup(createElement(PendingRows, { lines: [line(false)] }));
    expect(out).toContain(`<div class="px-4 py-2 text-xs text-muted-foreground" aria-hidden="true">${LIVE_COPY.pendingHeading.waiting}</div>`);
  });
});

describe("the rows drawn", () => {
  it("draw a done step with a check, in the step's tone, and out of what the region reads", () => {
    const start = startTrack(inputOf(converting()));
    const after = vault("0", [liveEntry(signature(2), seconds(NOW_MS + 20_000), [converted]), WRAP], NOW_MS + 30_000);
    const track = advancePending(start, inputOf(after), 1_000);
    const view = { lines: track.lines, rows: pendingRowsOf(track, new Set()), held: track.cardUntil !== null };
    const out = renderToStaticMarkup(createElement(PendingRows, { lines: view.lines, view }));
    expect(out).toMatch(/<div class="[^"]*" data-pending-done="converting" aria-hidden="true">/);
    expect(out).toContain("lucide-check");
    expect(out).toContain(LIVE_COPY.pendingDone.converted);
    expect(out).toContain('data-pending-steps="0"');
    // A done row alone is neither in progress nor waiting: no heading over it.
    expect(out).not.toContain(LIVE_COPY.pendingHeading.active);
    expect(out).not.toContain(LIVE_COPY.pendingHeading.waiting);
  });

  it("keep the card up, saying nothing is in progress, through its hold after the last step closed", () => {
    const out = renderToStaticMarkup(createElement(PendingRows, { lines: [], view: { ...viewOf([]), held: true }, variant: "card", className: "lg:hidden" }));
    expect(out).toContain(LIVE_COPY.pendingIdle);
    // No "In progress" over "Nothing in progress right now", and no "Waiting" either.
    expect(out).not.toContain(LIVE_COPY.pendingHeading.active);
    expect(out).not.toContain(LIVE_COPY.pendingHeading.waiting);
    expect(out).toMatch(/^<div role="status" aria-live="polite" class="grid [^"]*lg:hidden" data-pending-steps="0">/);
    // The idle line is not news: not read out.
    expect(out).toMatch(/<p class="[^"]*" aria-hidden="true">Nothing in progress right now<\/p>/);
  });

  it("keep the card's region out of the flow while there is nothing, and there to announce the first step", () => {
    expect(renderToStaticMarkup(createElement(PendingRows, { lines: [], variant: "card", className: "lg:hidden" }))).toBe(
      '<div role="status" aria-live="polite" class="sr-only lg:hidden" data-pending-steps="0"></div>',
    );
  });

  it("draw every copy from one view: the same rows in the column and on the card", () => {
    const data = converting();
    const view = viewOf(pendingLines(pendingSteps(data), data.nowMs));
    const column = renderToStaticMarkup(createElement(PendingRows, { lines: view.lines, view }));
    const card = renderToStaticMarkup(createElement(PendingRows, { lines: view.lines, view, variant: "card" }));
    const rowsOf = (out: string) => out.match(/data-pending-step="[a-z]+"/g);
    expect(rowsOf(column)).toEqual(['data-pending-step="converting"']);
    expect(rowsOf(card)).toEqual(rowsOf(column));
  });
});
