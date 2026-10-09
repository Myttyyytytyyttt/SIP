// The Savings rule card (owner, 09-25): read-only on both pages, with a gear in
// its corner that opens "Vault settings". The sample hosts that dialog over its
// own state; a live page hands the card a door to its signing one. The card
// also says honestly when the last buy is older than the history on screen.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SavingsRulePanel, type NextInvestmentView, type RulePanelPulse, type RuleSettingsDoor } from "@/components/savings-rule-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LIVE_COPY } from "@/lib/live-copy";
import { SETTINGS_COPY } from "@/lib/settings-copy";
import type { ActivityEvent, SavingsRule, SavingsStats } from "@/mocks/types";

const NOW = "2026-09-24T12:00:00.000Z";
const STATS = { pendingUsd: 3, thresholdUsd: 10 } as SavingsStats;
const VOLUME: SavingsRule = { mode: "volume", rateBps: 200, thresholdUsd: 5, targets: [{ symbol: "SPYx", weightBps: 10_000 }], paused: false };
const PROFIT: SavingsRule = { ...VOLUME, mode: "profit", rateBps: 2_000 };

const door = (overrides: Partial<RuleSettingsDoor> = {}): RuleSettingsDoor => ({ open: false, onOpen: () => undefined, attention: false, ...overrides });

function render(
  rule: SavingsRule,
  options: {
    readonly settings?: RuleSettingsDoor;
    readonly stats?: SavingsStats;
    readonly activity?: readonly ActivityEvent[];
    readonly renderNextInvestment?: (next: NextInvestmentView) => ReturnType<typeof createElement>;
    readonly pulse?: RulePanelPulse;
  } = {},
): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(SavingsRulePanel, {
        rule,
        stats: options.stats ?? STATS,
        activity: options.activity ?? [],
        now: NOW,
        ...(options.settings === undefined ? {} : { settings: options.settings }),
        ...(options.renderNextInvestment === undefined ? {} : { renderNextInvestment: options.renderNextInvestment }),
        ...(options.pulse === undefined ? {} : { pulse: options.pulse }),
      }),
    ),
  );
}

/** The gear's own button. */
const gear = (html: string): string => html.match(/<button[^>]*aria-haspopup="dialog"[^>]*>/)?.[0] ?? "";

describe("the card shows the rule; the gear changes it", () => {
  it("has a gear in its corner, on the sample and on a live page", () => {
    expect(gear(render(VOLUME))).toContain(`aria-label="${SETTINGS_COPY.gear}"`);
    expect(gear(render(PROFIT, { settings: door() }))).toContain(`aria-label="${SETTINGS_COPY.gear}"`);
  });

  it("holds no control of its own: no slider, no presets, no threshold box, no Update button", () => {
    for (const html of [render(VOLUME), render(PROFIT, { settings: door() })]) {
      expect(html).not.toContain('role="slider"');
      expect(html).not.toContain('role="radio"');
      expect(html).not.toContain('id="threshold"');
      expect(html).not.toContain("Update rule");
    }
  });

  it("shows the rate, what it is taken from, and what the savings buy", () => {
    const html = render(PROFIT, { settings: door() });
    expect(html).toContain("Applied to your realised trading gains");
    expect(html).toContain(">20%<");
    expect(html).toContain(">SPYx<");
    expect(render(VOLUME)).toContain("Applied to every buy and sell");
  });

  it("says a paused rule is paused, next to its rate", () => {
    expect(render({ ...PROFIT, paused: true }, { settings: door() })).toContain(`>${SETTINGS_COPY.paused}<`);
  });

  it("says nothing is picked rather than an empty list", () => {
    expect(render({ ...PROFIT, targets: [] }, { settings: door() })).toContain(SETTINGS_COPY.nothingPicked);
  });

  it("marks the gear when something behind it needs the owner, and says so to a screen reader", () => {
    const html = gear(render(PROFIT, { settings: door({ attention: true }) }));
    expect(html).toContain(`aria-label="${SETTINGS_COPY.gearAttention}"`);
  });

  it("carries no signature wording on the sample: nothing it does reaches a chain", () => {
    expect(render(VOLUME)).not.toMatch(/sign/i);
  });

  it("measures the next investment by what is ready to buy with, not by everything pending", () => {
    const html = render(PROFIT, { settings: door(), stats: { ...STATS, pendingUsd: 26, readyToInvestUsd: 4 } });
    expect(html).toContain("$4.00");
    expect(html).not.toContain("$26.00");
  });
});

/**
 * NEXT INVESTMENT ON A LIVE PAGE, WHEN THE KEEPER WILL NOT BUY ON THE BAR
 * (owner, 2026-10-09). The bar counts SOL waiting under the keeper's wrap line;
 * the headline, the bar and the "to go" line must still agree, and none may
 * promise a buy that is not coming.
 */
describe("next investment, gated", () => {
  /** The Next investment block alone: from its label to the next one. */
  const nextBlock = (html: string): string => html.slice(html.indexOf("Next investment"), html.indexOf("Last investment"));
  /** The bar's fill, as the indicator draws it. */
  const fill = (html: string): string | undefined => nextBlock(html).match(/translateX\((-?[0-9.]+)%\)/)?.[1];
  const NOTE = "Includes about $0.39 of SOL. It converts to USDC once your vault holds 0.005 SOL (0.0011 SOL more)";
  const live = (stats: Partial<SavingsStats>): string =>
    render(PROFIT, { settings: door(), stats: { ...STATS, thresholdUsd: 1, nextInvestmentNote: NOTE, ...stats } as SavingsStats });

  it("keeps the dollars to go where they are the headline's own difference, gate or not", () => {
    const html = nextBlock(live({ readyToInvestUsd: 0.391331, toGoUsd: 0.608669, nextInvestmentGate: "wrap_line" }));
    expect(html).toMatch(/\$0\.39 <span class="text-muted-foreground">of<\/span> \$1\.00/);
    expect(html).toContain('<span class="font-mono tabular-nums">$0.61</span> to go');
    expect(html).toContain(NOTE);
  });

  it("stops the bar short of full, and prints no dollars to go that argue with the headline, while the line holds the buy", () => {
    const html = live({ readyToInvestUsd: 1.191331, toGoUsd: 0.108862, nextInvestmentGate: "wrap_line" });
    expect(nextBlock(html)).toMatch(/\$1\.19 <span class="text-muted-foreground">of<\/span> \$1\.00/);
    expect(fill(html)).toBe("-5");
    expect(nextBlock(html)).not.toContain("to go");
    expect(nextBlock(html)).toContain(NOTE);
  });

  it("never says $0.00 to go, or draws a full bar, under a conversion that is overdue", () => {
    const html = live({ readyToInvestUsd: 1.8, toGoUsd: 0, nextInvestmentGate: "slow", nextInvestmentNote: "Includes about $1.80 of SOL not converted yet" });
    expect(fill(html)).toBe("-5");
    expect(nextBlock(html)).not.toContain("to go");
    expect(nextBlock(html)).toContain("not converted yet");
  });

  it("never says $0.00 to go, or draws a full bar, while a rest the page can read holds a basket the USDC buys", () => {
    // Review 2026-10-09: the vault paused with $1.20 of USDC read "$0.00 to go" on a full bar, and nothing under it.
    const paused = "Your vault is paused: nothing is converted or bought until you resume it";
    const html = live({ readyToInvestUsd: 1.2, toGoUsd: 0, nextInvestmentGate: "held", nextInvestmentNote: paused });
    expect(fill(html)).toBe("-5");
    expect(nextBlock(html)).not.toContain("to go");
    expect(nextBlock(html)).toContain(paused);
  });

  it("never says $0.00 to go, or draws a full bar, on SOL that completes the basket only at today's price", () => {
    // Review 2026-10-09: the keeper buys on the USDC the conversion really brings, and it may fill under its quote.
    const decides = "Includes about $0.61 of SOL being converted to USDC · Enough to buy if the conversion lands near today's price";
    const html = live({ readyToInvestUsd: 1.005, toGoUsd: 0, nextInvestmentGate: "conversion", nextInvestmentNote: decides });
    expect(fill(html)).toBe("-5");
    expect(nextBlock(html)).not.toContain("to go");
    expect(nextBlock(html)).toContain(decides.replaceAll("'", "&#x27;"));
  });

  it("says no $0.00 to go under the line either, when what the line lacks is worth less than a cent", () => {
    const html = live({ readyToInvestUsd: 1.5, toGoUsd: 0, nextInvestmentGate: "wrap_line" });
    expect(fill(html)).toBe("-5");
    expect(nextBlock(html)).not.toContain("to go");
    // A fraction of a cent prints as $0.00 all the same.
    expect(nextBlock(live({ readyToInvestUsd: 0.999999, toGoUsd: 0.000001, nextInvestmentGate: "wrap_line" }))).not.toContain("to go");
  });

  it("fills the bar and says $0.00 to go when nothing gates the buy", () => {
    const html = live({ readyToInvestUsd: 1.8, toGoUsd: 0, nextInvestmentGate: null, nextInvestmentNote: null });
    expect(fill(html)).toBe("-0");
    expect(nextBlock(html)).toContain('<span class="font-mono tabular-nums">$0.00</span> to go');
  });

  it("takes a live page's to-go from the keeper's figure, not the threshold less the bar", () => {
    const html = nextBlock(live({ readyToInvestUsd: 0.2, toGoUsd: 0.75, nextInvestmentGate: null }));
    expect(html).toContain('<span class="font-mono tabular-nums">$0.75</span> to go');
  });
});

/**
 * A FIGURE NOBODY COULD MAKE (review 2026-10-09). A live page's figure is null
 * when an input it is made of could not be read; an empty bar under "— of
 * $1.00" read as nothing saved, and "— to go" as nothing left.
 */
describe("next investment, unknown", () => {
  const nextBlock = (html: string): string => html.slice(html.indexOf("Next investment"), html.indexOf("Last investment"));
  const UNKNOWN_NOTE = "Today's SOL price is unavailable, so what is still to go is not shown";
  const live = (stats: Partial<SavingsStats>): string => render(PROFIT, { settings: door(), stats: { ...STATS, thresholdUsd: 1, ...stats } as SavingsStats });

  it("draws no bar and no to-go for a null figure: the dash in the headline, and the line that says why", () => {
    const html = nextBlock(live({ readyToInvestUsd: null, toGoUsd: null, nextInvestmentGate: "unknown", nextInvestmentNote: UNKNOWN_NOTE }));
    expect(html).not.toContain('data-slot="progress"');
    expect(html).toMatch(/— <span class="text-muted-foreground">of<\/span> \$1\.00/);
    // No to-go line of its own: the only "to go" is the note's.
    expect(html).not.toContain("</span> to go");
    expect(html).toContain(UNKNOWN_NOTE.replaceAll("'", "&#x27;"));
  });

  it("draws no bar, and no '— to go', where there is no basket to measure", () => {
    const html = nextBlock(live({ readyToInvestUsd: null, toGoUsd: null, nextInvestmentGate: null, nextInvestmentNote: null }));
    expect(html).not.toContain('data-slot="progress"');
    expect(html).not.toContain("to go");
  });

  it("draws no bar, and no '— to go', for a basket the caps can never buy: a known figure with no threshold to measure it against", () => {
    // Review 2026-10-09: "$0.80 of —" drew an empty bar and "— to go" (live-pending.ts: unreachable → no threshold, no to-go, no gate).
    const stats = { readyToInvestUsd: 0.8, thresholdUsd: null, toGoUsd: null, nextInvestmentGate: null, nextInvestmentNote: null };
    const html = nextBlock(live(stats));
    expect(html).toMatch(/\$0\.80 <span class="text-muted-foreground">of<\/span> —/);
    expect(html).not.toContain('data-slot="progress"');
    expect(html).not.toContain("to go");
    const seen: NextInvestmentView[] = [];
    render(PROFIT, {
      settings: door(),
      stats: { ...STATS, ...stats } as SavingsStats,
      renderNextInvestment: (next) => {
        seen.push(next);
        return createElement("div");
      },
    });
    expect(seen[0]).toMatchObject({ readyUsd: 0.8, thresholdUsd: null, progress: null, toGoUsd: null, toGoShown: false, gate: null });
  });

  it("still draws the bar for a known figure of nothing: $0.00 is a figure", () => {
    const html = nextBlock(live({ readyToInvestUsd: 0, toGoUsd: 1, nextInvestmentGate: null }));
    expect(html).toContain('data-slot="progress"');
    expect(html).toContain('<span class="font-mono tabular-nums">$1.00</span> to go');
  });
});

/**
 * THE SAMPLE'S BLOCK, CHARACTER FOR CHARACTER. It sets none of the live
 * fields, so the card draws today's formulas: the pending pile of its own
 * threshold, a full-width bar, the difference to go.
 */
describe("next investment on the sample", () => {
  it("draws its pending pile of the threshold, the bar at that share, and the difference to go", () => {
    const html = render(VOLUME, { stats: { ...STATS, pendingUsd: 3 } });
    const block = html.slice(html.indexOf("Next investment"), html.indexOf("Last investment"));
    expect(block).toMatch(/\$3\.00 <span class="text-muted-foreground">of<\/span> \$5\.00/);
    expect(block).toContain("translateX(-40%)");
    expect(block).toContain('<span class="font-mono tabular-nums">$2.00</span> to go');
    expect(block).not.toContain("data-next-investment-note");
  });
});

/**
 * A LIVE PAGE DRAWS THE BLOCK ITSELF (renderNextInvestment): the marks beside
 * the label, the parts as segments, the line as a waiting note — from the
 * figures the card worked out, so the drawing does no arithmetic of its own.
 */
describe("next investment, drawn by a live page", () => {
  const PARTS = { usdc: 0.3, converting: 0.5, waiting: 0.391331, held: 0 };
  const STATS_LIVE = {
    ...STATS,
    thresholdUsd: 1,
    readyToInvestUsd: 1.191331,
    toGoUsd: 0.108862,
    nextInvestmentGate: "wrap_line",
    nextInvestmentNote: "Includes about $0.89 of SOL on its way to USDC",
    nextInvestmentParts: PARTS,
  } as SavingsStats;

  it("hands the slot the card's own figures, and puts what it returns in the block's place", () => {
    const seen: NextInvestmentView[] = [];
    const html = render(PROFIT, {
      settings: door(),
      stats: STATS_LIVE,
      renderNextInvestment: (next) => {
        seen.push(next);
        return createElement("div", { "data-drawn-by-live": "" }, "LIVE BLOCK");
      },
    });
    expect(seen).toEqual([
      {
        readyUsd: 1.191331,
        thresholdUsd: 1,
        progress: 95,
        toGoUsd: 0.108862,
        toGoShown: false,
        note: "Includes about $0.89 of SOL on its way to USDC",
        gate: "wrap_line",
        parts: PARTS,
      },
    ]);
    expect(html).toContain('<div data-drawn-by-live="">LIVE BLOCK</div>');
    // The block's own drawing is gone: the slot stands in its place.
    expect(html).not.toContain("Next investment");
    expect(html).not.toContain('data-slot="progress"');
    expect(html).toContain("Last investment");
  });

  it("hands no bar and no to-go for a null figure", () => {
    const seen: NextInvestmentView[] = [];
    render(PROFIT, {
      settings: door(),
      stats: { ...STATS_LIVE, readyToInvestUsd: null, toGoUsd: null, nextInvestmentGate: "unknown", nextInvestmentParts: { ...PARTS, waiting: null } },
      renderNextInvestment: (next) => {
        seen.push(next);
        return createElement("div");
      },
    });
    expect(seen[0]).toMatchObject({ readyUsd: null, progress: null, toGoShown: false, gate: "unknown", parts: { ...PARTS, waiting: null } });
  });

  it("is not asked on the sample, which never passes it", () => {
    expect(render(VOLUME)).toContain("Next investment");
  });
});

/**
 * THE LAST BUY, TOLD HONESTLY. The feed is one page of the newest
 * transactions; a buy older than that page is not "no investments yet" — the
 * vault's own counters record it.
 */
describe("last investment", () => {
  it("is 'No investments yet' on the sample, which sets none of the live fields", () => {
    expect(render(VOLUME)).toContain("No investments yet");
  });

  it("names the day and the spend of a buy older than the history on screen", () => {
    const html = render(PROFIT, {
      settings: door(),
      stats: { ...STATS, investedOutsideHistory: true, lastInvestedDay: { day: "2026-09-22", spentUsd: 16.964637 } },
    });
    expect(html).toContain(LIVE_COPY.olderThanHistory);
    expect(html).toContain("$16.96");
    expect(html).not.toContain("No investments yet");
  });

  it("says none is in the loaded history when the chain could not say whether it ever bought", () => {
    const html = render(PROFIT, { settings: door(), stats: { ...STATS, investedOutsideHistory: null } });
    expect(html).toContain(LIVE_COPY.noInvestmentLoaded);
    expect(html).not.toContain("No investments yet");
  });

  it("is 'No investments yet' only when the chain says it never bought", () => {
    expect(render(PROFIT, { settings: door(), stats: { ...STATS, investedOutsideHistory: false } })).toContain("No investments yet");
  });
});

/**
 * WHAT A LIVE PAGE HAS JUST SEEN MOVE ON THE CARD (10-09, plan B1): a buy under
 * way beside "Last investment", in the label's own line; the last buy's block
 * washed blue when it is the transaction that just arrived; the rate's line
 * washed mustard for a rule change that landed. All through `pulse`, which the
 * sample never passes.
 */
describe("the card's pulse on a live page", () => {
  const BUY: ActivityEvent = {
    kind: "invested",
    id: "buy",
    at: "2026-09-24T11:59:00.000Z",
    txHash: "BuySignature1111111111111111111111111111111111111111111111111111111111111111111111111",
    symbol: "SPYx",
    shares: 0.01,
    priceUsd: 600,
    amountUsd: 0.5,
  };
  const pulse = (over: Partial<RulePanelPulse> = {}): RulePanelPulse => ({ buying: null, arrived: new Set(), ruleArrived: false, ...over });
  /** The Last investment block alone: from its label to the end of the card's content. */
  const lastBlock = (html: string): string => html.slice(html.indexOf("Last investment") - 200);
  const rateLine = (html: string): string => html.slice(html.lastIndexOf("<div", html.indexOf(">Rate<")), html.indexOf(">Rate<"));

  it("keeps the sample's bare label, rate line and block: nothing washes, nothing is said", () => {
    const html = render(VOLUME, { activity: [BUY] });
    expect(html).toContain('<p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Last investment</p>');
    expect(html).not.toContain("live-wash");
    expect(html).not.toContain("data-buying");
    expect(rateLine(html)).toBe('<div class="flex items-center justify-between gap-2"><p class="text-sm leading-none font-medium"');
  });

  it("says a buy under way beside the label, in the label's own 16 px line, with a blue mark that turns only for motion-safe", () => {
    const html = render(PROFIT, { settings: door(), activity: [BUY], pulse: pulse({ buying: { text: "Buying SPYx and ANTHROPIC…", still: false } }) });
    const block = lastBlock(html);
    expect(block).toContain('<div class="flex h-4 min-w-0 items-center justify-between gap-2">');
    expect(block).toContain("Buying SPYx and ANTHROPIC…");
    expect(block).toMatch(/data-buying=""><svg[^>]*class="[^"]*motion-safe:animate-spin[^"]*"/);
    expect(block).toContain("text-blue-600");
    expect(block).not.toMatch(/(^|[\s"])animate-spin/);
  });

  it("draws the same 16 px line with nothing in it when no buy is under way: the card never grows or shrinks for one", () => {
    const html = render(PROFIT, { settings: door(), activity: [BUY], pulse: pulse() });
    expect(lastBlock(html)).toContain('<div class="flex h-4 min-w-0 items-center justify-between gap-2"><p class="text-xs font-medium uppercase tracking-wide text-muted-foreground shrink-0">Last investment</p></div>');
  });

  it("washes the last buy's block blue only when it is the transaction that just arrived", () => {
    const washed = render(PROFIT, { settings: door(), activity: [BUY], pulse: pulse({ arrived: new Set([BUY.txHash]) }) });
    expect(lastBlock(washed)).toMatch(/<button[^>]*class="[^"]*relative isolate[^"]*"[^>]*><span aria-hidden="true" class="live-wash" data-tone="invest"><\/span>/);
    const other = render(PROFIT, { settings: door(), activity: [BUY], pulse: pulse({ arrived: new Set(["SomethingElse"]) }) });
    expect(other).not.toContain("live-wash");
  });

  it("washes the rate line mustard for a rule change, reaching past the line so nothing in it moves", () => {
    const html = render(PROFIT, { settings: door(), pulse: pulse({ ruleArrived: true }) });
    const line = rateLine(html);
    expect(line).toContain("relative isolate");
    expect(line).toContain('class="live-wash" data-tone="setting" style="inset:-0.375rem -0.5rem"');
    expect(render(PROFIT, { settings: door(), pulse: pulse() })).not.toContain("live-wash");
  });
});
