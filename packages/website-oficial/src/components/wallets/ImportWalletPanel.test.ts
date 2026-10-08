// The import's review before the press, in every shape the preflight can hand it: what is said about the SOL
// starting point, about SOL coming back from other apps, and about tokens — three notices with their own words.

import { USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@privy-io/react-auth", () => ({ usePrivy: () => ({ user: null }) }));
vi.mock("@/app/providers", () => ({ useSolanaConfig: () => ({ privySignerId: null, privyPolicyId: null }) }));

import { TooltipProvider } from "@/components/ui/tooltip";
import { HoldingsList, ImportAndLinkNote, ImportReview } from "@/components/wallets/ImportWalletPanel";
import { HOLDINGS_COPY, startingPointLine, type HoldingsNotice } from "@/lib/import-preflight";
import { IMPORT_LINK_COPY, IMPORT_PANEL_COPY } from "@/lib/vault-copy";

const ADDRESS = "ImportedP1aceho1der1111111111111111111111";
const holding = (mint: string, uiAmount: string) => ({ tokenAccount: `ata-${mint}`, mint, amountRaw: "1", decimals: 0, uiAmount, tokenProgram: "token" });
/** HTML with apostrophes as React writes them. */
const has = (html: string, text: string) => html.includes(text.replaceAll("'", "&#x27;"));

const notice = (holdings: HoldingsNotice) => renderToStaticMarkup(createElement(HoldingsList, { notice: holdings, acknowledged: false, onAcknowledge: () => {} }));

describe("HoldingsList: three shapes, each in its own words", () => {
  it("tokens: a few named, the rest counted, wSOL's unwrap and the empty accounts said", () => {
    const html = notice({ holdings: [holding(WSOL_MINT, "3"), holding(USDC_MINT, "1000")], count: 11, emptyAccounts: 2 });
    expect(html).toContain('data-holdings="tokens"');
    for (const text of [HOLDINGS_COPY.title, "wSOL", "USDC", IMPORT_PANEL_COPY.moreHoldings(9), HOLDINGS_COPY.body, HOLDINGS_COPY.emptyAccounts(2), HOLDINGS_COPY.avoid, HOLDINGS_COPY.acknowledge]) {
      expect(has(html, text), text).toBe(true);
    }
    expect(HOLDINGS_COPY.body).toContain("unwrap wSOL");
  });

  it("too many to list: nothing named, and closing accounts said outright", () => {
    const html = notice({ holdings: [], count: null, emptyAccounts: null });
    expect(html).toContain('data-holdings="too-many"');
    for (const text of [HOLDINGS_COPY.titleTooMany, HOLDINGS_COPY.body, HOLDINGS_COPY.tooManyClosing, HOLDINGS_COPY.avoidTooMany, HOLDINGS_COPY.acknowledgeTooMany]) {
      expect(has(html, text), text).toBe(true);
    }
    expect(html).not.toContain("<ul");
  });

  it("empty accounts alone: closing them, never selling", () => {
    const html = notice({ holdings: [], count: 0, emptyAccounts: 3 });
    expect(html).toContain('data-holdings="empty-only"');
    for (const text of [HOLDINGS_COPY.titleEmptyOnly, HOLDINGS_COPY.emptyOnly(3), HOLDINGS_COPY.avoidEmptyOnly, HOLDINGS_COPY.acknowledgeEmptyOnly]) {
      expect(has(html, text), text).toBe(true);
    }
    expect(html).not.toMatch(/sell/i);
    expect(html).not.toContain("also has");
  });
});

describe("ImportReview", () => {
  const review = (needsLink: boolean, noCreatedYet = false) =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(ImportReview, {
          address: ADDRESS,
          verdict: { kind: "go", needsLink, lamports: 120_000_000n, holdings: null },
          noCreatedYet,
          ahead: null,
          acknowledged: false,
          onAcknowledge: () => {},
        }),
      ),
    );

  it("a new link: the SOL starting point, and SOL coming back from other apps with how to keep it out", () => {
    const html = review(true);
    expect(has(html, startingPointLine(120_000_000n)!)).toBe(true);
    expect(has(html, HOLDINGS_COPY.elsewhere)).toBe(true);
    expect(HOLDINGS_COPY.elsewhere).toContain("withdraw staked SOL, not just unstake it");
  });

  it("already linked here: no starting point (it is measured from the link), and the from-the-link words", () => {
    const html = review(false);
    expect(html).not.toContain("starting point");
    expect(has(html, HOLDINGS_COPY.elsewhereLinked)).toBe(true);
    expect(has(html, HOLDINGS_COPY.elsewhere)).toBe(false);
  });

  it("says Create will not work afterwards only when asked to", () => {
    expect(review(true, true)).toContain("data-no-created-yet");
    expect(review(true, false)).not.toContain("data-no-created-yet");
  });
});

describe("the linked path and the announced no-link outcome", () => {
  it("a wallet already linked here is not told to sell before importing: it is measured from the link", () => {
    const html = renderToStaticMarkup(createElement(HoldingsList, { notice: { holdings: [holding(USDC_MINT, "5")], count: 1, emptyAccounts: 0 }, linked: true, acknowledged: false, onAcknowledge: () => {} }));
    expect(has(html, HOLDINGS_COPY.avoidLinked)).toBe(true);
    expect(has(html, HOLDINGS_COPY.avoid)).toBe(false);
    const empty = renderToStaticMarkup(createElement(HoldingsList, { notice: { holdings: [], count: 0, emptyAccounts: 4 }, linked: true, acknowledged: false, onAcknowledge: () => {} }));
    expect(has(empty, HOLDINGS_COPY.avoidLinkedEmptyOnly)).toBe(true);
    expect(empty).not.toMatch(/sell|Moving tokens/i);
  });

  it("a press that announced no link ends in a status that says so once, not an alert", () => {
    const html = renderToStaticMarkup(
      createElement(ImportAndLinkNote, {
        outcome: { imported: ADDRESS, link: null, alreadyLinked: false, stop: { kind: "link_later", message: IMPORT_LINK_COPY.linkLater, gate: null } },
        vaultRent: null,
        onGoToVault: null,
        onDismiss: () => {},
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    expect(html.match(/imported/g)).toHaveLength(1);
  });
});

