// One row of a vault's history: what it says, what it links to, and what it
// refuses to imply. The SAVED accent is the thing under test — it means money
// put aside, and exactly one kind of row may wear it.

import { SPYX_MINT } from "@sip/solana-core/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiveActivityRow, partsOf } from "@/components/live/LiveActivityRow";
import { SAVED } from "@/lib/classes";
import { ACTIVITY_COPY } from "@/lib/live-copy";
import type { LiveRow, VaultEventJson } from "@/lib/live-types";

import { WALLET_A, signature } from "../../../test/fixtures/live-dashboard";

const SIG = signature(3);
const MAX_CONTRIBUTION = 60_000_000n;

const labelOf = (wallet: string | null): string => (wallet === WALLET_A ? "Trading wallet 1" : ACTIVITY_COPY.someWallet);

const settled = (paid: string, capped = false, owed = paid): VaultEventJson =>
  ({
    kind: "settled",
    wallet: WALLET_A,
    mode: 0,
    baseLamports: "500000000",
    bps: 2_000,
    owed,
    paid,
    capped,
    settlementNonce: "0",
    linkEpoch: "12",
    sessionStartSlot: "200",
    sessionEndSlot: "220",
  }) as VaultEventJson;

function row(event: VaultEventJson, overrides: Partial<LiveRow> = {}): LiveRow {
  return {
    signature: SIG,
    at: new Date(Date.UTC(2026, 8, 16, 11, 0, 0)).toISOString(),
    blockTime: Math.floor(Date.UTC(2026, 8, 16, 11, 0, 0) / 1_000),
    ok: true,
    explorerUrl: `https://solscan.io/tx/${SIG}`,
    event,
    ...overrides,
  };
}

const render = (event: VaultEventJson, overrides: Partial<LiveRow> = {}): string =>
  renderToStaticMarkup(createElement(LiveActivityRow, { row: row(event, overrides), labelOf, maxContribution: MAX_CONTRIBUTION }));

describe("where a row goes", () => {
  it("opens that transaction on Solscan, in a new tab, without handing it this page", () => {
    const html = render(settled("60000000"));
    expect(html).toContain(`href="https://solscan.io/tx/${SIG}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("renders NO link when the signature cannot make one, rather than a URL that goes nowhere", () => {
    const html = render(settled("60000000"), { explorerUrl: null });
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("solscan.io");
  });
});

describe("only a real saving wears the accent", () => {
  it("a settlement that paid says so, in the SAVED colour", () => {
    const html = render(settled("60000000"));
    expect(html).toContain(ACTIVITY_COPY.settled("0.06"));
    expect(html).toContain(SAVED.split(" ")[0]!);
  });

  it("a settlement that moved nothing says so, and is muted", () => {
    const html = render(settled("0"));
    expect(html).toContain(ACTIVITY_COPY.settledNothing);
    expect(html).not.toContain(ACTIVITY_COPY.settled("0"));
    // The zero row must not carry the accent that means money was put aside.
    const parts = partsOf(settled("0"), labelOf, MAX_CONTRIBUTION);
    expect(parts.amountClass).toBe("text-muted-foreground");
  });

  it("a CAPPED settlement says what was owed and what the cap kept — muted, never as a saving", () => {
    const note = ACTIVITY_COPY.settledCapped("0.1", "0.06");
    const html = render(settled("60000000", true, "100000000"));
    expect(html).toContain(note);
    // The owed line sits in a muted span, not the SAVED one.
    expect(html).toMatch(new RegExp(`<span class="[^"]*text-muted-foreground[^"]*">${note.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("a failed transaction is muted and badged, and claims nothing was saved", () => {
    const html = render(settled("60000000"), { ok: true, event: { kind: "failed", instructions: ["settle_v2"] } as VaultEventJson });
    expect(html).toContain(ACTIVITY_COPY.failedBadge);
    expect(partsOf({ kind: "failed", instructions: [] } as VaultEventJson, labelOf, null).failed).toBe(true);
  });
});

describe("what the chain has no words for", () => {
  it("SOL that merely arrived is a transfer, never a saving", () => {
    const html = render({ kind: "received_sol", lamports: "5000000" } as VaultEventJson);
    expect(html).toContain(ACTIVITY_COPY.receivedSol("0.005"));
    expect(html).toContain(ACTIVITY_COPY.receivedSub);
    expect(html).not.toContain("Saved");
  });

  it("names a token from its MINT, because the event carries no symbol", () => {
    const html = render({ kind: "withdrew_token", mint: SPYX_MINT, amountRaw: "1000000", uiAmount: "0.0109" } as VaultEventJson);
    expect(html).toContain(ACTIVITY_COPY.withdrewToken("0.0109", "SPYx"));
  });

  it("says `tokens` for a mint it does not know, rather than inventing a ticker", () => {
    const html = render({ kind: "withdrew_token", mint: "Unknown1111111111111111111111111111111111111", amountRaw: "1", uiAmount: "0.1" } as VaultEventJson);
    expect(html).toContain(ACTIVITY_COPY.withdrewToken("0.1", "tokens"));
  });

  it("drops to the amount-less label when the chain did not give the amounts, rather than inventing one", () => {
    const html = render({ kind: "converted", lamportsSpent: null, usdcReceivedRaw: null } as VaultEventJson);
    expect(html).toContain(ACTIVITY_COPY.convertedPlain);
  });

  it("shows no invented trade: there is no fill, and no funded wallet, on this chain", () => {
    const every: VaultEventJson[] = [
      settled("60000000"),
      { kind: "wrapped", lamports: "10000000" } as VaultEventJson,
      { kind: "converted", lamportsSpent: "10000000", usdcReceivedRaw: "1000387" } as VaultEventJson,
      { kind: "withdrew_sol", lamports: "20000000" } as VaultEventJson,
      { kind: "received_sol", lamports: "5000000" } as VaultEventJson,
      { kind: "vault_created", mode: 0, skimBps: 2_000, volumeBps: 200, maxContribution: "60000000", walletReserve: "50000000" } as VaultEventJson,
      { kind: "linked", wallet: WALLET_A } as VaultEventJson,
    ];
    const html = every.map((event) => render(event)).join("");
    expect(html).not.toMatch(/\bSold\b/);
    expect(html).not.toContain("Funded wallet");
  });
});
