// What the steps over the feed are drawn from (use-whole-read.ts, plan B5):
// every read lands whole and is drawn at once; the one that commits its
// snapshot alone, because its history could not be read, is not judged —
// the last whole read stands, its loaders still where that snapshot disagrees,
// until the next whole read. The pure core, then the track through the REAL
// model, then the hook.

import { WSOL_MINT, USDC_MINT } from "@sip/solana-core/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { advancePending, pendingRowsOf, startTrack, stillOf } from "@/components/live/LivePending";
import { useWholeRead, wholeReadOf, type StepsRead } from "@/components/live/use-whole-read";
import { LIVE_COPY, PENDING_COPY } from "@/lib/live-copy";
import { toLiveDashboard } from "@/lib/live-model";
import { pendingLines, pendingSteps } from "@/lib/live-pending";
import type { LiveDashboard, VaultEventJson } from "@/lib/live-types";

import { NOW_MS, liveActivity, liveEntry, liveSnapshot, seconds, settledEvent, signature, tokenAccount } from "../../../test/fixtures/live-dashboard";

/** A commit as LiveBody hands it over: its data (a tag to tell two apart), the read that made it, and whether that read brought its history. */
const read = (tag: string, readId: number, whole = true): StepsRead<{ readonly tag: string }> => ({ data: { tag }, readId, whole });

describe("wholeReadOf", () => {
  it("draws a read that landed whole at once: there is no second commit to wait for", () => {
    const first = read("read 1", 1);
    const next = read("read 2", 2);
    expect(wholeReadOf(first, next)).toBe(next);
  });

  it("draws the same read again when it is handed over anew: a push re-deriving it, an older page loaded under it", () => {
    const first = read("read 1", 1);
    const again = read("read 1, re-derived", 1);
    expect(wholeReadOf(first, again)).toBe(again);
  });

  it("keeps the last whole read through a later read whose history failed, and through every failed one after it", () => {
    const whole = read("read 1", 1);
    expect(wholeReadOf(whole, read("read 2, snapshot alone", 2, false))).toBe(whole);
    // Re-derived while it stands, and the next read failing the same way: still the whole one.
    expect(wholeReadOf(whole, read("read 2, re-derived", 2, false))).toBe(whole);
    expect(wholeReadOf(whole, read("read 3, snapshot alone", 3, false))).toBe(whole);
  });

  it("lets go of it at the next read that lands whole — no timer, no cap", () => {
    const whole = read("read 1", 1);
    const held = wholeReadOf(whole, read("read 2, snapshot alone", 2, false));
    const next = read("read 3", 3);
    expect(wholeReadOf(held, next)).toBe(next);
  });

  it("holds nothing with nothing whole to stand on: the first paint before its history, a first read whose history failed too", () => {
    const firstPaint = read("first paint", 0, false);
    const failed = read("read 1, snapshot alone", 1, false);
    expect(wholeReadOf(firstPaint, failed)).toBe(failed);
    const later = read("read 2, snapshot alone", 2, false);
    expect(wholeReadOf(failed, later)).toBe(later);
  });

  it("hands back the same object when nothing changed, so a render asking again is not told to render once more", () => {
    const first = read("read 1", 1);
    expect(wholeReadOf(first, { ...first })).toBe(first);
  });
});

/** The vault holding `wsol` lamports of wSOL and nothing else, over these rows, as read at `nowMs`. */
function vault(wsol: string, entries: ReturnType<typeof liveEntry>[], nowMs: number): LiveDashboard {
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

const WRAP = liveEntry(signature(1), seconds(NOW_MS - 60_000), [{ kind: "wrapped", lamports: "18000000" } as VaultEventJson]);
const CONVERT = liveEntry(signature(2), seconds(NOW_MS + 15_000), [{ kind: "converted", lamportsSpent: "18000000", usdcReceivedRaw: "1800000" } as VaultEventJson], 4_100);
const inputOf = (data: LiveDashboard) => {
  const steps = pendingSteps(data);
  return { data, steps, lines: pendingLines(steps, data.nowMs) };
};

describe("the steps through a read whose history failed (the one commit that is not whole)", () => {
  it("keep a conversion's row, its loader still, and claim nothing done — until the whole read brings the row that ended it", () => {
    const first = vault("18000000", [WRAP], NOW_MS);
    const track = startTrack(inputOf(first));
    expect(track.lines.map((line) => [line.key, line.active])).toEqual([["converting", true]]);

    // The next read: the wSOL is gone, and the history that would say where could not be read.
    const alone = vault("0", [WRAP], NOW_MS + 20_000);
    const shown = wholeReadOf({ data: first, readId: 1, whole: true }, { data: alone, readId: 2, whole: false });
    expect(shown.data).toBe(first);
    const held = advancePending(track, inputOf(shown.data), NOW_MS + 20_000);
    const still = stillOf(held.lines, pendingLines(pendingSteps(alone), alone.nowMs));
    expect(pendingRowsOf(held, still)).toMatchObject([{ show: "line", key: "converting", still: true, leaving: false }]);
    expect(held.done.size).toBe(0);
    // Judged off that commit, the step would have closed with nothing to say how it ended.
    expect(advancePending(track, inputOf(alone), NOW_MS + 20_000).leaving.has("converting")).toBe(true);

    // The next read lands whole with the conversion in it: done, and when.
    const whole = vault("0", [CONVERT, WRAP], NOW_MS + 40_000);
    const next = wholeReadOf(shown, { data: whole, readId: 3, whole: true });
    expect(next.data).toBe(whole);
    const done = advancePending(held, inputOf(next.data), NOW_MS + 40_000);
    expect(done.done.get("converting")?.row.title).toBe(LIVE_COPY.pendingDone.convertedAt("12:00 UTC"));
  });

  it("never times a step off a history that read could not update: no 'Not done since' over a saving it did not get", () => {
    // Two hours ago, the last saving the page has read; nothing on its way.
    const old = liveEntry(signature(3), seconds(NOW_MS - 2 * 3_600_000), [settledEvent("18000000")], 3_000);
    const quiet = vault("0", [old], NOW_MS);
    expect(inputOf(quiet).lines).toEqual([]);
    // A new saving landed and was wrapped; this read's history failed, so the page cannot see it.
    const alone = vault("18000000", [old], NOW_MS + 20_000);
    expect(inputOf(alone).lines[0]?.sub).toBe(PENDING_COPY.slow("10:00 UTC"));
    const shown = wholeReadOf({ data: quiet, readId: 1, whole: true }, { data: alone, readId: 2, whole: false });
    expect(inputOf(shown.data).lines).toEqual([]);
    // The whole read brings the saving a minute ago: the conversion is under way, as it is.
    const saving = liveEntry(signature(4), seconds(NOW_MS - 60_000), [settledEvent("18000000")], 4_100);
    const whole = vault("18000000", [saving, old], NOW_MS + 40_000);
    expect(inputOf(wholeReadOf(shown, { data: whole, readId: 3, whole: true }).data).lines.map((line) => [line.key, line.active])).toEqual([["converting", true]]);
  });
});

describe("useWholeRead", () => {
  it("hands back the data it is given on the page's first paint, as the newest", () => {
    const data = { tag: "first" };
    let seen: { readonly data: unknown; readonly newest: boolean } | null = null;
    function Probe() {
      seen = useWholeRead(data, { readId: 1, whole: true });
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toEqual({ data, newest: true });
  });
});
