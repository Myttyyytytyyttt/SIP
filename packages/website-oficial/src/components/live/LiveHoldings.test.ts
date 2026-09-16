// What the vault holds. The rule under test: shares come from the RPC's own
// display amount, value comes from raw units at the pool rate, and the two are
// never derived from each other — SPYx is a scaledUiAmount mint.

import { SPYX_MINT } from "@sip/solana-core/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiveHoldings } from "@/components/live/LiveHoldings";
import { LIVE_COPY } from "@/lib/live-copy";
import type { LiveDashboard } from "@/lib/live-types";

import { liveDashboard, liveSnapshot, tokenAccount } from "../../../test/fixtures/live-dashboard";

function render(data: LiveDashboard): string {
  return renderToStaticMarkup(
    createElement(LiveHoldings, {
      holdings: data.holdings,
      worthNowUsdcRaw: data.worthNowUsdcRaw,
      notInvestedUsdcRaw: data.notInvestedUsdcRaw,
      tokensReadable: data.tokensReadable,
      pricesKnown: data.prices !== null,
    }),
  );
}

describe("shares and value come from different places, on purpose", () => {
  it("shows SPYx's shares as the RPC wrote them, never recomputed from raw units", () => {
    const html = render(liveDashboard());
    // The scaled display amount…
    expect(html).toContain("0.1241643");
    // …and NOT amountRaw / 10^decimals, which is what recomputing would give.
    expect(html).not.toContain("0.11345678");
  });

  it("values SPYx from its raw units at the pool rate: 11,345,678 x 761,709,474 / 1e8", () => {
    const html = render(liveDashboard());
    expect(html).toContain("$86.42");
  });
});

describe("a dollar column that cannot be trusted is not shown at all", () => {
  it("hides every value and says why when the pools could not be read", () => {
    const html = render(liveDashboard({ snapshot: liveSnapshot({ prices: null }) }));
    expect(html).toContain(LIVE_COPY.pricesUnreadableNote);
    // No row keeps a figure beside a total that says unavailable.
    expect(html).not.toContain("$86.42");
    expect(html).not.toContain("$20.00");
    // The amounts themselves are still known, and still shown.
    expect(html).toContain("0.1241643");
  });

  it("says the tokens could not be read, rather than showing a vault holding nothing", () => {
    const html = render(liveDashboard({ snapshot: liveSnapshot({ vaultTokenAccounts: { status: "unreadable", items: [] } }) }));
    expect(html).toContain(LIVE_COPY.tokensUnreadable);
  });
});

describe("what the table leaves out", () => {
  it("hides a token the vault holds none of", () => {
    const data = liveDashboard({
      snapshot: liveSnapshot({
        vaultTokenAccounts: { status: "exists", items: [tokenAccount(SPYX_MINT, "0", "0", 8)] },
      }),
    });
    const html = render(data);
    expect(html).not.toContain("SPYx");
  });

  it("notes the rent Solana keeps beside the SOL row, so the balance is not mistaken for spendable", () => {
    const html = render(liveDashboard());
    expect(html).toContain(LIVE_COPY.solKeptAsRent("0.00128524"));
  });

  it("names the legs' worth as a valuation, never as what was invested", () => {
    const html = render(liveDashboard());
    // The sum under the table is $86.42 of SPYx at today's price; the card's
    // hero shows lifetime_invested beside it. One word for both was the bug.
    expect(html).toContain(LIVE_COPY.invested);
    expect(html).toContain("$86.42");
    expect(LIVE_COPY.invested).toBe("Basket value");
  });

  it("points at Manage wallets for anything held elsewhere", () => {
    expect(render(liveDashboard())).toContain(LIVE_COPY.holdingsFootnote);
  });
});
