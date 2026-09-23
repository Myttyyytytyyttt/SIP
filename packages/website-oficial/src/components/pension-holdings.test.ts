// What the pension holds — the sample's table, drawing a live vault through the
// adapter. The rule that came with it from the live table: shares are the
// RPC's own display amount, value is raw units at the pool rate, and the two
// are never derived from each other — SPYx is a scaledUiAmount mint.

import { SPYX_MINT } from "@sip/solana-core/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PensionHoldings } from "@/components/pension-holdings";
import { LIVE_COPY } from "@/lib/live-copy";
import { toDashboardMock } from "@/lib/live-mock";
import type { LiveDashboard } from "@/lib/live-types";

import { liveDashboard, liveSnapshot, tokenAccount } from "../../test/fixtures/live-dashboard";

/** What a person reads: the markup with its tags taken away. A figure's tail is a span of its own. */
const seen = (html: string): string => html.replace(/<[^>]*>/g, "");

function render(data: LiveDashboard): string {
  const page = toDashboardMock(data, { complete: false });
  return renderToStaticMarkup(createElement(PensionHoldings, { holdings: page.holdings, rule: page.rule, stats: page.stats }));
}

describe("shares and value come from different places, on purpose", () => {
  it("shows SPYx's shares as the RPC wrote them, never recomputed from raw units", () => {
    const html = render(liveDashboard());
    // The scaled display amount, every digit of it…
    expect(seen(html)).toContain("0.1241643");
    // …and NOT amountRaw / 10^decimals, which is what recomputing would give.
    expect(seen(html)).not.toContain("0.11345678");
  });

  it("values SPYx from its raw units at the pool rate: 11,345,678 x 761,709,474 / 1e8", () => {
    expect(render(liveDashboard())).toContain("$86.42");
  });
});

describe("the sample's table, with the sample's rows", () => {
  /** The basket, as the sample lists it; the cash is the Pending total underneath, not rows. */
  it("lists the basket's legs and none of the vault's cash", () => {
    const html = seen(render(liveDashboard()));
    expect(html).toContain("SPYx");
    expect(html).not.toMatch(/\bwSOL\b|\bUSDC\b/);
  });

  it("totals the sample's way: what the basket holds, what waits to be invested, and the two together", () => {
    const html = render(liveDashboard());
    const order = ["Holdings", "Pending", "Pension"].map((label) => html.indexOf(`>${label}<`));
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  /**
   * A LEG THE POLICY NAMES AND THE VAULT HOLDS NONE OF is a real row with
   * nothing in it — as the sample lists every target. Only when the token list
   * was read: otherwise "nothing" would be a guess.
   */
  it("shows a policy leg the vault holds none of as a zero row", () => {
    const data = liveDashboard({ snapshot: liveSnapshot({ vaultTokenAccounts: { status: "exists", items: [tokenAccount(SPYX_MINT, "0", "0", 8)] } }) });
    const page = toDashboardMock(data, { complete: false });
    expect(page.holdings.map((holding) => [holding.symbol, holding.shares, holding.targetWeightBps])).toEqual([["SPYx", 0, 10_000]]);
  });
});

describe("what the table cannot know, it says it does not know", () => {
  it("hides every dollar and says why when the pools could not be read", () => {
    const html = render(liveDashboard({ snapshot: liveSnapshot({ prices: null }) }));
    expect(html).toContain(LIVE_COPY.pricesUnreadableNote);
    // No row keeps a figure beside a total that says unavailable.
    expect(html).not.toContain("$86.42");
    // The amounts themselves are still known, and still shown.
    expect(seen(html)).toContain("0.1241643");
  });

  it("says the tokens could not be read, rather than showing a vault holding nothing", () => {
    const html = render(liveDashboard({ snapshot: liveSnapshot({ vaultTokenAccounts: { status: "unreadable", items: [] } }) }));
    expect(html).toContain(LIVE_COPY.tokensUnreadable);
    expect(html).not.toContain("No investments yet");
  });

  it("names a basket with nothing bought yet as exactly that", () => {
    const html = render(
      liveDashboard({ snapshot: liveSnapshot({ vaultTokenAccounts: { status: "exists", items: [] }, policy: { status: "missing", address: "p" } }) }),
    );
    expect(html).toContain("No investments yet");
  });
});
