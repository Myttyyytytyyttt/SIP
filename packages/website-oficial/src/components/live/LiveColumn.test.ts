// The live column's wallet list (owner, 10-23): two rows a card — the name with its pencil and the status, then
// the address with its copy and the balance as x.xxx SOL ≈ $y — no settlement count, the reserve note folded
// into the badge, and a box that scrolls itself once it holds more than about three cards. Built through the
// real model and rendered to markup: the interaction itself is proven in a browser.

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { WalletList, WalletStatusBadge } from "@/components/live/LiveColumn";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WalletNamesContext, type WalletNamesValue } from "@/components/wallets/wallet-names-context";
import { LIVE_COPY, RENAME_COPY } from "@/lib/live-copy";
import { toLiveDashboard } from "@/lib/live-model";
import type { LiveSnapshotJson } from "@/lib/live-types";

import { VAULT, liveSnapshot } from "../../../test/fixtures/live-dashboard";

const USDC_PER_SOL = 100_038_711n;
const address = (index: number): string => `Wa11et${index}P1aceho1der1111111111111111111111`.slice(0, 43);

/** `count` wallets, all linked here, the first holding 2.433206523 SOL, through the real model. */
function wallets(count: number, over: (index: number) => Partial<LiveSnapshotJson["wallets"][number]> = () => ({})) {
  const addresses = Array.from({ length: count }, (_, index) => address(index));
  const snapshot = liveSnapshot({
    wallets: addresses.map((wallet, index) => ({
      wallet,
      lamports: index === 0 ? "2433206523" : "500000000",
      link: { address: `${wallet}-link`, status: "this_vault" as const, vault: VAULT, epoch: "1", settlementNonce: "9", frontierSlot: "1" },
      ...over(index),
    })),
  });
  return toLiveDashboard({ snapshot, activity: null, privyWallets: addresses }).wallets;
}

const names = (over: Partial<WalletNamesValue> = {}): WalletNamesValue => ({ account: true, available: true, names: {}, rename: vi.fn(async () => ({ ok: true as const })), ...over });

function draw(list: ReturnType<typeof wallets>, value: WalletNamesValue | null = null): string {
  const tree: ReactNode = createElement(WalletList, { wallets: list, usdcRawPerSol: USDC_PER_SOL });
  const inner = value === null ? tree : createElement(WalletNamesContext.Provider, { value }, tree);
  return renderToStaticMarkup(createElement(TooltipProvider, null, inner));
}

const cards = (html: string): string[] => html.split("<li ").slice(1);
/** The rows of one card: its direct children, which are the only divs that open right after the li or a closing div. */
const rowsOf = (card: string): number => (card.match(/(?:^[^>]*>|<\/div>)<div class="flex min-w-0 items-center justify-between/g) ?? []).length;
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("WalletList", () => {
  it("draws each wallet in exactly two rows: name and status, then address and balance", () => {
    const html = draw(wallets(3));
    expect(cards(html)).toHaveLength(3);
    for (const card of cards(html)) expect(rowsOf(card)).toBe(2);
    const first = text(cards(html)[0]!);
    expect(first).toMatch(/Trading wallet 1 .*Linked .*Wa11…1111 .*2\.433 SOL ≈ \$243\.41/);
  });

  it("says the balance to three places, cut down, with every lamport in its tooltip — and no settlement count", () => {
    const html = draw(wallets(1));
    expect(html).toContain(">2.433 SOL<");
    expect(html).toContain('title="2.433206523 SOL ≈ $243.41"');
    expect(html).not.toContain("2.433206523 SOL<");
    expect(text(html)).not.toMatch(/settlement/i);
  });

  it("shows the dollars whole or not at all: their own item on a one-line row that wraps out of sight", () => {
    const html = draw(wallets(1, () => ({ lamports: "1999999999999" })));
    const balance = html.match(/<span class="([^"]*)" title="1,999\.999999999 SOL ≈ \$[0-9,.]+">/);
    expect(balance).not.toBeNull();
    for (const rule of ["flex", "h-4", "flex-wrap", "overflow-hidden", "justify-end"]) expect(balance![1]!.split(" ")).toContain(rule);
    expect(html).toMatch(/>1,999\.999 SOL<\/span><span>≈ \$[0-9,.]+<\/span>/);
  });

  it("reads dust as <0.001, an unread balance as a dash", () => {
    const dust = draw(wallets(2, (index) => (index === 0 ? { lamports: "1" } : { lamports: null as unknown as string })));
    expect(dust).toContain("&lt;0.001 SOL");
    expect(text(cards(dust)[1]!)).toContain(LIVE_COPY.unknownFigure);
  });

  it("folds the reserve note into an amber badge, so a wallet that cannot settle is still two rows", () => {
    // 890,880 floor + 50,000,000 reserve: exactly that is too little to settle.
    const html = draw(wallets(2, (index) => (index === 1 ? { lamports: "50890880" } : {})));
    const stuck = cards(html)[1]!;
    expect(rowsOf(stuck)).toBe(2);
    expect(stuck).toContain(LIVE_COPY.badgeCannotSettle);
    expect(stuck).toContain(`title="${LIVE_COPY.reserveNoteShort}"`);
    expect(stuck).toContain('class="sr-only">. ');
    expect(stuck).not.toContain(`<p class="text-xs text-amber-700`);
    expect(cards(html)[0]).not.toContain(LIVE_COPY.badgeCannotSettle);
  });

  it("scrolls inside its own box, never the page, with room for a focus ring at its edges", () => {
    const html = draw(wallets(7));
    const list = html.match(/<ul [^>]*>/)![0];
    expect(list).toContain(`aria-label="${LIVE_COPY.tradingWallets}"`);
    for (const rule of ["max-h-[15.5rem]", "overflow-y-auto", "overscroll-contain", "px-1", "-mx-1"]) expect(list).toContain(rule);
    expect(cards(html)).toHaveLength(7);
  });

  it("keeps the pencil's height from the sign-in on, so nothing moves when the names land — and signed out, the plain name", () => {
    const waiting = draw(wallets(1), names({ available: false }));
    expect(waiting).toContain('<span class="flex h-6 min-w-0 items-center"><span class="min-w-0 truncate text-sm font-medium">Trading wallet 1</span></span>');
    expect(waiting).not.toContain("data-wallet-rename");
    const visitor = draw(wallets(1));
    expect(visitor).toContain('<span class="min-w-0 truncate text-sm font-medium">Trading wallet 1</span>');
    expect(visitor).not.toContain("h-6");
  });

  it("offers the pencil only when the account's names can be saved", () => {
    expect(draw(wallets(2))).not.toContain("data-wallet-rename");
    expect(draw(wallets(2), names({ available: false }))).not.toContain("data-wallet-rename");
    const html = draw(wallets(2), names());
    expect(html.match(/data-wallet-rename/g)).toHaveLength(2);
    expect(html).toContain(`aria-label="${RENAME_COPY.rename("Trading wallet 1")}"`);
    // Half opacity at rest, whole on hover and on keyboard focus.
    expect(html).toMatch(/data-wallet-rename=""[^>]*class="[^"]*opacity-50 [^"]*hover:opacity-100 focus-visible:opacity-100/);
  });

  it("says when there is no wallet, as before", () => {
    expect(draw([])).toContain(LIVE_COPY.noWalletsYet);
  });
});

describe("WalletStatusBadge", () => {
  it("is the link's own badge for every wallet that can settle or is not linked here", () => {
    const [linked] = wallets(1);
    expect(renderToStaticMarkup(createElement(WalletStatusBadge, { wallet: linked! }))).toContain(LIVE_COPY.badgeLinked);
    expect(renderToStaticMarkup(createElement(WalletStatusBadge, { wallet: { ...linked!, canSettle: false, linkStatus: "missing" } }))).toContain(LIVE_COPY.badgeNotLinked);
  });
});
