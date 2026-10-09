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

import { ANTHROPIC_MINT, SPYX_MINT, USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";

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

import { NOW_MS, OWNER, WALLET_A, liveActivity, liveEntry, liveSnapshot, policyState, seconds, signature, tokenAccount } from "../../test/fixtures/live-dashboard";

const ACTIVE: PendingLine = { key: "converting", kind: "converting", active: true, rest: null, title: PENDING_COPY.converting, sub: PENDING_COPY.convertingSub("0.018"), amount: "$1.80", amountSpoken: "" };
const WAITING: PendingLine = { key: "buying", kind: "buying", active: false, rest: "paused", title: PENDING_COPY.buyingWaiting("SPYx"), sub: PENDING_COPY.rest.paused, amount: "$5.00", amountSpoken: null };

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

  it("draw a conversion resting on the SOL safety floor with the pause mark, like every rest the owner can lift", () => {
    const floor: PendingLine = { ...ACTIVE, active: false, rest: "safety_floor", title: PENDING_COPY.convertingWaiting, sub: PENDING_COPY.rest.safety_floor, amountSpoken: "0.018 SOL" };
    const out = html(createElement(PendingRows, { lines: [floor] }));
    expect(out).not.toContain("data-pending-loader");
    expect(out).toContain("lucide-pause");
    expect(out).not.toContain("lucide-arrow-left-right");
    expect(out).toContain(PENDING_COPY.rest.safety_floor.replaceAll("'", "&#x27;"));
  });

  /**
   * THE LIVE REGION HEARS WHAT CHANGES WITH THE STEP, NOT WITH THE PRICE. A
   * conversion's dollars are re-priced at every 20 s read; read out, every cent
   * of SOL would be announced again for as long as the step runs.
   */
  it("keep a conversion's re-priced dollars out of what the live region reads, and speak its SOL once", () => {
    const spoken = (out: string): string => out.replace(/<span[^>]*aria-hidden="true"[^>]*>[^<]*<\/span>/g, "").replace(/<svg[\s\S]*?<\/svg>/g, "");
    const at = (amount: string): string => html(createElement(PendingRows, { lines: [{ ...ACTIVE, amount }] }));
    expect(at("$1.80")).toContain("$1.80");
    expect(spoken(at("$1.80"))).toBe(spoken(at("$1.81")));
    expect(spoken(at("$1.80"))).not.toContain("$1.80");
    // A resting conversion's line is its reason, so the SOL is spoken in the amount's place.
    const resting = html(createElement(PendingRows, { lines: [{ ...ACTIVE, active: false, rest: "paused", sub: PENDING_COPY.rest.paused, amountSpoken: "0.018 SOL" }] }));
    expect(resting).toContain('<span class="sr-only">0.018 SOL</span>');
    // A buy's amount is the USDC it spends, which does not move with SOL: it is read as drawn.
    expect(html(createElement(PendingRows, { lines: [WAITING] }))).not.toContain('aria-hidden="true">$5.00');
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
    // Nor does it gate its bar or take its "to go" from the keeper: the card keeps the sample's own arithmetic.
    expect(mock.stats.toGoUsd).toBeUndefined();
    expect(mock.stats.nextInvestmentGate).toBeUndefined();
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

  /**
   * BELOW lg THE COLUMN IS IN A CLOSED SHEET (site-header.tsx) and the aside is
   * not displayed, so the page's own top carries the steps: framed, hidden from
   * lg up where the column shows them, and out of the flow while empty.
   */
  it("leads the pension page's own top with the steps below lg, where the activity column is out of sight", () => {
    const out = render("pension", converting());
    const top = out.match(/<div role="status" aria-live="polite" class="([^"]*)" data-pending-steps="1">/);
    expect(top?.[1]).toBe("overflow-hidden rounded-md border bg-card lg:hidden");
    // Before the holdings and the rule card, inside the main column.
    expect(out.indexOf(top![0])).toBeLessThan(out.indexOf("data-next-investment-note"));
    const empty = render("pension", toLiveDashboard({ snapshot: liveSnapshot({ vaultTokenAccounts: { status: "exists", items: [] }, vault: { ...liveSnapshot().vault, lamports: "1285240", withdrawableLamports: "0" } }), activity: liveActivity([]), privyWallets: [] }));
    expect(empty).toContain('<div role="status" aria-live="polite" class="sr-only lg:hidden" data-pending-steps="0"></div>');
  });

  it("counts the SOL on its way under Next investment, and says so", () => {
    const out = render("pension", converting());
    expect(out).toContain(PENDING_COPY.includesConverting("$1.80"));
    // $1.80 of the policy's $5.00: the bar no longer reads $0.00 while the SOL is in flight.
    expect(out).toMatch(/\$1\.80 <span class="text-muted-foreground">of<\/span> \$5\.00/);
  });

  /**
   * THE OWNER'S $0.43 (2026-10-09): one settlement of 3,911,799 lamports, under
   * the keeper's 0.005 SOL wrap line, no USDC, a $1.00 basket. Nothing moves, so
   * no row says it — and the card counts it, says what it waits for, and still
   * agrees with itself.
   */
  it("counts SOL under the wrap line under Next investment, with no row over the feed", () => {
    const base = liveSnapshot();
    const data = toLiveDashboard({
      snapshot: liveSnapshot({
        vault: { ...base.vault, lamports: (1_285_240 + 3_911_799).toString(), rentFloor: "1285240", withdrawableLamports: "3911799" },
        policy: {
          status: "exists",
          address: base.policy.address,
          state: policyState({
            minInvestment: "500000",
            maxPerCall: "149000000",
            legs: [
              { mint: SPYX_MINT, weightBps: 5_000, minOutRateWad: "1" },
              { mint: ANTHROPIC_MINT, weightBps: 5_000, minOutRateWad: "1" },
            ],
          }),
        },
        vaultTokenAccounts: { status: "exists", items: [tokenAccount(USDC_MINT, "0", "0", 6)] },
      }),
      activity: liveActivity([]),
      privyWallets: [],
    });
    const out = render("pension", data);
    expect(out).toContain('data-pending-steps="0"');
    expect(out).toMatch(/\$0\.39 <span class="text-muted-foreground">of<\/span> \$1\.00/);
    expect(out).toContain('<span class="font-mono tabular-nums">$0.61</span> to go');
    expect(out).toContain(PENDING_COPY.includesWaiting("$0.39", "0.005", "0.0011"));
    expect(out).not.toContain("$0.00</span> to go");
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

  it("keeps a wallet being checked under All and Savings — a saving may follow — and out of Investing and Withdrawals", () => {
    const checking: PendingLine = { key: "measuring:W", kind: "measuring", active: true, rest: null, title: PENDING_COPY.measuring("Wallet 1"), sub: PENDING_COPY.measuringSub.profit, amount: "", amountSpoken: "" };
    expect(pendingShownFor("all", [checking, ACTIVE])).toEqual([checking, ACTIVE]);
    expect(pendingShownFor("savings", [checking, ACTIVE])).toEqual([checking]);
    expect(pendingShownFor("investing", [checking, ACTIVE])).toEqual([ACTIVE]);
    expect(pendingShownFor("withdrawals", [checking, ACTIVE])).toEqual([]);
  });

  /**
   * A TRADE MADE ELSEWHERE (owner, 2026-10-09): the push saw the trading wallet
   * change past its frontier, a read at or past that slot read the history, and
   * no settlement of it is on screen — so the page says it is being checked,
   * with the loader, at the top of the column, and nothing about an amount.
   */
  it("leads the column with a wallet being checked, by its name, with a loader and no amount", () => {
    const data = toLiveDashboard({
      snapshot: liveSnapshot({ readAtMs: NOW_MS, vault: { ...liveSnapshot().vault, lamports: "1285240", withdrawableLamports: "0" }, vaultTokenAccounts: { status: "exists", items: [] } }),
      activity: liveActivity([]),
      privyWallets: [WALLET_A],
      walletChanges: [{ wallet: WALLET_A, slot: 5_000, sinceMs: NOW_MS }],
    });
    const label = data.wallets[0]!.label;
    const out = render("pension", data);
    expect(out).toMatch(/<div role="status" aria-live="polite" data-pending-steps="1"/);
    expect(out).toContain('data-pending-step="measuring"');
    expect(out).toContain(PENDING_COPY.measuring(label));
    expect(out).toMatch(/data-pending-step="measuring" data-state="active">[\s\S]*?data-pending-loader=""/);
    // The same page without the push draws nothing pending.
    const quiet = render("pension", { ...data, walletChanges: [] });
    expect(quiet).not.toContain('data-pending-step="measuring"');
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
