// The feed's colours (owner, 09-23): green for money the rule put aside, blue
// for the pension buying what it holds, mustard for the machinery and every
// change to it, red for what did not land, grey for the keeper's upkeep. The
// tint sits on the icon's square and on the amount — never on the words, so a
// row reads the same to someone who cannot tell the colours apart.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActivityRow } from "@/components/activity-row";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ActivityEvent, OtherEvent } from "@/mocks/types";

const NOW = "2026-09-23T12:00:00.000Z";
const BASE = { id: "x", at: "2026-09-23T11:00:00.000Z", txHash: "5nStUz377UpWNdnPDiex1111111111111111111111111", href: "https://solscan.io/tx/5nSt" };

const render = (event: ActivityEvent): string => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ActivityRow, { event, now: NOW })));

/** The icon's square: the first span inside the row. */
const tile = (html: string): string => /<span class="(flex size-8[^"]*)"/.exec(html)?.[1] ?? "";

const other = (icon: OtherEvent["icon"], extra: Partial<OtherEvent> = {}): ActivityEvent => ({ ...BASE, kind: "other", title: icon, sub: null, amount: "$1.00", icon, ...extra });

describe("what happened, by colour", () => {
  it("paints a settlement that put money aside green", () => {
    const html = render({ ...BASE, kind: "saved", from: "Trading wallet 1", basis: "25 % of $17.52 profit", savedUsd: 4.38 });
    expect(tile(html)).toContain("emerald");
    expect(html).toContain("+$4.38");
  });

  it("leaves a settlement that moved nothing grey: green means money put aside", () => {
    expect(tile(render({ ...BASE, kind: "saved", from: "Trading wallet 1", basis: "25 % of $0.00 profit", savedUsd: 0 }))).toContain("bg-muted");
  });

  it("paints a purchase for the pension blue", () => {
    const html = render({ ...BASE, kind: "invested", symbol: "SPYx", shares: 0.0075, priceUsd: 777.55, amountUsd: 5.88 });
    expect(tile(html)).toContain("blue");
    expect(html).toMatch(/text-blue-600[^"]*">\$5\.88</);
  });

  it("paints the machinery and every change to it mustard", () => {
    for (const icon of ["convert", "wrap", "rule", "policy", "link", "unlink", "withdraw", "receive", "vault"] as const) {
      expect(tile(render(other(icon))), icon).toContain("amber");
    }
  });

  it("paints what did not land red, and the keeper's upkeep grey", () => {
    expect(tile(render(other("failed", { failed: true })))).toContain("destructive");
    expect(tile(render(other("upkeep")))).toContain("bg-muted");
  });

  it("never colours the words themselves: the title reads the same in any colour", () => {
    const html = render(other("convert", { title: "Converted SOL to USDC" }));
    expect(html).toMatch(/<span class="truncate">Converted SOL to USDC<\/span>/);
  });
});
