// NEXT INVESTMENT ON A LIVE PAGE (NextInvestmentLive.tsx, 10-09, plan B1): the
// owner's "$0.00 of $1.00" beside "Pending $0.43", drawn from the data's own
// figure, gate and line. The card works the figures out; this only draws them —
// a mark beside the label for what is moving or what holds it, still segments
// for what the figure is made of, no bar for a figure nobody could make — and
// says the bar's value in words. Since 10-10 (owner: "tiene mucho texto") the
// data's note is in a "?" beside the label, not under the bar.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PendingRow } from "@/components/live/LivePending";
import { NextInvestmentLive, barValueText, nextMarkOf, nextWorkOf, rulePulseOf, segmentsOf, type NextWork } from "@/components/live/NextInvestmentLive";
import { SavingsRulePanel, type RuleSettingsDoor } from "@/components/savings-rule-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LIVE_COPY, PENDING_COPY } from "@/lib/live-copy";
import { toLiveDashboard } from "@/lib/live-model";
import type { PendingLine } from "@/lib/live-pending";
import type { LiveEntryJson, VaultEventJson } from "@/lib/live-types";
import type { SavingsRule, SavingsStats } from "@/mocks/types";

import { WALLET_A, liveActivity, liveEntry, liveSnapshot, seconds, signature, NOW_MS } from "../../../test/fixtures/live-dashboard";
import { liveRegions } from "../../../test/live-regions";

const DOOR: RuleSettingsDoor = { open: false, onOpen: () => undefined, attention: false };
const RULE: SavingsRule = { mode: "profit", rateBps: 2_000, thresholdUsd: 1, targets: [{ symbol: "SPYx", weightBps: 10_000 }], paused: false };
const BASE = { pendingUsd: 0.43, thresholdUsd: 1 } as SavingsStats;

/** THE OWNER'S CASE: $0.43 saved as SOL, under the 0.005 SOL line, no USDC, a $1.00 basket. */
const OWNERS: SavingsStats = {
  ...BASE,
  readyToInvestUsd: 0.43,
  toGoUsd: 0.97,
  nextInvestmentGate: "wrap_line",
  nextInvestmentNote: PENDING_COPY.includesWaiting("$0.43", "0.0028"),
  nextInvestmentParts: { usdc: 0, converting: 0, waiting: 0.43, held: 0 },
};

/** The card, as a live page draws it: its own figures, this block in its place. */
function card(stats: SavingsStats, work: NextWork | null = null): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(SavingsRulePanel, {
        rule: RULE,
        stats,
        activity: [],
        now: new Date(NOW_MS).toISOString(),
        settings: DOOR,
        renderNextInvestment: (next) => createElement(NextInvestmentLive, { next, work }),
      }),
    ),
  );
}

/** The Next investment block alone: from its label to the next one. */
const block = (html: string): string => html.slice(html.indexOf("Next investment"), html.indexOf("Last investment"));
const bar = (html: string): string => block(html).match(/<div role="progressbar"[^>]*>.*?<\/div>/)?.[0] ?? "";

const line = (over: Partial<PendingLine> & Pick<PendingLine, "kind" | "active">): PendingLine => ({
  key: over.kind,
  rest: null,
  title: over.kind === "buying" ? PENDING_COPY.buying("SPYx and ANTHROPIC") : PENDING_COPY.converting,
  sub: "",
  amount: "",
  amountSpoken: null,
  ...over,
});
const row = (pending: PendingLine, over: { readonly still?: boolean; readonly leaving?: boolean } = {}): PendingRow => ({
  show: "line",
  key: pending.key,
  kind: pending.kind,
  line: pending,
  still: over.still ?? false,
  leaving: over.leaving ?? false,
});

describe("the owner's case: SOL under the line", () => {
  it("draws the data's figure of the threshold, never $0.00 beside a pending pile", () => {
    const html = block(card(OWNERS));
    expect(html).toMatch(/\$0\.43 <span class="text-muted-foreground">of<\/span> \$1\.00/);
    expect(html).not.toContain("$0.00 of");
  });

  it("marks the label with the hourglass, and says why in the data's own note", () => {
    const html = block(card(OWNERS));
    expect(html).toContain('data-next-mark="gated"');
    expect(html).toContain("lucide-hourglass");
    expect(html).toContain(OWNERS.nextInvestmentNote!);
  });

  it("prints no dollars to go the line would contradict, and never $0.00 to go", () => {
    const html = block(card(OWNERS));
    expect(html).not.toContain("</span> to go");
    expect(html).not.toContain("$0.00");
  });

  it("draws the bar as SOL waiting, in its still grey, at the card's own fill", () => {
    const drawn = bar(card(OWNERS));
    expect(drawn).toContain('data-part="waiting"');
    expect(drawn).toContain("bg-muted-foreground/35");
    expect(drawn).toContain("width:43%");
    expect(drawn).not.toContain('data-part="usdc"');
  });

  it("says the bar's value in words a screen reader can read: the figure, then what it is made of", () => {
    const drawn = bar(card(OWNERS));
    expect(drawn).toContain(`aria-label="${LIVE_COPY.progressLabel}"`);
    expect(drawn).toContain('aria-valuemin="0"');
    expect(drawn).toContain('aria-valuemax="100"');
    expect(drawn).toContain('aria-valuenow="43"');
    expect(drawn).toContain('aria-valuetext="$0.43 of $1.00: $0.43 of SOL too small to convert yet"');
  });
});

/**
 * THE NOTE IS IN THE "?", NOT UNDER THE BAR (owner, 10-10: "tiene mucho
 * texto"). His screenshot: "$0.43 of $1.00", the bar, "$0.57 to go", and under
 * them "Includes about $0.43 of SOL too small to convert yet · It converts once
 * your savings add 0.0011 SOL". The figures stay; the sentence is one hover or
 * tap away.
 */
describe("the note, in a '?' beside the label", () => {
  /** The owner's screenshot: the to-go is the headline's own difference, so the card prints it. */
  const SCREENSHOT: SavingsStats = { ...OWNERS, toGoUsd: 0.57, nextInvestmentNote: PENDING_COPY.includesWaiting("$0.43", "0.0011") };

  it("draws no line under the bar: the note is the '?''s screen-reader text, and nowhere else", () => {
    const note = SCREENSHOT.nextInvestmentNote!;
    const html = block(card(SCREENSHOT));
    expect(html.split(note)).toHaveLength(2);
    expect(html).toContain(`<span class="flex" data-next-investment-note=""><button type="button"`);
    expect(html).toContain(`<span class="sr-only">${LIVE_COPY.nextInvestment}: ${note}</span></button></span>`);
    expect(html).not.toMatch(/<p class="text-xs text-muted-foreground"[^>]*>Includes/);
  });

  it("keeps every figure on screen: the label and its mark, the figure of the threshold, the bar, what is still to go", () => {
    const html = block(card(SCREENSHOT));
    // The "?" sits in the label's row, after the mark: the block is no taller for it.
    expect(html).toMatch(/^Next investment<\/p><span class="flex" data-next-mark="gated">[\s\S]*?<\/span><span class="flex" data-next-investment-note="">/);
    expect(html).toMatch(/\$0\.43 <span class="text-muted-foreground">of<\/span> \$1\.00/);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('<p class="text-xs text-muted-foreground"><span class="font-mono tabular-nums">$0.57</span> to go</p>');
  });

  it("draws no '?' with no note, and holds no live region, so a button there is never inside one", () => {
    const quiet = block(card({ ...SCREENSHOT, nextInvestmentNote: null }));
    expect(quiet).not.toContain("data-next-investment-note");
    expect(quiet).not.toContain("<button");
    expect(liveRegions(block(card(SCREENSHOT)))).toEqual([]);
  });
});

describe("a figure nobody could make", () => {
  it("is a dash of the threshold, with no bar at all, and the line that says why", () => {
    const note = PENDING_COPY.unknown.price;
    const html = block(card({ ...BASE, readyToInvestUsd: null, toGoUsd: null, nextInvestmentGate: "unknown", nextInvestmentNote: note, nextInvestmentParts: null }));
    expect(html).toMatch(/— <span class="text-muted-foreground">of<\/span> \$1\.00/);
    expect(html).not.toContain('role="progressbar"');
    // No to-go line of its own: the only "to go" is the line's.
    expect(html).not.toContain("</span> to go");
    expect(html).toContain(note.replaceAll("'", "&#x27;"));
    // "unknown" is the line's to say: no mark claims anything about it.
    expect(html).not.toContain("data-next-mark");
  });
});

describe("the mark beside the label", () => {
  it("turns for a conversion or a buy under way — blue for the buy — and wins over a gate", () => {
    expect(nextMarkOf({ kind: "converting", still: false }, null)).toEqual({ state: "active", tone: "quiet", still: false });
    expect(nextMarkOf({ kind: "buying", still: false }, null)).toEqual({ state: "active", tone: "invest", still: false });
    expect(nextMarkOf({ kind: "converting", still: true }, "wrap_line")).toEqual({ state: "active", tone: "quiet", still: true });
  });

  it("is the gate's own still glyph otherwise: hourglass, clock, pause — and nothing for the rest", () => {
    expect(nextMarkOf(null, "wrap_line")?.state).toBe("gated");
    expect(nextMarkOf(null, "slow")?.state).toBe("slow");
    expect(nextMarkOf(null, "held")?.state).toBe("held");
    for (const gate of ["conversion", "unknown", null] as const) expect(nextMarkOf(null, gate)).toBeNull();
  });

  it("turns only for those who allow motion, and stands still with the same words for those who do not", () => {
    const stats = { ...OWNERS, nextInvestmentGate: null, nextInvestmentNote: PENDING_COPY.includesConverting("$0.43") };
    const html = block(card(stats, { kind: "converting", still: false }));
    expect(html).toContain('data-next-mark="active"');
    expect(html).toContain("motion-safe:animate-spin");
    expect(html).not.toMatch(/(^|[\s"])animate-spin/);
    expect(block(card(stats, { kind: "converting", still: true }))).not.toContain("animate-spin");
  });

  it("adds no line to the block: it sits in the label's row, and the card is as tall with it as without", () => {
    const rows = (html: string): number => (block(html).match(/<p /g) ?? []).length;
    // The same figures under a gate that wears no mark ("unknown"): only the mark differs.
    const unmarked = card({ ...OWNERS, nextInvestmentGate: "unknown" });
    expect(block(unmarked)).not.toContain("data-next-mark");
    expect(rows(card(OWNERS))).toBe(rows(unmarked));
    expect(block(card(OWNERS))).toMatch(/^Next investment<\/p><span class="flex" data-next-mark="gated">/);
  });
});

describe("the bar's segments", () => {
  it("are one, at the card's fill, until every part is known", () => {
    expect(segmentsOf(40, null)).toEqual([{ part: "whole", width: 40 }]);
    expect(segmentsOf(40, { usdc: 0.2, converting: null, waiting: 0.2, held: 0 })).toEqual([{ part: "whole", width: 40 }]);
    expect(segmentsOf(0, { usdc: 0, converting: 0, waiting: 0, held: 0 })).toEqual([{ part: "whole", width: 0 }]);
  });

  it("share the card's fill by what the figure is made of, in order, and end exactly where it does — held short of full included", () => {
    const segments = segmentsOf(95, { usdc: 0.3, converting: 0.5, waiting: 0.391331, held: 0.2 });
    expect(segments.map((segment) => segment.part)).toEqual(["usdc", "converting", "waiting"]);
    expect(segments.reduce((sum, segment) => sum + segment.width, 0)).toBeCloseTo(95, 9);
    // Held SOL is pending but not in the figure: it is never drawn.
    expect(segments.some((segment) => (segment.part as string) === "held")).toBe(false);
  });

  it("never slide: no transition on a bar re-priced on every update", () => {
    const parts = { usdc: 0.3, converting: 0.5, waiting: 0.1, held: 0 };
    const drawn = bar(card({ ...OWNERS, readyToInvestUsd: 0.9, nextInvestmentGate: null, nextInvestmentParts: parts }));
    expect(drawn).toContain('data-part="usdc"');
    expect(drawn).toContain('data-part="converting"');
    expect(drawn).not.toMatch(/transition|animate/);
  });
});

describe("the bar's value in words", () => {
  const view = (parts: SavingsStats["nextInvestmentParts"] | null) => ({ readyUsd: 1.19, thresholdUsd: 1, parts: parts ?? null });

  it("is the headline alone while every dollar is USDC, or nothing says what it is made of", () => {
    expect(barValueText(view(null))).toBe("$1.19 of $1.00");
    expect(barValueText(view({ usdc: 1.19, converting: 0, waiting: 0, held: 0 }))).toBe("$1.19 of $1.00");
    // A fraction of a cent is not said as "$0.00 of SOL".
    expect(barValueText(view({ usdc: 1.19, converting: 0.001, waiting: null, held: 0 }))).toBe("$1.19 of $1.00");
  });

  it("names every part worth saying, in the line's words, with no separator a screen reader reads as 'dot'", () => {
    const text = barValueText(view({ usdc: 0.3, converting: 0.5, waiting: 0.39, held: 0 }));
    expect(text).toBe("$1.19 of $1.00: $0.30 in USDC, $0.50 of SOL on its way to USDC, $0.39 of SOL too small to convert yet");
    expect(text).not.toContain("·");
    expect(text).not.toMatch(/\b(keeper|read|poll|wrap|policy|RPC|socket)\b/i);
  });
});

describe("what LiveBody hands the card (rulePulseOf)", () => {
  const RULE_CHANGED = { kind: "rule_changed", mode: 0, skimBps: 1_000, volumeBps: 200, paused: false, maxContribution: null, walletReserve: null } as VaultEventJson;
  const history = (entries: readonly LiveEntryJson[]) =>
    toLiveDashboard({ snapshot: liveSnapshot(), activity: liveActivity(entries), privyWallets: [WALLET_A] }).rows;
  const changed = liveEntry(signature(21), seconds(NOW_MS - 10_000), [RULE_CHANGED], 4_500);

  it("names the work under way from the rows the steps draw: a buy before a conversion, never one on its way out", () => {
    const converting = row(line({ kind: "converting", active: true }));
    const buying = row(line({ kind: "buying", active: true }), { still: true });
    expect(nextWorkOf([converting])).toEqual({ kind: "converting", still: false });
    expect(nextWorkOf([converting, buying])).toEqual({ kind: "buying", still: true });
    expect(nextWorkOf([row(line({ kind: "converting", active: true }), { leaving: true })])).toBeNull();
    expect(nextWorkOf([row(line({ kind: "converting", active: false, rest: "slow" }))])).toBeNull();
  });

  it("says a buy under way in its step's own words, and nothing for a buy that waits", () => {
    const active = rulePulseOf({ rows: [row(line({ kind: "buying", active: true }))], history: [], arrived: new Set() });
    expect(active.buying).toEqual({ text: LIVE_COPY.buyingUnderWay(PENDING_COPY.buying("SPYx and ANTHROPIC")), still: false });
    expect(active.buying?.text).toBe("Buying SPYx and ANTHROPIC…");
    const waiting = rulePulseOf({ rows: [row(line({ kind: "buying", active: false, rest: "month_cap" }))], history: [], arrived: new Set() });
    expect(waiting.buying).toBeNull();
  });

  it("washes the rule line for a rule change that arrived and landed — not one that failed, nor one already shown", () => {
    const rows = history([changed]);
    expect(rulePulseOf({ rows: [], history: rows, arrived: new Set([changed.signature]) }).ruleArrived).toBe(true);
    expect(rulePulseOf({ rows: [], history: rows, arrived: new Set() }).ruleArrived).toBe(false);
    const failed = history([{ ...changed, ok: false }]);
    expect(rulePulseOf({ rows: [], history: failed, arrived: new Set([changed.signature]) }).ruleArrived).toBe(false);
  });
});
