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
      rentOnlyLamports: data.rentOnlyLamports,
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

  /**
   * The table reads the vault's own associated accounts, so a token held in any
   * other account is in no row and in none of the three sums. The fact stays;
   * it is on the heading rather than on a permanent line under the table.
   */
  it("says on its heading that a token held elsewhere is in none of these rows", () => {
    expect(render(liveDashboard())).toContain(LIVE_COPY.holdingsFootnote);
  });
});

/**
 * A ROW OF ZEROES IS NOT A HOLDING. wSOL, USDC and every leg already required a
 * positive balance; SOL did not, so a vault holding nothing but its own rent
 * led the table with "SOL — 0 — $0.00" and a line of rent jargon under it. The
 * rent is a real fact and is still stated — as one sentence, not as a row.
 */
describe("a vault whose SOL is all rent", () => {
  const rentOnly = (): LiveDashboard => {
    const base = liveSnapshot();
    return liveDashboard({
      snapshot: { ...base, vault: { ...base.vault, lamports: "1285240", withdrawableLamports: "0" } },
    });
  };

  it("draws no SOL row", () => {
    const data = rentOnly();
    expect(data.holdings.some((row) => row.kind === "sol")).toBe(false);
  });

  it("still says where the SOL went, in prose", () => {
    const data = rentOnly();
    expect(data.rentOnlyLamports).toBe(1_285_240n);
    expect(render(data)).toContain(LIVE_COPY.solRentOnly("0.00128524"));
  });

  it("keeps the row when there IS SOL to withdraw", () => {
    const data = liveDashboard();
    expect(data.holdings.some((row) => row.kind === "sol")).toBe(true);
    expect(data.rentOnlyLamports).toBeNull();
  });
});

/**
 * A BALANCE AT TODAY'S PRICE MAY LEAD IN DOLLARS; A WINDOW SUM MAY NOT.
 *
 * The distinction is the whole of how far the sample's clothes go. What the
 * vault HOLDS, valued at the price read in this same snapshot, is a fact about
 * now. What was SAVED across a past week, multiplied by today's price, is a
 * claim that dollars changed hands at rates nobody stored.
 */
describe("the totals under the table", () => {
  it("reads parts then total, and calls the unspent pile Pending", () => {
    const html = render(liveDashboard());
    const order = [LIVE_COPY.invested, LIVE_COPY.pending, LIVE_COPY.worthNow].map((label) => html.indexOf(label));
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    // "Not invested yet" belongs to the empty case now, not to a total.
    expect(html).not.toContain(`>${LIVE_COPY.notInvestedYet}<`);
  });
});
