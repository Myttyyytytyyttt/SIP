// What a screen reader hears when something arrives (LiveAnnouncer.tsx): one
// polite announcement per update that brought something, in the chain's own
// amounts, and a count rather than a guess when it is more than two
// transactions or one it has no words for. The wash and the pill are
// decoration; this is the arrival, said.

import { SPYX_MINT } from "@sip/solana-core/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LiveAnnouncer, announcementOf } from "@/components/live/LiveAnnouncer";
import { ACTIVITY_COPY } from "@/lib/live-copy";
import type { LiveRow, VaultEventJson } from "@/lib/live-types";

import { WALLET_A, settledEvent, signature } from "../../../test/fixtures/live-dashboard";
import { liveRegions, tickingInRegion } from "../../../test/live-regions";

const labelOf = (wallet: string | null): string => (wallet === WALLET_A ? "Trading wallet 1" : ACTIVITY_COPY.someWallet);

let slot = 4_000;
const row = (seed: number, event: VaultEventJson, ok = true): LiveRow => ({
  signature: signature(seed),
  slot: (slot += 10),
  at: "2026-09-16T11:59:00.000Z",
  blockTime: 1_789_559_940,
  ok,
  explorerUrl: null,
  event,
});

const SETTLED = row(1, settledEvent("36634582"));
const CONVERTED = row(2, { kind: "converted", lamportsSpent: "36634582", usdcReceivedRaw: "3665000" } as VaultEventJson);
const invested = (seed: number, symbol: string | null, mint: string | null = null): LiveRow =>
  row(seed, { kind: "invested", mint, symbol, usdcSpentRaw: "500000", receivedRaw: "1", receivedUi: "0.01" } as VaultEventJson);
const RULE = row(5, { kind: "rule_changed", mode: 0, skimBps: 2_000, volumeBps: null, paused: false, maxContribution: null, walletReserve: null } as VaultEventJson);

describe("what it says", () => {
  it("a saving, in SOL, from its wallet", () => {
    expect(announcementOf([SETTLED], labelOf)).toBe("Saved 0.036634582 SOL from Trading wallet 1.");
  });

  it("a conversion, SOL in and USDC out", () => {
    expect(announcementOf([CONVERTED], labelOf)).toBe("Converted 0.036634582 SOL to 3.67 USDC.");
  });

  it("a buy of two legs as one sentence, by symbol — the mint's when the event names none", () => {
    expect(announcementOf([invested(3, "SPYx"), invested(4, null, SPYX_MINT)], labelOf)).toBe("Bought SPYx.");
    expect(announcementOf([invested(3, "SPYx"), invested(4, "ANTHROPIC")], labelOf)).toBe("Bought SPYx and ANTHROPIC.");
  });

  it("a rule change", () => {
    expect(announcementOf([RULE], labelOf)).toBe("Saving rule changed.");
  });

  it("two transactions, oldest first, as one announcement", () => {
    expect(announcementOf([CONVERTED, SETTLED], labelOf)).toBe("Saved 0.036634582 SOL from Trading wallet 1. Converted 0.036634582 SOL to 3.67 USDC.");
  });

  it("three or more transactions as a count", () => {
    expect(announcementOf([invested(3, "SPYx"), CONVERTED, SETTLED], labelOf)).toBe("3 new transactions on your pension.");
  });

  it("one it has no words for as a count — a failure, a settlement that moved nothing, an amount the chain did not give — never a guess", () => {
    expect(announcementOf([row(6, { kind: "failed", instructions: [] } as VaultEventJson, false)], labelOf)).toBe("1 new transaction on your pension.");
    expect(announcementOf([row(7, settledEvent("0"))], labelOf)).toBe("1 new transaction on your pension.");
    expect(announcementOf([row(8, { kind: "converted", lamportsSpent: null, usdcReceivedRaw: "1" } as VaultEventJson)], labelOf)).toBe("1 new transaction on your pension.");
    expect(announcementOf([SETTLED, row(9, { kind: "wrapped", lamports: "1" } as VaultEventJson)], labelOf)).toBe("2 new transactions on your pension.");
  });

  it("nothing when nothing arrived", () => {
    expect(announcementOf([], labelOf)).toBeNull();
  });

  it("never a dollar, and none of the machinery's words", () => {
    for (const words of [announcementOf([SETTLED], labelOf), announcementOf([CONVERTED], labelOf), announcementOf([RULE], labelOf), announcementOf([invested(3, "SPYx")], labelOf)]) {
      expect(words).not.toMatch(/\$/);
      expect(words).not.toMatch(/\b(keeper|read|poll|wrap|policy|RPC|socket)\b/i);
    }
  });
});

describe("the region", () => {
  const render = (news: Parameters<typeof LiveAnnouncer>[0]["news"]): string => renderToStaticMarkup(createElement(LiveAnnouncer, { news, labelOf }));

  it("is there and empty before anything arrived, so it can announce the first arrival", () => {
    const html = render(null);
    expect(liveRegions(html)).toHaveLength(1);
    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/aria-live="polite"/);
    expect(html).toMatch(/class="sr-only"/);
    expect(html.replace(/<[^>]*>/g, "")).toBe("");
  });

  it("holds one announcement per update, and nothing that ticks or can be pressed", () => {
    const html = render({ seq: 3, rows: [SETTLED] });
    expect(html.replace(/<[^>]*>/g, "")).toBe("Saved 0.036634582 SOL from Trading wallet 1.");
    expect(html.match(/<span/g)).toHaveLength(1);
    expect(tickingInRegion(html)).toBe(false);
  });
});
