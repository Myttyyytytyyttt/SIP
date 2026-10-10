// What Solana said changed, on the rows before any update brought it (plan B3,
// 10-09): a heard wallet's line under the very key its step takes, the vault's
// own line, and the track that turns one into the other without the row ever
// closing and growing back — through a read whose history failed, too. Through
// the REAL model: a snapshot, a page of history and the push's changes put
// through toLiveDashboard.

import { USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PendingRows, advancePending, nextDue, pendingRowsOf, releasePending, startTrack, type PendingInput } from "@/components/live/LivePending";
import { REVEAL_MS } from "@/components/live/Reveal";
import { VAULT_HEARD_KEY, checkedLineOf, heardLinesOf } from "@/components/live/heard-lines";
import { LIVE_COPY, PENDING_COPY } from "@/lib/live-copy";
import { toLiveDashboard } from "@/lib/live-model";
import { pendingLines, pendingSteps } from "@/lib/live-pending";
import type { PushHeard } from "@/lib/live-push";
import type { LiveDashboard, LiveWalletChange, VaultEventJson } from "@/lib/live-types";

import { NOW_MS, WALLET_A, liveActivity, liveEntry, liveSnapshot, seconds, signature, tokenAccount } from "../../../test/fixtures/live-dashboard";
import { liveRegions } from "../../../test/live-regions";

/** A slot past the fixture link's frontier (999): a trade nobody has measured yet. */
const TRADE_SLOT = 5_000;
const KEY = `measuring:${WALLET_A}`;
const wrapped = { kind: "wrapped", lamports: "18000000" } as VaultEventJson;

/**
 * The fixture's pension with nothing on its way — or, `converting`, SOL wrapped
 * a minute ago and its conversion under way — and the push's covered changes.
 */
function page(input: { readonly changes?: readonly LiveWalletChange[]; readonly paused?: boolean; readonly converting?: boolean; readonly nowMs?: number } = {}): LiveDashboard {
  const base = liveSnapshot();
  return toLiveDashboard({
    snapshot: liveSnapshot({
      readAtMs: input.nowMs ?? NOW_MS,
      vault: { ...base.vault, lamports: "1285240", withdrawableLamports: "0", state: { ...base.vault.state!, paused: input.paused ?? false } },
      vaultTokenAccounts: {
        status: "exists",
        items: input.converting === true ? [tokenAccount(WSOL_MINT, "18000000", "0.018", 9), tokenAccount(USDC_MINT, "0", "0", 6)] : [],
      },
    }),
    activity: liveActivity(input.converting === true ? [liveEntry(signature(1), seconds(NOW_MS - 60_000), [wrapped])] : []),
    privyWallets: [WALLET_A],
    walletChanges: input.changes ?? [],
  });
}

/** The same pension once an update covered the wallet's change: its step is up. */
const covered = (nowMs = NOW_MS + 10_000): LiveDashboard => page({ changes: [{ wallet: WALLET_A, slot: TRADE_SLOT, sinceMs: nowMs }], nowMs });

const linesOf = (data: LiveDashboard) => pendingLines(pendingSteps(data), data.nowMs);
const heardFrom = (wallets: readonly string[]): PushHeard => ({ at: 1, wallets });

/** What LiveBody hands the track for a settled `data`, with `heard` from the store. */
function inputOf(data: LiveDashboard, heard: PushHeard | null, behind = false): PendingInput {
  const steps = pendingSteps(data);
  const lines = pendingLines(steps, data.nowMs);
  return { data, steps, lines, heard: heardLinesOf({ heard, data, lines, behind }) };
}

describe("a trading wallet heard", () => {
  it("leads with its activity seen, under the very key its step will take, with that step's own line under it", () => {
    const data = page();
    const label = data.wallets[0]!.label;
    expect(linesOf(data)).toEqual([]);
    const heard = heardLinesOf({ heard: heardFrom([WALLET_A]), data, lines: [], behind: false });
    const step = linesOf(covered())[0]!;
    expect(step.key).toBe(KEY);
    expect(heard).toEqual([{ ...step, title: LIVE_COPY.heardLine.wallet(label), active: true, rest: null, heard: true }]);
    expect(heard[0]!.title).toBe(`Activity seen on ${label} · checking`);
  });

  it("says nothing of a wallet whose activity would never be checked: no row claims what no step can follow", () => {
    const paused = page({ paused: true });
    expect(checkedLineOf(paused, WALLET_A)).toBeNull();
    expect(checkedLineOf(page(), WALLET_A)?.key).toBe(KEY);
    expect(heardLinesOf({ heard: heardFrom([WALLET_A]), data: paused, lines: [], behind: false })).toEqual([]);
  });

  it("gives way to its step's line once that is drawn", () => {
    const data = covered();
    const lines = linesOf(data);
    expect(heardLinesOf({ heard: heardFrom([WALLET_A]), data, lines, behind: false })).toEqual([]);
  });

  it("is not on this page yet while the updates fail: the still clock of a wait, never 'checking'", () => {
    const data = page();
    const label = data.wallets[0]!.label;
    const [line] = heardLinesOf({ heard: heardFrom([WALLET_A]), data, lines: [], behind: true });
    expect(line).toMatchObject({ key: KEY, active: false, rest: "slow", title: LIVE_COPY.heardLine.walletBehind(label), heard: true });
    const out = renderToStaticMarkup(createElement(PendingRows, { lines: [line!] }));
    expect(out).not.toContain("data-work-loader");
    expect(out).toContain("lucide-clock");
    expect(out).not.toContain("· checking");
  });

  it("ignores an address the page lists no wallet for: there is no name to give it, and no step can follow", () => {
    expect(heardLinesOf({ heard: heardFrom(["Elsewhere1111111111111111111111111111111111"]), data: page(), lines: [], behind: false })).toEqual([]);
  });
});

describe("the vault heard", () => {
  it("has its own line when only the vault rang", () => {
    expect(heardLinesOf({ heard: heardFrom([]), data: page(), lines: [], behind: false })).toEqual([
      {
        key: VAULT_HEARD_KEY,
        kind: "vault",
        active: true,
        rest: null,
        title: LIVE_COPY.heardLine.vault,
        sub: LIVE_COPY.heardLine.vaultSub,
        amount: "",
        amountSpoken: "",
        heard: true,
      },
    ]);
  });

  it("has none while a conversion is under way: that step's turning mark already says the vault is about to move", () => {
    const data = page({ converting: true });
    const lines = linesOf(data);
    expect(lines.map((line) => [line.key, line.active])).toEqual([["converting", true]]);
    expect(heardLinesOf({ heard: heardFrom([]), data, lines, behind: false })).toEqual([]);
  });

  it("has none while something this page signed is still 'updating your pension': the vault rang for it, and its card says so (plan B4)", () => {
    expect(heardLinesOf({ heard: heardFrom([]), data: page(), lines: [], behind: false, signing: true })).toEqual([]);
    expect(heardLinesOf({ heard: heardFrom([]), data: page(), lines: [], behind: false, signing: false }).map((line) => line.key)).toEqual([VAULT_HEARD_KEY]);
    // A wallet's own activity is not the signature: its line stays.
    expect(heardLinesOf({ heard: heardFrom([WALLET_A]), data: page(), lines: [], behind: false, signing: true }).map((line) => line.key)).toEqual([KEY]);
  });

  it("has none when a wallet rang too: `heard` cannot say whether the vault did", () => {
    const lines = heardLinesOf({ heard: heardFrom([WALLET_A]), data: page(), lines: [], behind: false });
    expect(lines.map((line) => line.key)).toEqual([KEY]);
  });

  it("is not on this page yet while the updates fail, and nothing at all is drawn with nothing heard", () => {
    expect(heardLinesOf({ heard: heardFrom([]), data: page(), lines: [], behind: true })[0]).toMatchObject({
      active: false,
      rest: "slow",
      title: LIVE_COPY.heardLine.vaultBehind,
    });
    expect(heardLinesOf({ heard: null, data: page(), lines: [], behind: false })).toEqual([]);
  });
});

describe("the track: one row, from the change heard to its step", () => {
  it("keeps the row when the step takes over: same key, nothing leaving, nothing done", () => {
    const start = startTrack(inputOf(page(), heardFrom([WALLET_A])));
    expect(pendingRowsOf(start, new Set()).map((row) => row.key)).toEqual([KEY]);
    const next = advancePending(start, inputOf(covered(), null), 1_000);
    expect(next.leaving.size).toBe(0);
    expect(next.done.size).toBe(0);
    const rows = pendingRowsOf(next, new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ show: "line", key: KEY, leaving: false });
    expect(rows[0]!.show === "line" && rows[0]!.line.heard).toBeFalsy();
    expect(rows[0]!.show === "line" && rows[0]!.line.title).toBe(PENDING_COPY.measuring(page().wallets[0]!.label));
    expect(next.cardUntil).toBeNull();
  });

  it("keeps it through a read whose history failed — its wait, never a frame with neither — until the whole read brings the step (plan B5)", () => {
    const label = page().wallets[0]!.label;
    const start = startTrack(inputOf(page(), heardFrom([WALLET_A])));
    // That read covered no wallet's change (live-push.ts afterRead): still heard, and the page is behind.
    const behind = advancePending(start, inputOf(page(), heardFrom([WALLET_A]), true), 1_000);
    expect(behind.leaving.size).toBe(0);
    expect(pendingRowsOf(behind, new Set())).toMatchObject([{ show: "line", key: KEY, leaving: false, line: { active: false, title: LIVE_COPY.heardLine.walletBehind(label) } }]);
    // The next read lands whole: `heard` cleared in the very commit that brought the step, which takes the row in place.
    const caught = advancePending(behind, inputOf(covered(), null), 2_000);
    expect(caught.leaving.size).toBe(0);
    expect(caught.done.size).toBe(0);
    expect(pendingRowsOf(caught, new Set())).toMatchObject([{ show: "line", key: KEY, leaving: false, line: { title: PENDING_COPY.measuring(label) } }]);
  });

  it("closes a heard line with no step behind it when `heard` clears — the change was the saving itself — and holds the card", () => {
    const start = startTrack(inputOf(page(), heardFrom([WALLET_A])));
    const ended = advancePending(start, inputOf(page({ nowMs: NOW_MS + 10_000 }), null), 1_000);
    expect(ended.done.size).toBe(0);
    expect(pendingRowsOf(ended, new Set())).toMatchObject([{ show: "line", key: KEY, leaving: true, still: true }]);
    expect(nextDue(ended)).toBe(1_000 + REVEAL_MS);
    expect(releasePending(ended, 1_000 + REVEAL_MS).leaving.size).toBe(0);
    expect(ended.cardUntil).not.toBeNull();
  });

  it("moves on a change heard though the settled read did not, and not on the same lines made afresh", () => {
    const data = page();
    const start = startTrack(inputOf(data, null));
    const heard = advancePending(start, inputOf(data, heardFrom([]), false), 1_000);
    expect(heard).not.toBe(start);
    expect(pendingRowsOf(heard, new Set()).map((row) => row.key)).toEqual([VAULT_HEARD_KEY]);
    // LiveBody makes its heard lines anew at every render: equal lines are no change.
    expect(advancePending(heard, inputOf(data, heardFrom([]), false), 2_000)).toBe(heard);
    // The updates failing turns the same row to its wait.
    const behind = advancePending(heard, inputOf(data, heardFrom([]), true), 3_000);
    expect(pendingRowsOf(behind, new Set())).toMatchObject([{ key: VAULT_HEARD_KEY, leaving: false, line: { active: false, title: LIVE_COPY.heardLine.vaultBehind } }]);
  });
});

describe("drawn", () => {
  const label = page().wallets[0]!.label;
  const heardLine = heardLinesOf({ heard: heardFrom([WALLET_A]), data: page(), lines: [], behind: false })[0]!;

  it("turns like a step under way, for motion-safe only, and stands still with a ring of its own for reduced motion", () => {
    const out = renderToStaticMarkup(createElement(PendingRows, { lines: [heardLine] }));
    expect(out).toContain('data-pending-step="measuring" data-state="active" data-pending-heard=""');
    expect(out).toMatch(/<svg[^>]*class="[^"]*motion-safe:animate-spin[^"]*"[^>]*data-work-loader=""/);
    expect(out).not.toMatch(/class="[^"]*(?<!motion-safe:)animate-spin/);
    expect(out).toContain("motion-reduce:ring-1");
    // It grows and closes like any row: at once for reduced motion (Reveal.tsx).
    expect(out).toContain("motion-reduce:transition-none");
  });

  it("is not read out — the region has nothing for it, its words are aria-hidden, it has no '?' — and the step that takes its row over is", () => {
    const heard = renderToStaticMarkup(createElement(PendingRows, { lines: [heardLine] }));
    expect(heard).toContain(`<span class="flex min-w-0 flex-1 items-start gap-1.5 py-1.5" aria-hidden="true"><span class="min-w-0 text-sm break-words">${LIVE_COPY.heardLine.wallet(label)}</span></span>`);
    expect(heard).not.toContain("<button");
    expect(liveRegions(heard)).toEqual(['<div role="status" aria-live="polite" class="sr-only" data-pending-region=""></div>']);
    const lines = linesOf(covered());
    const step = renderToStaticMarkup(createElement(PendingRows, { lines }));
    // On screen: the title, its "?" beside it (owner, 10-10), not hidden.
    expect(step).toContain(
      `<span class="flex min-w-0 flex-1 items-start gap-1.5 py-1.5"><span class="min-w-0 text-sm break-words">${PENDING_COPY.measuring(label)}</span><span class="contents" data-pending-why=""><button type="button"`,
    );
    expect(step).not.toContain("data-pending-heard");
    // In the region: the step, its title and its sentence.
    expect(liveRegions(step)).toEqual([
      `<div role="status" aria-live="polite" class="sr-only" data-pending-region=""><p><span class="block">${PENDING_COPY.measuring(label)}</span><span class="block">${lines[0]!.sub}</span></p></div>`,
    ]);
  });

  it("draws the vault's line with no amount, wrapping rather than cut, after a wallet's and before the keeper's steps", () => {
    const vault = heardLinesOf({ heard: heardFrom([]), data: page(), lines: [], behind: false })[0]!;
    const out = renderToStaticMarkup(createElement(PendingRows, { lines: [vault] }));
    expect(out).toContain(`<span class="min-w-0 text-sm break-words">${LIVE_COPY.heardLine.vault}</span>`);
    expect(out).toContain('data-pending-step="vault" data-state="active" data-pending-heard=""');
    expect(out).not.toMatch(/font-mono[^"]*"[^>]*>\$/);
    // In the rows' own order, whatever order they were handed in.
    const converting = page({ converting: true });
    const track = startTrack({ data: converting, steps: pendingSteps(converting), lines: linesOf(converting), heard: [vault, heardLine] });
    expect(pendingRowsOf(track, new Set()).map((row) => row.kind)).toEqual(["measuring", "vault", "converting"]);
  });
});
