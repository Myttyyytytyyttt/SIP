// The sample's rule card, which is now also the live one. Two faces, one file:
// with no signer it is the sample's exactly — local state, "Update rule" moves
// its own baseline — and with one, its controls reach a signature and say what
// that costs before the button is pressed.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SavingsRulePanel, type RuleSigner } from "@/components/savings-rule-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { SavingsRule, SavingsStats } from "@/mocks/types";

const STATS = { pendingUsd: 3, thresholdUsd: 5 } as SavingsStats;
const VOLUME: SavingsRule = { mode: "volume", rateBps: 200, thresholdUsd: 5, targets: [{ symbol: "SPYx", weightBps: 10_000 }], paused: false };
const PROFIT: SavingsRule = { ...VOLUME, mode: "profit", rateBps: 2_000 };

const signer = (overrides: Partial<RuleSigner> = {}): RuleSigner => ({
  rateMin: 201,
  rateMax: 10_000,
  presets: [1_000, 2_000, 5_000],
  thresholdLocked: null,
  thresholdProblem: () => null,
  busy: false,
  onUpdate: () => undefined,
  progress: null,
  ...overrides,
});

function render(rule: SavingsRule, options: { readonly signer?: RuleSigner; readonly stats?: SavingsStats } = {}): string {
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(SavingsRulePanel, {
        rule,
        stats: options.stats ?? STATS,
        activity: [],
        now: "2026-09-16T12:00:00.000Z",
        ...(options.signer === undefined ? {} : { signer: options.signer }),
      }),
    ),
  );
}

describe("the sample's own card, untouched", () => {
  it("names the sample's measure and its volume presets", () => {
    const html = render(VOLUME);
    expect(html).toContain("Applied to every buy and sell");
    for (const preset of ["0.5%", "1%", "2%"]) expect(html).toContain(`>${preset}<`);
  });

  it("carries no signature notice: nothing it does reaches a chain", () => {
    expect(render(VOLUME)).not.toMatch(/sign/i);
  });
});

describe("the live card", () => {
  it("names the vault's own measure and offers that mode's presets", () => {
    const html = render(PROFIT, { signer: signer() });
    expect(html).toContain("Applied to your realised trading gains");
    for (const preset of ["10%", "20%", "50%"]) expect(html).toContain(`>${preset}<`);
    expect(html).not.toContain(">0.5%<");
  });

  it("offers no update while a signature is under way anywhere on the page", () => {
    expect(render(PROFIT, { signer: signer({ busy: true }) })).toMatch(/aria-disabled="true"[^>]*>Update rule</);
  });

  it("locks the threshold with its reason, rather than offering a box that cannot be signed", () => {
    const html = render(PROFIT, { signer: signer({ thresholdLocked: "Investing is not set up." }) });
    expect(html).toContain("Investing is not set up.");
    expect(html).toMatch(/id="threshold"[^>]*disabled=""/);
  });

  it("measures the next investment by what is ready to buy with, not by everything pending", () => {
    const html = render(PROFIT, { signer: signer(), stats: { ...STATS, pendingUsd: 26, readyToInvestUsd: 4 } });
    expect(html).toContain("$4.00");
    expect(html).not.toContain("$26.00");
  });

  it("shows the signature's own progress under the button", () => {
    const html = render(PROFIT, { signer: signer({ progress: createElement("div", { "data-testid": "tx" }, "Waiting for Phantom") }) });
    expect(html).toContain("Waiting for Phantom");
  });
});
