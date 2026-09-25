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
