// The feed's colours (owner, 09-23). Green for money coming in — a slice the
// rule put aside, SOL that arrived; blue for the pension buying what it holds;
// mustard ONLY for a change to how the pension behaves (a rule, a policy, a
// link, the vault itself); grey for the system doing its job (a conversion, a
// wrap, the keeper's upkeep, a settlement that found nothing); red, kept rare,
// for what did not land. The tint sits on the icon's square and on the amount —
// never on the words, so a row reads the same to someone who cannot tell the
// colours apart. Behind the glyph, faintly, the marks of what the transaction
// touched.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActivityRow } from "@/components/activity-row";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ActivityEvent, OtherEvent } from "@/mocks/types";

const NOW = "2026-09-23T12:00:00.000Z";
const BASE = { id: "x", at: "2026-09-23T11:00:00.000Z", txHash: "5nStUz377UpWNdnPDiex1111111111111111111111111", href: "https://solscan.io/tx/5nSt" };

const render = (event: ActivityEvent, order?: number): string =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ActivityRow, { event, now: NOW, ...(order === undefined ? {} : { order }) })));

/** The icon's square: the first span inside the row. */
const tile = (html: string): string => /<span class="(relative flex size-8[^"]*)"/.exec(html)?.[1] ?? "";

/** Everything inside the square, glyph and backdrop both. */
const square = (html: string): string => /<span class="relative flex size-8[^"]*">([\s\S]*?)<\/span><span class="min-w-0/.exec(html)?.[1] ?? "";

const other = (icon: OtherEvent["icon"], extra: Partial<OtherEvent> = {}): ActivityEvent => ({ ...BASE, kind: "other", title: icon, sub: null, amount: "$1.00", icon, ...extra });

describe("what happened, by colour", () => {
  it("paints a settlement that put money aside green", () => {
    const html = render({ ...BASE, kind: "saved", from: "Trading wallet 1", basis: "25 % of $17.52 profit", savedUsd: 4.38 });
    expect(tile(html)).toContain("emerald");
    expect(html).toContain("+$4.38");
  });

  it("leaves a settlement that moved nothing grey: green means money put aside", () => {
    const html = render({ ...BASE, kind: "saved", from: "Trading wallet 1", basis: "25 % of $0.00 profit", savedUsd: 0 });
    expect(tile(html)).toContain("bg-muted");
    expect(tile(html)).not.toContain("emerald");
    expect(html).toMatch(/text-muted-foreground">\+?\$0\.00</);
  });

  it("leaves a sample fill that put nothing aside grey too", () => {
    const html = tile(render({ ...BASE, kind: "trade", tradeId: "t1", side: "buy", symbol: "SOL", notionalUsd: 100, savedUsd: 0, rateBps: 2_000 }));
    expect(html).toContain("bg-muted");
  });

  it("paints SOL that arrived green: money coming in", () => {
    const html = render(other("receive", { title: "Received SOL", amount: "+$12.00" }));
    expect(tile(html)).toContain("emerald");
    expect(html).toMatch(/text-emerald-[^"]*">\+\$12\.00</);
  });

  it("paints a purchase for the pension blue", () => {
    const html = render({ ...BASE, kind: "invested", symbol: "SPYx", shares: 0.0075, priceUsd: 777.55, amountUsd: 5.88 });
    expect(tile(html)).toContain("blue");
    expect(html).toMatch(/text-blue-600[^"]*">\$5\.88</);
  });

  it("paints a change to how the pension behaves mustard, and only that", () => {
    for (const icon of ["rule", "policy", "link", "unlink", "vault"] as const) {
      const html = render(other(icon));
      expect(tile(html), icon).toContain("amber");
      expect(html, icon).toMatch(/text-amber-700[^"]*">\$1\.00</);
    }
  });

  it("leaves the system doing its job grey: conversions, wraps, withdrawals, upkeep", () => {
    for (const icon of ["convert", "wrap", "withdraw", "upkeep", "other"] as const) {
      const html = render(other(icon));
      expect(tile(html), icon).toContain("bg-muted");
      expect(tile(html), icon).not.toContain("amber");
      // Muted, never the page's ink: plain white would be the loudest figure in a dark column.
      expect(html, icon).toMatch(/text-muted-foreground">\$1\.00</);
    }
  });

  it("keeps red for what did not land", () => {
    expect(tile(render(other("failed", { failed: true })))).toContain("destructive");
    expect(tile(render(other("convert", { failed: true })))).toContain("destructive");
  });

  it("uses those five tones and no others", () => {
    const events: ActivityEvent[] = [
      { ...BASE, kind: "saved", from: "w", basis: "b", savedUsd: 0 },
      { ...BASE, kind: "saved", from: "w", basis: "b", savedUsd: 1 },
      { ...BASE, kind: "invested", symbol: "SPYx", shares: 1, priceUsd: 1, amountUsd: 1 },
      ...(["wrap", "convert", "withdraw", "vault", "rule", "policy", "link", "unlink", "receive", "upkeep", "other"] as const).map((icon) => other(icon)),
      other("failed", { failed: true }),
    ];
    for (const event of events) {
      const cls = tile(render(event));
      expect(/emerald|blue|amber|bg-muted|destructive/.test(cls), `${event.kind}: ${cls}`).toBe(true);
    }
  });

  it("never colours the words themselves: the title reads the same in any colour", () => {
    const html = render(other("convert", { title: "Converted SOL to USDC" }));
    expect(html).toMatch(/<span class="truncate">Converted SOL to USDC<\/span>/);
  });
});

describe("what the square shows behind its glyph", () => {
  it("puts SOL on one side and USDC on the other behind a conversion, faint, and hidden from readers", () => {
    const html = square(render(other("convert", { backdrop: { logos: ["/tokens/sol.png", "/tokens/usdc.png"] } })));
    const marks = [...html.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
    expect(marks).toHaveLength(2);
    expect(marks[0]).toContain("sol.png");
    expect(marks[0]).toContain("-left-2");
    expect(marks[1]).toContain("usdc.png");
    expect(marks[1]).toContain("-right-2");
    for (const m of marks) {
      expect(m).toContain("opacity-25");
      expect(m).toContain('aria-hidden="true"');
      expect(m).toContain('alt=""');
    }
  });

  it("lets a single mark peek from the corner, leaving the square its colour", () => {
    const html = square(render(other("wrap", { backdrop: { logos: ["/tokens/sol.png"] } })));
    const marks = [...html.matchAll(/<img[^>]*>/g)].map((m) => m[0]);
    expect(marks).toHaveLength(1);
    expect(marks[0]).toContain("-right-1.5");
    expect(marks[0]).toContain("-bottom-1.5");
  });

  it("writes the figure a rule change set behind its glyph", () => {
    const html = square(render(other("rule", { backdrop: { text: "25%" } })));
    expect(html).toMatch(/aria-hidden="true"[^>]*>25%<\/span>/);
  });

  it("puts the asset a sample purchase bought behind its piggy bank", () => {
    const html = square(render({ ...BASE, kind: "invested", symbol: "SPYx", shares: 1, priceUsd: 1, amountUsd: 1 }));
    expect(html).toMatch(/<img[^>]*opacity-25/);
  });

  it("shows nothing behind a glyph whose row brought no backdrop", () => {
    expect(square(render(other("link")))).not.toContain("<img");
  });

  it("keeps the words out of the backdrop: the row's name is the title, not the art", () => {
    const html = render(other("convert", { title: "Converted SOL to USDC", backdrop: { logos: ["/tokens/sol.png", "/tokens/usdc.png"] } }));
    expect(html).toContain('aria-label="Converted SOL to USDC · Open on Solscan');
  });
});

describe("the row's entrance", () => {
  it("rises in only when the feed gives it a place, a short beat after the one above", () => {
    expect(render(other("link"))).not.toContain("rise-in");
    const third = render(other("link"), 2);
    expect(third).toContain("rise-in");
    expect(third).toContain("--rise:70ms");
  });

  it("caps the cascade, so a long feed never waits seconds for its last rows", () => {
    expect(render(other("link"), 400)).toContain("--rise:420ms");
  });
});
