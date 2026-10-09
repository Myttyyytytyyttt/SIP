// The bar's last few contributions (header-contributions.tsx). One settle can
// pay two wallets — one signature, two chips — and each chip still needs a key
// of its own that a newer settlement arriving on top does not move (G12).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HeaderContributions, contributions } from "@/components/header-contributions";
import type { LiveRow, VaultEventJson } from "@/lib/live-types";

import { settledEvent, signature } from "../../test/fixtures/live-dashboard";

const row = (sig: string, event: VaultEventJson, ok = true): LiveRow => ({
  signature: sig,
  slot: 4_000,
  at: "2026-09-16T11:00:00.000Z",
  blockTime: 1_789_556_400,
  ok,
  explorerUrl: null,
  event,
});

const ONE_SETTLE_TWO_WALLETS = [row(signature(1), settledEvent("60000000")), row(signature(1), { ...settledEvent("40000000"), wallet: "TradingOneP1aceho1der111111111111111111111" } as VaultEventJson)];

describe("each chip's key", () => {
  it("is its own when one settle paid two wallets", () => {
    const keys = contributions(ONE_SETTLE_TWO_WALLETS).map((chip) => chip.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it("does not move when a newer settlement arrives on top", () => {
    const before = contributions(ONE_SETTLE_TWO_WALLETS).map((chip) => chip.key);
    const after = contributions([row(signature(2), settledEvent("10000000")), ...ONE_SETTLE_TWO_WALLETS]).map((chip) => chip.key);
    expect(after.slice(1)).toEqual(before);
  });
});

describe("what it shows", () => {
  it("is money that arrived: both chips of the one settle, and nothing for a failed one", () => {
    const html = renderToStaticMarkup(createElement(HeaderContributions, { rows: [...ONE_SETTLE_TWO_WALLETS, row(signature(3), settledEvent("50000000"), false)] }));
    expect(html.match(/role="listitem"/g)).toHaveLength(2);
  });

  it("is nothing at all when nothing arrived", () => {
    expect(renderToStaticMarkup(createElement(HeaderContributions, { rows: [] }))).toBe("");
  });
});
