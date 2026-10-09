// The Savings rule card (owner, 09-25): read-only on both pages, with a gear in
// its corner that opens "Vault settings". The sample hosts that dialog over its
// own state; a live page hands the card a door to its signing one. The card
// also says honestly when the last buy is older than the history on screen.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SavingsRulePanel, type RuleSettingsDoor } from "@/components/savings-rule-panel";
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
  options: { readonly settings?: RuleSettingsDoor; readonly stats?: SavingsStats; readonly activity?: readonly ActivityEvent[] } = {},
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
