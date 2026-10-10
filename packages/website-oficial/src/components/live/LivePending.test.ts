// How a step over the feed ends, and how the rows say what they are
// (LivePending.tsx, 10-09): "done" only once the transaction that did it is on
// the page, an honest heading, the below-lg card held up for a minute, and every
// copy drawn from one track. And from the review (10-09): a step the newest
// snapshot no longer has under way rests — no "In progress" with nothing behind
// it — and a done row the announcer did not speak says itself. And from the
// owner (10-10, "tiene mucho texto"): each step's sentence is in a "?" beside
// its title, and the polite region is its own, beside the rows, words only.

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
  pendingViewOf,
  releasePending,
  saidOf,
  startTrack,
  stillOf,
  toldBy,
  unconfirmedOf,
  viewOf,
  type DoneLine,
  type PendingRow,
  type PendingTrack,
  type ShownLine,
} from "@/components/live/LivePending";
import { nextWorkOf, rulePulseOf } from "@/components/live/NextInvestmentLive";
import { REVEAL_MS } from "@/components/live/Reveal";
import { arrivalsOf, baseOf, type ArrivalFrame } from "@/components/live/use-arrivals";
import { LIVE_COPY, PENDING_COPY } from "@/lib/live-copy";
import { toLiveDashboard } from "@/lib/live-model";
import { pendingLines, pendingSteps, type PendingLine, type PendingStep } from "@/lib/live-pending";
import type { LiveDashboard, VaultEventJson } from "@/lib/live-types";

import { NOW_MS, liveActivity, liveEntry, liveSnapshot, seconds, signature, tokenAccount } from "../../../test/fixtures/live-dashboard";
import { liveRegions, tickingInRegion } from "../../../test/live-regions";

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
      signatures: [signature(2)],
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
    expect(done).toEqual({
      key: "buying",
      kind: "buying",
      title: LIVE_COPY.pendingDone.boughtAt("SPYx", "12:00 UTC"),
      sub: LIVE_COPY.pendingDone.boughtSub,
      tone: "invest",
      signatures: [signature(5)],
    });
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

/**
 * A STEP THE PAGE CAN NO LONGER CONFIRM (review, 10-09). The whole read had SOL
 * converting; every read since committed its snapshot alone — the history
 * refused — and that snapshot no longer has it under way. The row stays (a
 * read with no history cannot say how it ended), but nothing says it is in
 * progress: the still clock, grey, "Not confirmed on this page yet", and no
 * turning mark beside Next investment — for as long as the history fails.
 */
describe("a step the newest snapshot no longer has under way", () => {
  /** The whole read the rows are drawn from: the conversion under way. */
  const held = (): PendingTrack => startTrack(inputOf(converting()));
  /** The newest snapshot, its history unreadable: the wSOL is gone. */
  const latest = (): PendingLine[] => {
    const alone = vault("0", [WRAP], NOW_MS + 20_000);
    return pendingLines(pendingSteps(alone), alone.nowMs);
  };

  it("keeps its row, drawn resting: no 'In progress', no loader, the doubt in its line and the step's own name", () => {
    const view = pendingViewOf(held(), latest());
    expect(view.lines).toMatchObject([{ key: "converting", active: false, rest: "slow", sub: LIVE_COPY.pendingUnconfirmed, unconfirmed: true }]);
    expect(view.rows).toMatchObject([{ show: "line", key: "converting", still: true, leaving: false }]);
    expect(headingOf(view.lines)).toBeNull();

    const out = renderToStaticMarkup(createElement(PendingRows, { lines: view.lines, view }));
    expect(out).not.toContain(LIVE_COPY.pendingHeading.active);
    expect(out).not.toContain(LIVE_COPY.pendingHeading.waiting);
    expect(out).not.toContain("data-work-loader");
    expect(out).not.toContain("animate-spin");
    expect(out).toContain('data-work-mark="slow"');
    expect(out).toContain('data-state="waiting"');
    expect(out).toContain(PENDING_COPY.converting);
    expect(out).toContain(LIVE_COPY.pendingUnconfirmed);
    // Nothing claims it ended either.
    expect(out).not.toContain("data-pending-done");
  });

  it("is no work under way beside Next investment, nor a buy beside Last investment", () => {
    const view = pendingViewOf(held(), latest());
    expect(nextWorkOf(view.rows)).toBeNull();
    expect(rulePulseOf({ rows: view.rows, history: [], arrived: new Set() })).toMatchObject({ work: null, buying: null });
  });

  it("changes only what is drawn: the track keeps the whole read's line, so the next whole read still says how it ended", () => {
    const track = held();
    pendingViewOf(track, latest());
    expect(track.lines[0]).toMatchObject({ key: "converting", active: true });
    const whole = vault("0", [liveEntry(signature(2), seconds(NOW_MS + 20_000), [converted]), WRAP], NOW_MS + 40_000);
    expect(advancePending(track, inputOf(whole), 1_000).done.get("converting")?.row.title).toBe(LIVE_COPY.pendingDone.convertedAt("12:00 UTC"));
  });

  it("draws the whole read's lines as they are while the newest snapshot agrees", () => {
    const track = held();
    const view = pendingViewOf(track, track.lines);
    expect(view.lines).toBe(track.lines);
    expect(headingOf(view.lines)).toBe(LIVE_COPY.pendingHeading.active);
    expect(nextWorkOf(view.rows)).toEqual({ kind: "converting", still: false });
  });

  it("heads the rows by the steps the page can vouch for", () => {
    const converting: PendingLine = { key: "converting", kind: "converting", active: true, rest: null, title: PENDING_COPY.converting, sub: "", amount: "$1.80", amountSpoken: "" };
    const buying = (active: boolean): PendingLine => ({ key: "buying", kind: "buying", active, rest: active ? null : "paused", title: "", sub: "", amount: "$5.00", amountSpoken: null });
    expect(headingOf([unconfirmedOf(converting), buying(false)])).toBe(LIVE_COPY.pendingHeading.waiting);
    expect(headingOf([unconfirmedOf(converting), buying(true)])).toBe(LIVE_COPY.pendingHeading.active);
    expect(headingOf([unconfirmedOf(converting)])).toBeNull();
  });
});

/**
 * WHO SAYS A STEP IS DONE (review, 10-09). The done row is out of what the
 * region reads because the announcer speaks its transaction — except where the
 * announcer marks no arrival: the history coming back from unreadable. There
 * the row was drawn done and nobody said it; now the row says it.
 */
describe("a done row, and who says it", () => {
  const CONVERT = liveEntry(signature(2), seconds(NOW_MS + 20_000), [converted], 4_100);
  const frame = (data: LiveDashboard, activityUnreadable = false): ArrivalFrame => ({ key: "owner", data, activityPending: false, activityUnreadable });
  /** The done row as drawn, with the signatures the announcer spoke. */
  const drawnAfter = (before: LiveDashboard, after: LiveDashboard, arrived: readonly string[]) => {
    const track = advancePending(startTrack(inputOf(before)), inputOf(after), 1_000);
    const view = toldBy(pendingViewOf(track, []), new Set(arrived));
    return { view, out: renderToStaticMarkup(createElement(PendingRows, { lines: view.lines, view })) };
  };

  it("leaves it to the announcer when the announcer spoke its transaction: one arrival, said once", () => {
    const before = converting();
    const after = vault("0", [CONVERT, WRAP], NOW_MS + 30_000);
    const arrived = arrivalsOf(baseOf(frame(before)), frame(after)).arrived.map((row) => row.signature);
    expect(arrived).toEqual([signature(2)]);
    const { view, out } = drawnAfter(before, after, arrived);
    expect(view.rows).toMatchObject([{ show: "done", key: "converting", told: true }]);
    expect(out).toMatch(/<div class="[^"]*" data-pending-done="converting" aria-hidden="true">/);
    // Nor does the region say it: once is the announcer's.
    expect(liveRegions(out)).toEqual(['<div role="status" aria-live="polite" class="sr-only" data-pending-region=""></div>']);
  });

  it("says it itself when the announcer did not: read N, a read with the history unreadable, then a whole one", () => {
    const n = converting();
    // The conversion lands while the history cannot be read: the snapshot alone, the rows kept.
    const n1 = vault("0", [WRAP], NOW_MS + 20_000);
    const n2 = vault("0", [CONVERT, WRAP], NOW_MS + 40_000);
    const first = arrivalsOf(baseOf(frame(n)), frame(n1, true));
    const second = arrivalsOf(first.base, frame(n2));
    // The history coming back into view marks nothing (use-arrivals.ts) — so the announcer is silent.
    expect(second.arrived).toEqual([]);
    // Yet the whole read N+2, against the whole read N, ended the step with its transaction: done.
    expect(doneOf(pendingSteps(n)[0]!, "converting", n2, n)).not.toBeNull();

    const { view, out } = drawnAfter(n, n2, second.arrived.map((row) => row.signature));
    expect(view.rows).toMatchObject([{ show: "done", key: "converting", told: false }]);
    expect(out).toMatch(/<div class="[^"]*" data-pending-done="converting">/);
    // The polite region says it, its title and its line, as the row did while it was the region.
    const [region] = liveRegions(out);
    expect(region).toContain(`<p><span class="block">${LIVE_COPY.pendingDone.convertedAt("12:00 UTC")}</span><span class="block">${LIVE_COPY.pendingDone.convertedSub}</span></p>`);
  });

  it("hands back the same view when no row is done, and leaves a row nobody judged as it was", () => {
    const view = viewOf(pendingLines(pendingSteps(converting()), NOW_MS));
    expect(toldBy(view, new Set())).toBe(view);
    // A done row drawn without toldBy (a caller that tracks no arrivals) stays out of the region, as before.
    const track = advancePending(startTrack(inputOf(converting())), inputOf(vault("0", [CONVERT, WRAP], NOW_MS + 30_000)), 1_000);
    const plain = pendingViewOf(track, []);
    const out = renderToStaticMarkup(createElement(PendingRows, { lines: plain.lines, view: plain }));
    expect(out).toMatch(/data-pending-done="converting" aria-hidden="true"/);
    expect(liveRegions(out)[0]).not.toContain(LIVE_COPY.pendingDone.converted);
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
    expect(out).toMatch(/^<div class="grid [^"]*lg:hidden" data-pending-steps="0">/);
    // The idle line is not news: not read out, and the card's region, still there, says nothing.
    expect(out).toMatch(/<p class="[^"]*" aria-hidden="true">Nothing in progress right now<\/p>/);
    expect(out).toMatch(/<div role="status" aria-live="polite" class="sr-only" data-pending-region=""><\/div><\/div>$/);
  });

  it("keep the card's box, and the region in it, out of the flow while there is nothing, and there to announce the first step", () => {
    expect(renderToStaticMarkup(createElement(PendingRows, { lines: [], variant: "card", className: "lg:hidden" }))).toBe(
      '<div class="sr-only lg:hidden" data-pending-steps="0"><div role="status" aria-live="polite" class="sr-only" data-pending-region=""></div></div>',
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

/**
 * THE WHY IN A "?", THE REGION BESIDE THE ROWS (owner, 10-10: "tiene mucho
 * texto"). The grey line under every step is gone from the screen: its
 * sentence sits in a "?" beside the title, read out with the button. A "?" is
 * a button, and no button may sit in a live region — so the rows are no longer
 * the region: a visually hidden one beside them says, word for word, what they
 * used to.
 */
describe("the why in a '?', and the region beside the rows", () => {
  const CONVERTING: ShownLine = { key: "converting", kind: "converting", active: true, rest: null, title: PENDING_COPY.converting, sub: PENDING_COPY.convertingSub("0.0235"), amount: "$3.12", amountSpoken: "" };
  const RESTING: ShownLine = { ...CONVERTING, active: false, rest: "paused", title: PENDING_COPY.convertingWaiting, sub: PENDING_COPY.rest.paused, amountSpoken: "0.0235 SOL" };
  const BUYING: ShownLine = { key: "buying", kind: "buying", active: false, rest: "paused", title: PENDING_COPY.buyingWaiting("SPYx"), sub: PENDING_COPY.rest.paused, amount: "$5.00", amountSpoken: null };
  const MEASURING: ShownLine = { key: "measuring:W", kind: "measuring", active: true, rest: null, title: PENDING_COPY.measuring("Trading wallet 1"), sub: PENDING_COPY.measuringSub.volume, amount: "", amountSpoken: "" };
  /** The same row while it was only heard: its own title, the step's sentence, and no step behind it. */
  const HEARD: ShownLine = { ...MEASURING, title: LIVE_COPY.heardLine.wallet("Trading wallet 1"), heard: true };
  const DONE: DoneLine = { key: "converting", kind: "converting", title: LIVE_COPY.pendingDone.convertedAt("14:32 UTC"), sub: LIVE_COPY.pendingDone.convertedSub, tone: "quiet", signatures: [signature(2)] };

  const lineRow = (line: ShownLine, leaving = false): PendingRow => ({ show: "line", key: line.key, kind: line.kind, line, still: false, leaving });
  const doneRow = (told: boolean | undefined, leaving = false): PendingRow => ({ show: "done", key: DONE.key, kind: DONE.kind, done: DONE, leaving, ...(told === undefined ? {} : { told }) });
  const view = (rows: readonly PendingRow[], held = false) => ({ lines: rows.flatMap((row) => (row.show === "line" && !row.leaving ? [row.line] : [])), rows, held });
  const drawn = (rows: readonly PendingRow[], over: { readonly variant?: "column" | "card"; readonly announce?: boolean } = {}) => {
    const shown = view(rows);
    return renderToStaticMarkup(createElement(PendingRows, { lines: shown.lines, view: shown, ...over }));
  };
  /** What a sighted reader sees: the markup without the region and without any screen-reader-only text. */
  const onScreen = (out: string): string => out.replace(/<div role="status"[^>]*>[\s\S]*?<\/div>/, "").replace(/<span class="sr-only">[^<]*<\/span>/g, "");
  const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const region = (...words: string[][]): string =>
    `<div role="status" aria-live="polite" class="sr-only" data-pending-region="">${words.map((said) => `<p>${said.map((word) => `<span class="block">${word}</span>`).join("")}</p>`).join("")}</div>`;

  it("draws no sentence under a step's title: it is in the '?' beside the title, in the button's own words", () => {
    const out = drawn([lineRow(MEASURING), lineRow(CONVERTING), lineRow(BUYING)]);
    for (const line of [MEASURING, CONVERTING, BUYING]) {
      expect(onScreen(out)).toContain(line.title);
      expect(onScreen(out)).not.toContain(line.sub);
      // The "?" sits right after the title, in the title's own box, and says the sentence to a screen reader.
      expect(out).toMatch(
        new RegExp(`<span class="min-w-0 text-sm (truncate|break-words)">${literal(line.title)}</span><button type="button"[^>]*><svg[\\s\\S]*?</svg><span class="sr-only">${literal(`${LIVE_COPY.pendingWhy}: ${line.sub}`)}</span></button>`),
      );
    }
    // The figures stay on screen.
    expect(onScreen(out)).toContain("$3.12");
    expect(onScreen(out)).toContain("$5.00");
    // No grey line of any kind is left under a step's title.
    expect(out).not.toMatch(/data-pending-step="[^"]*"[\s\S]*?<span class="block text-xs text-muted-foreground">/);
  });

  it("puts no '?' beside a step with no sentence", () => {
    const out = drawn([lineRow({ ...BUYING, sub: "" })]);
    expect(out).not.toContain("<button");
    expect(liveRegions(out)).toEqual([region([BUYING.title, "$5.00"])]);
  });

  it("says, in a region of its own, each step's title, its sentence and its amount as spoken — and holds no button and no countdown", () => {
    const out = drawn([lineRow(MEASURING), lineRow(RESTING), lineRow(BUYING)]);
    // The rows hold the "?"s…
    expect(out.match(/<button\b/g)).toHaveLength(3);
    // …and the one live region holds words only: the SOL in place of a conversion's re-priced dollars, a buy's USDC as drawn.
    expect(liveRegions(out)).toEqual([
      region([MEASURING.title, MEASURING.sub], [RESTING.title, RESTING.sub, "0.0235 SOL"], [BUYING.title, BUYING.sub, "$5.00"]),
    ]);
    expect(tickingInRegion(out)).toBe(false);
    // An active conversion's dollars are said by nobody.
    expect(liveRegions(drawn([lineRow(CONVERTING)]))).toEqual([region([CONVERTING.title, CONVERTING.sub])]);
  });

  it("never says a change heard, and keeps no '?' on it: its words are aria-hidden, and a button never sits inside aria-hidden", () => {
    const out = drawn([lineRow(HEARD)]);
    expect(out).toContain(`<span class="flex min-w-0 flex-1 items-start gap-1.5" aria-hidden="true"><span class="min-w-0 text-sm break-words">${HEARD.title}</span></span>`);
    expect(out).not.toContain("<button");
    expect(liveRegions(out)).toEqual([region()]);
    // The step that takes its row over joins the region under the row's key: an addition, as any step that joins.
    expect(saidOf([lineRow(HEARD)])).toEqual([]);
    expect(saidOf([lineRow(MEASURING)])).toEqual([{ key: "measuring:W", words: [MEASURING.title, MEASURING.sub] }]);
  });

  it("says a done row only when the announcer did not, under a key of its own, and nothing on its way out", () => {
    expect(saidOf([doneRow(false)])).toEqual([{ key: "done:converting", words: [DONE.title, DONE.sub] }]);
    expect(saidOf([doneRow(true)])).toEqual([]);
    // Drawn without toldBy: aria-hidden, as before, so not said.
    expect(saidOf([doneRow(undefined)])).toEqual([]);
    expect(saidOf([doneRow(false, true)])).toEqual([]);
    expect(saidOf([lineRow(CONVERTING, true)])).toEqual([]);
    // A step whose words change keeps its node: the same key, its text rewritten.
    expect(saidOf([lineRow(CONVERTING)])[0]?.key).toBe(saidOf([lineRow({ ...CONVERTING, sub: PENDING_COPY.convertingSub("0.03") })])[0]?.key);
  });

  it("says the same on the card as in the column, from the card's own box", () => {
    const rows = [lineRow(CONVERTING), lineRow(BUYING)];
    const column = drawn(rows);
    const card = drawn(rows, { variant: "card" });
    expect(liveRegions(card)).toEqual(liveRegions(column));
    // The region is the box's last child, beside what goes inert while it closes.
    expect(card).toMatch(/<\/div><div role="status" aria-live="polite" class="sr-only" data-pending-region="">[\s\S]*<\/div><\/div>$/);
  });

  it("draws no region at all on a copy that must not announce, in the column or on the card — the '?'s stay", () => {
    for (const variant of ["column", "card"] as const) {
      const out = drawn([lineRow(CONVERTING)], { variant, announce: false });
      expect(liveRegions(out)).toEqual([]);
      expect(out).not.toContain("data-pending-region");
      expect(out).toContain(`<span class="sr-only">${LIVE_COPY.pendingWhy}: ${CONVERTING.sub}</span>`);
    }
    expect(renderToStaticMarkup(createElement(PendingRows, { lines: [], announce: false }))).toBe('<div data-pending-steps="0"></div>');
  });
});
