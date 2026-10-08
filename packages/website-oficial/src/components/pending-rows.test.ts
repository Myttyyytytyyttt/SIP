// The rows over the feed that say what the keeper is about to do (owner,
// 2026-10-08), as the page draws them: the component alone, the live frame that
// wires it into both columns and the rule card, and the sample, which must not
// gain any of it.
//
// HERE AND NOT UNDER components/live/, because it renders the sample beside the
// live page, and no-mock-import.test.ts keeps every file under live/ (tests
// included) from importing the sample's dataset.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/providers", () => ({ useSolanaConfigOrNull: () => null }));
vi.mock("@/components/wallets-host", () => ({ useWalletsOpener: () => null }));
vi.mock("@/components/live/LiveRulePanel", async () => {
  const { SavingsRulePanel } = await import("@/components/savings-rule-panel");
  const closed = { open: false, onOpen: () => undefined, attention: false };
  return {
    LiveRulePanel: (props: Parameters<typeof SavingsRulePanel>[0]) => createElement(SavingsRulePanel, { ...props, settings: closed }),
  };
});
vi.mock("@/components/pension-chart", () => ({ PensionChart: () => createElement("div", null, "LIVECHART") }));

import { USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";

import { pendingShownFor } from "@/components/live/LiveActivityPage";
import { LiveBody } from "@/components/live/LiveBody";
import { PendingRows } from "@/components/live/LivePending";
import { SavingsRulePanel } from "@/components/savings-rule-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WalletActivity } from "@/components/wallet-activity";
import { PENDING_COPY } from "@/lib/live-copy";
import { toLiveDashboard } from "@/lib/live-model";
import type { PendingLine } from "@/lib/live-pending";
import type { LiveDashboard, VaultEventJson } from "@/lib/live-types";
import { mock } from "@/mocks";

import { NOW_MS, OWNER, liveActivity, liveEntry, liveSnapshot, seconds, signature, tokenAccount } from "../../test/fixtures/live-dashboard";

const ACTIVE: PendingLine = { key: "converting", kind: "converting", active: true, rest: null, title: PENDING_COPY.converting, sub: PENDING_COPY.convertingSub("0.018"), amount: "$1.80" };
const WAITING: PendingLine = { key: "buying", kind: "buying", active: false, rest: "paused", title: PENDING_COPY.buyingWaiting("SPYx"), sub: PENDING_COPY.rest.paused, amount: "$5.00" };

const html = (element: ReturnType<typeof createElement>): string => renderToStaticMarkup(createElement(TooltipProvider, null, element));
const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe("the rows", () => {
  it("keep a polite live region on the page even with nothing pending, and draw nothing in it", () => {
    const out = html(createElement(PendingRows, { lines: [] }));
    expect(out).toBe('<div role="status" aria-live="polite" data-pending-steps="0"></div>');
  });

  it("put a turning mark in the square of a step under way, which stops for reduced motion", () => {
    const out = html(createElement(PendingRows, { lines: [ACTIVE] }));
    expect(out).toContain(PENDING_COPY.heading);
    expect(out).toContain('data-pending-step="converting"');
    expect(out).toContain('data-state="active"');
    expect(out).toMatch(/<svg[^>]*class="[^"]*motion-safe:animate-spin[^"]*"[^>]*data-pending-loader=""/);
    expect(out).not.toMatch(/class="[^"]*(?<!motion-safe:)animate-spin/);
    expect(out).toContain(ACTIVE.title);
    expect(out).toContain(ACTIVE.sub);
    expect(out).toContain(ACTIVE.amount);
  });

  it("draw a resting step still, with its reason, and in grey rather than a buy's blue", () => {
    const out = html(createElement(PendingRows, { lines: [WAITING] }));
    expect(out).toContain('data-state="waiting"');
    expect(out).not.toContain("data-pending-loader");
    expect(out).not.toContain("animate-spin");
    expect(out).not.toContain("text-blue-600");
    expect(out).toContain(PENDING_COPY.rest.paused);
  });

  it("wear the buy's blue only on a buy under way", () => {
    expect(html(createElement(PendingRows, { lines: [{ ...WAITING, active: true, rest: null }] }))).toContain("text-blue-600");
    expect(html(createElement(PendingRows, { lines: [ACTIVE] }))).not.toContain("text-blue-600");
  });
});

describe("the sample stays the sample", () => {
  it("has no pending region in its column: the slot is a live page's only", () => {
    const out = html(createElement(WalletActivity, { wallet: mock.wallet, activity: mock.activity, now: mock.now }));
    expect(out).not.toContain("data-pending-steps");
    expect(out).not.toContain(PENDING_COPY.heading);
  });

  it("has no line under Next investment, and its figure is the sample's own pending pile", () => {
    expect(mock.stats.nextInvestmentNote).toBeUndefined();
    expect(mock.stats.readyToInvestUsd).toBeUndefined();
    const out = html(createElement(SavingsRulePanel, { rule: mock.rule, stats: mock.stats, activity: mock.activity, now: mock.now }));
    expect(out).not.toContain("data-next-investment-note");
  });
});

describe("a live page", () => {
  const wrapped = { kind: "wrapped", lamports: "18000000" } as VaultEventJson;
  /** The owner's screenshot: SOL wrapped a minute ago, the conversion still to come. */
  const converting = (): LiveDashboard => {
    const base = liveSnapshot();
    return toLiveDashboard({
      snapshot: liveSnapshot({
        vault: { ...base.vault, lamports: "1285240", withdrawableLamports: "0" },
        vaultTokenAccounts: { status: "exists", items: [tokenAccount(WSOL_MINT, "18000000", "0.018", 9), tokenAccount(USDC_MINT, "0", "0", 6)] },
      }),
      activity: liveActivity([liveEntry(signature(1), seconds(NOW_MS - 60_000), [wrapped])]),
      privyWallets: [],
    });
  };
  const render = (view: "pension" | "activity", data: LiveDashboard): string =>
    html(
      createElement(LiveBody, {
        view,
        data,
        stale: null,
        pensionKey: OWNER,
        control: null,
        account: null,
        older: { busy: false, retryAt: null, message: null, complete: true, available: false },
        onRefresh: vi.fn(),
        onLoadOlder: vi.fn(),
        nowMs: NOW_MS,
        activityUnreadable: false,
      }),
    );

  it("leads the activity column with the conversion under way, over the wrap that started it", () => {
    const out = render("pension", converting());
    expect(out).toMatch(/<div role="status" aria-live="polite" data-pending-steps="1"/);
    expect(count(out, 'data-pending-step="converting"')).toBeGreaterThanOrEqual(1);
    const pending = out.indexOf('data-pending-step="converting"');
    const wrapRow = out.indexOf("Wrapped SOL for investing");
    expect(pending).toBeGreaterThan(-1);
    expect(wrapRow).toBeGreaterThan(pending);
  });

  it("counts the SOL on its way under Next investment, and says so", () => {
    const out = render("pension", converting());
    expect(out).toContain(PENDING_COPY.includesConverting("$1.80"));
    // $1.80 of the policy's $5.00: the bar no longer reads $0.00 while the SOL is in flight.
    expect(out).toMatch(/\$1\.80 <span class="text-muted-foreground">of<\/span> \$5\.00/);
  });

  it("shows the same rows over the full history on /activity, and announces them once", () => {
    const out = render("activity", converting());
    // The aside's column, and the page's own list.
    expect(count(out, 'data-pending-step="converting"')).toBeGreaterThanOrEqual(2);
    // One polite region for them, the page's own: the column beside it shows them silently.
    expect(out.match(/<div[^>]*aria-live="polite"[^>]*data-pending-steps="1"/g)).toEqual(['<div role="status" aria-live="polite" class="border-b" data-pending-steps="1"']);
  });

  it("keeps them under All and Investing on /activity, and out of Savings and Withdrawals", () => {
    expect(pendingShownFor("all", [ACTIVE])).toEqual([ACTIVE]);
    expect(pendingShownFor("investing", [ACTIVE])).toEqual([ACTIVE]);
    expect(pendingShownFor("savings", [ACTIVE])).toEqual([]);
    expect(pendingShownFor("withdrawals", [ACTIVE])).toEqual([]);
  });

  it("draws an empty region, and no line under Next investment, once the chain has caught up", () => {
    const base = liveSnapshot();
    const done = toLiveDashboard({
      snapshot: liveSnapshot({
        vault: { ...base.vault, lamports: "1285240", withdrawableLamports: "0" },
        vaultTokenAccounts: { status: "exists", items: [tokenAccount(USDC_MINT, "0", "0", 6)] },
      }),
      activity: liveActivity([liveEntry(signature(1), seconds(NOW_MS - 60_000), [wrapped])]),
      privyWallets: [],
    });
    const out = render("pension", done);
    expect(out).toContain('data-pending-steps="0"');
    expect(out).not.toContain("data-pending-step=");
    expect(out).not.toContain("data-next-investment-note");
  });
});
