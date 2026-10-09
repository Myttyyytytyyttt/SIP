// The card that says what to do next. Each stage has exactly one thing to do,
// and a stage with no pension yet must show no pension figures — a screen of
// honest zeroes reads as a broken product rather than an unstarted one.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
  function textOf(node: unknown): string {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (typeof node === "object" && node !== null && "props" in node) return textOf((node as { props: { children?: unknown } }).props.children);
    return "";
  }
  return { textOf, buttons: [] as { label: string; onClick: ((event: unknown) => void) | undefined }[], choice: null as unknown };
});

// What this browser remembers the setup chose for the savings: nothing, unless a test says.
vi.mock("@/hooks/use-onboarding-closed", () => ({ useBasketChoice: () => mocked.choice }));

vi.mock("@/components/ui/button", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/button")>();
  return {
    ...actual,
    Button: (props: Parameters<typeof actual.Button>[0]) => {
      mocked.buttons.push({ label: mocked.textOf(props.children).trim(), onClick: props.onClick as unknown as ((event: unknown) => void) | undefined });
      return actual.Button(props);
    },
  };
});

import { OFFERED_LEGS } from "@sip/solana-core/client";

import { LiveNextStep, firstBuyOf, waitingSinceOf } from "@/components/live/LiveNextStep";
import type { LastWrite, WriteSync } from "@/components/live/last-write-context";
import { takeImportRequest } from "@/lib/import-intent";
import { LIVE_COPY } from "@/lib/live-copy";
import type { LiveDashboard, LiveEntryJson, VaultEventJson } from "@/lib/live-types";

import { NOW_MS, OWNER, VAULT, WALLET_A, liveActivity, liveDashboard, liveEntry, liveSnapshot, policyState, seconds, signature } from "../../../test/fixtures/live-dashboard";

const onOpenWallets = vi.fn();
/** What a real click hands a handler. */
const CLICK = { type: "click", target: {} };

function render(data: LiveDashboard, seatProblem: string | null = null, animate = false): string {
  mocked.buttons.length = 0;
  return renderToStaticMarkup(createElement(LiveNextStep, { data, pensionKey: OWNER, seatProblem, onOpenWallets, animate }));
}

const buttons = (label: string) => mocked.buttons.filter((button) => button.label === label);

/** A pension key on its very first visit: no vault, no wallet, no link, no policy. */
const noVault = (): LiveDashboard =>
  liveDashboard({
    snapshot: liveSnapshot({ vault: { status: "missing", address: "v" }, policy: { status: "missing", address: "p" }, wallets: [] }),
    activity: null,
    privyWallets: [],
  });

const unlinkedSnapshot = () =>
  liveSnapshot({ wallets: [{ wallet: WALLET_A, lamports: "420000000", link: { address: "l", status: "missing", vault: null, epoch: null, settlementNonce: null, frontierSlot: null } }] });

beforeEach(() => {
  mocked.buttons.length = 0;
  mocked.choice = null;
  onOpenWallets.mockClear();
});

describe("no vault yet", () => {
  it("names the rent it costs and offers to create one", () => {
    const html = render(noVault());
    expect(html).toContain(LIVE_COPY.noVault.title);
    expect(html).toContain("0.00128524");
    expect(buttons(LIVE_COPY.noVault.create)).toHaveLength(1);
  });

  it("Create vault opens Manage wallets on its Vault tab, and the wallets page link asks for the same tab", () => {
    const html = render(noVault());
    buttons(LIVE_COPY.noVault.create)[0]?.onClick?.(CLICK);
    // The section, never the click event: the opener reads its first argument as the tab.
    expect(onOpenWallets.mock.calls).toStrictEqual([["vault"]]);
    expect(html).toContain(`href="/wallets?section=vault"`);
  });

  it("shows NO pension figures: there is no pension yet", () => {
    const html = render(noVault());
    expect(html).not.toContain(LIVE_COPY.savedSoFar);
    expect(html).not.toContain("$");
  });

  it("walks the four steps, and marks none of them done", () => {
    const html = render(noVault());
    for (const step of LIVE_COPY.noVault.steps) expect(html).toContain(step);
    expect(html).not.toContain("line-through");
  });
});

describe("the stages after it", () => {
  it("a vault with no trading wallet offers to create one", () => {
    const data = liveDashboard({ snapshot: liveSnapshot({ wallets: [] }), activity: null, privyWallets: [] });
    const html = render(data);
    expect(html).toContain(LIVE_COPY.noTradingWallet.body);
    expect(buttons(LIVE_COPY.noTradingWallet.create)).toHaveLength(1);
    buttons(LIVE_COPY.noTradingWallet.create)[0]?.onClick?.(CLICK);
    expect(onOpenWallets.mock.calls).toStrictEqual([["trading"]]);
    expect(takeImportRequest()).toBe(false);
  });

  it("…or to import a wallet already in use: the same tab, with the import panel asked for", () => {
    const data = liveDashboard({ snapshot: liveSnapshot({ wallets: [] }), activity: null, privyWallets: [] });
    render(data);
    expect(buttons(LIVE_COPY.noTradingWallet.import)).toHaveLength(1);
    buttons(LIVE_COPY.noTradingWallet.import)[0]?.onClick?.(CLICK);
    expect(onOpenWallets.mock.calls).toStrictEqual([["trading"]]);
    expect(takeImportRequest()).toBe(true);
    expect(takeImportRequest()).toBe(false);
  });

  it("…and offers NO button when this deployment has no keeper seat, saying why instead", () => {
    const data = liveDashboard({ snapshot: liveSnapshot({ wallets: [] }), activity: null, privyWallets: [] });
    const html = render(data, "The keeper's seat is not configured.");
    expect(html).toContain("The keeper&#x27;s seat is not configured.");
    expect(buttons(LIVE_COPY.noTradingWallet.create)).toHaveLength(0);
    expect(buttons(LIVE_COPY.noTradingWallet.import)).toHaveLength(0);
  });

  it("an unlinked wallet is offered a link, on the Trading wallets tab where each row carries it", () => {
    render(liveDashboard({ snapshot: unlinkedSnapshot(), activity: null }));
    expect(buttons(LIVE_COPY.notLinked.link)).toHaveLength(1);
    buttons(LIVE_COPY.notLinked.link)[0]?.onClick?.(CLICK);
    expect(onOpenWallets.mock.calls).toStrictEqual([["trading"]]);
  });

  it("…but not while the protocol is paused, or its config could not be read", () => {
    const paused = liveSnapshot({ ...unlinkedSnapshot(), config: { address: "c", status: "exists", exists: true, paused: true } });
    expect(render(liveDashboard({ snapshot: paused, activity: null }))).toContain(LIVE_COPY.notLinked.paused);
    expect(buttons(LIVE_COPY.notLinked.link)).toHaveLength(0);

    const noConfig = liveSnapshot({ ...unlinkedSnapshot(), config: { address: "c", status: "unreadable", exists: false, paused: null } });
    expect(render(liveDashboard({ snapshot: noConfig, activity: null }))).toContain(LIVE_COPY.notLinked.needsConfig);
    expect(buttons(LIVE_COPY.notLinked.link)).toHaveLength(0);
  });

  it("a linked wallet with nothing settled yet explains the keeper's sweep at the vault's own rate", () => {
    const fresh = liveSnapshot();
    const data = liveDashboard({
      snapshot: liveSnapshot({ ...fresh, vault: { ...fresh.vault, state: { ...fresh.vault.state!, lifetimeSaved: "0" } }, wallets: [{ ...fresh.wallets[0]!, link: { ...fresh.wallets[0]!.link, settlementNonce: "0" } }] }),
      activity: null,
    });
    expect(render(data)).toContain(LIVE_COPY.waiting.body("20 %"));
  });

  it("renders nothing at all once the pension is running and its first buy has happened", () => {
    expect(render(liveDashboard({ snapshot: withPolicy(policyState({ lifetimeInvested: "5000000" })) }))).toBe("");
  });

  it("never offers to create a vault that merely could not be READ", () => {
    const data = liveDashboard({ snapshot: liveSnapshot({ vault: { status: "unreadable", address: "v" } }), activity: null });
    expect(render(data)).toBe("");
  });
});

// ── the setup, ticked off through the first buy (10-09) ─────────────────────

const STOCKS = { kind: "stocks", mints: OFFERED_LEGS.map((leg) => leg.mint) };

function withPolicy(policy: ReturnType<typeof policyState> | "missing" | "unreadable", base = liveSnapshot()) {
  return liveSnapshot({
    ...base,
    policy:
      policy === "missing" || policy === "unreadable"
        ? ({ status: policy, address: `${VAULT}-policy` } as never)
        : { status: "exists", address: `${VAULT}-policy`, state: policy },
  });
}

/** Linked, nothing settled yet: the wait for the first saving. */
function waitingSnapshot() {
  const fresh = liveSnapshot();
  return liveSnapshot({ ...fresh, vault: { ...fresh.vault, state: { ...fresh.vault.state!, lifetimeSaved: "0" } }, wallets: [{ ...fresh.wallets[0]!, link: { ...fresh.wallets[0]!.link, settlementNonce: "0" } }] });
}

const done = (html: string): number => html.split("line-through").length - 1;

/**
 * SINCE WHEN THE FIRST SAVING HAS BEEN AWAITED (10-09): from the link that
 * started the wait, as the chain dated it, with its day when that is not today
 * — and nothing when the loaded history cannot say, never a guess.
 */
describe("the first saving, awaited since the link", () => {
  const link = (ms: number, over: { readonly wallet?: string | null; readonly ok?: boolean; readonly seed?: number } = {}): LiveEntryJson => ({
    ...liveEntry(signature(over.seed ?? 7), seconds(ms), [{ kind: "linked", wallet: over.wallet === undefined ? WALLET_A : over.wallet } as VaultEventJson], 3_900),
    ok: over.ok ?? true,
  });
  const waitingWith = (entries: readonly LiveEntryJson[] | null): LiveDashboard =>
    liveDashboard({ snapshot: waitingSnapshot(), activity: entries === null ? null : liveActivity(entries) });
  const SINCE = /waiting since/;

  it("says since when, from the link, with its day once that is not today", () => {
    const data = waitingWith([link(NOW_MS - 26 * 3_600_000)]);
    expect(data.stage).toBe("waiting_first_settlement");
    expect(waitingSinceOf(data)).toBe(NOW_MS - 26 * 3_600_000);
    expect(render(data)).toContain(LIVE_COPY.setup.waitingSince("yesterday, 10:00 UTC"));
    expect(render(waitingWith([link(NOW_MS - 2 * 3_600_000)]))).toContain(LIVE_COPY.setup.waitingSince("10:00 UTC"));
  });

  it("counts from the wallet's latest link: an older one before an unlink is not when this wait began", () => {
    const data = waitingWith([link(NOW_MS - 3_600_000, { seed: 8 }), link(NOW_MS - 5 * 86_400_000)]);
    expect(waitingSinceOf(data)).toBe(NOW_MS - 3_600_000);
  });

  it("says nothing when the loaded history holds no successful link of the wallet linked now", () => {
    for (const entries of [null, [], [link(NOW_MS - 3_600_000, { ok: false })], [link(NOW_MS - 3_600_000, { wallet: "SomeOtherWa11et1111111111111111111111111111" })]]) {
      const data = waitingWith(entries);
      expect(waitingSinceOf(data)).toBeNull();
      expect(render(data)).not.toMatch(SINCE);
    }
  });

  it("is gone once the first saving has landed", () => {
    const data = liveDashboard({ activity: liveActivity([link(NOW_MS - 3 * 3_600_000)]) });
    expect(data.stage).toBe("active");
    expect(render(data)).not.toMatch(SINCE);
  });
});

describe("the setup, ticked off through the first buy", () => {
  it("lists what is done while the first saving is awaited, and the first buy ahead when a signed approval has buying on", () => {
    const data = liveDashboard({ snapshot: waitingSnapshot(), activity: null });
    expect(data.stage).toBe("waiting_first_settlement");
    const html = render(data);
    expect(html).toContain(LIVE_COPY.waiting.title);
    expect(html).toContain(LIVE_COPY.setup.checklist);
    for (const label of [LIVE_COPY.setup.vault, LIVE_COPY.setup.linked, LIVE_COPY.setup.firstSaving, LIVE_COPY.setup.firstBuy]) expect(html).toContain(label);
    // Vault created and the wallet linked; the first saving and the first buy still ahead.
    expect(done(html)).toBe(2);
  });

  it("promises no buy to a pension kept as SOL, or one whose choice this browser does not hold — and does to stocks chosen", () => {
    const data = liveDashboard({ snapshot: withPolicy("missing", waitingSnapshot()), activity: null });
    mocked.choice = { kind: "sol" };
    expect(render(data)).not.toContain(LIVE_COPY.setup.firstBuy);
    mocked.choice = null;
    expect(render(data)).not.toContain(LIVE_COPY.setup.firstBuy);
    mocked.choice = STOCKS;
    expect(render(data)).toContain(LIVE_COPY.setup.firstBuy);
  });

  it("stays once the pension is running, ticked to the first saving, until the first buy", () => {
    const data = liveDashboard();
    expect(data.stage).toBe("active");
    const html = render(data);
    expect(html).toContain(LIVE_COPY.firstBuy.title);
    expect(html).toContain(LIVE_COPY.firstBuy.body);
    expect(html).toContain(LIVE_COPY.setup.firstBuy);
    expect(done(html)).toBe(3);
    // Nothing to press: the buy is the keeper's to make.
    expect(mocked.buttons).toHaveLength(0);
  });

  it("says the approval comes first when stocks were chosen and nothing is signed yet", () => {
    mocked.choice = STOCKS;
    expect(render(liveDashboard({ snapshot: withPolicy("missing") }))).toContain(LIVE_COPY.firstBuy.approve);
  });

  it("shows nothing once running when no buy is on its way: buying off, kept as SOL, or an approval that could not be read", () => {
    expect(render(liveDashboard({ snapshot: withPolicy(policyState({ enabled: false })) }))).toBe("");
    mocked.choice = { kind: "sol" };
    expect(render(liveDashboard({ snapshot: withPolicy("missing") }))).toBe("");
    mocked.choice = STOCKS;
    expect(render(liveDashboard({ snapshot: withPolicy("unreadable") }))).toBe("");
  });

  it("firstBuyOf: done once the approval has spent, ahead while it can still buy, nothing promised otherwise", () => {
    const policy = (overrides: Parameters<typeof policyState>[0]) => liveDashboard({ snapshot: withPolicy(policyState(overrides)) });
    expect(firstBuyOf(policy({ lifetimeInvested: "1" }), null)).toBe("done");
    expect(firstBuyOf(policy({}), null)).toBe("ahead");
    expect(firstBuyOf(policy({ enabled: false }), null)).toBe("none");
    const missing = liveDashboard({ snapshot: withPolicy("missing") });
    expect(firstBuyOf(missing, null)).toBe("none");
    expect(firstBuyOf(missing, { kind: "sol" })).toBe("none");
    expect(firstBuyOf(missing, STOCKS as never)).toBe("ahead");
    // Stocks no longer on the shelf are no buy at all.
    expect(firstBuyOf(missing, { kind: "stocks", mints: ["NotOnTheShelf1111111111111111111111111111"] })).toBe("none");
  });

  /**
   * NO PROMISE THE CHAIN WOULD REFUSE (review, 10-09): invest.rs refuses while
   * the vault or the protocol is paused, and caps no balance can clear never
   * buy. The card then ends at the first saving, as for buying off.
   */
  it("promises no buy while the vault or the protocol is paused — and keeps a first buy that happened ticked", () => {
    const base = withPolicy(policyState());
    const vaultPaused = liveDashboard({ snapshot: { ...base, vault: { ...base.vault, state: { ...base.vault.state!, paused: true } } } });
    expect(vaultPaused.stage).toBe("active");
    expect(vaultPaused.vault.paused).toBe(true);
    expect(firstBuyOf(vaultPaused, null)).toBe("none");
    expect(render(vaultPaused)).toBe("");
    const protocolPaused = liveDashboard({ snapshot: { ...base, config: { ...base.config, paused: true } } });
    expect(protocolPaused.protocolPaused).toBe(true);
    expect(firstBuyOf(protocolPaused, null)).toBe("none");
    expect(render(protocolPaused)).toBe("");
    // Stocks chosen and nothing approved yet: a paused vault is promised nothing either.
    mocked.choice = STOCKS;
    const missing = withPolicy("missing");
    expect(firstBuyOf(liveDashboard({ snapshot: { ...missing, vault: { ...missing.vault, state: { ...missing.vault.state!, paused: true } } } }), STOCKS as never)).toBe("none");
    // Done is done, paused or not.
    const spent = withPolicy(policyState({ lifetimeInvested: "5000000" }));
    expect(firstBuyOf(liveDashboard({ snapshot: { ...spent, vault: { ...spent.vault, state: { ...spent.vault.state!, paused: true } } } }), null)).toBe("done");
  });

  it("promises no buy to a basket its caps make unbuyable at any balance", () => {
    // One call's cap under the minimum: no leg can ever clear it.
    expect(firstBuyOf(liveDashboard({ snapshot: withPolicy(policyState({ maxPerCall: "4000000" })) }), null)).toBe("none");
    // The 30-day limit under what the basket needs: never one buy in it.
    expect(firstBuyOf(liveDashboard({ snapshot: withPolicy(policyState({ maxRolling30d: "4000000" })) }), null)).toBe("none");
    expect(render(liveDashboard({ snapshot: withPolicy(policyState({ maxRolling30d: "4000000" })) }))).toBe("");
  });
});

describe("in the pension view's top column", () => {
  it("is one box that grows and closes, with the stage's card inside one swap — open at once on the first paint", () => {
    const html = render(liveDashboard({ snapshot: waitingSnapshot(), activity: null }), null, true);
    expect(html).toMatch(/^<div class="grid transition-\[grid-template-rows,opacity,margin-top\][^"]* grid-rows-\[1fr\] opacity-100 mt-0"><div class="min-h-0 min-w-0"><div><div><div data-slot="card"/);
    expect(html).not.toContain("animate-in");
  });

  it("draws nothing, and holds no gap, when there is no card", () => {
    expect(render(liveDashboard({ snapshot: withPolicy(policyState({ lifetimeInvested: "5000000" })) }), null, true)).toBe("");
  });
});

/**
 * WHAT WAS JUST SIGNED IS NOT OFFERED AGAIN (10-09, plan B4): the write that
 * moves the stage on, landed and not on the page yet, stands where its button
 * stood — turning while an update may bring it, still past the cap.
 */
describe("a signature that moves the stage on, not on the page yet", () => {
  const signedNow = (kind: LastWrite["kind"], state: WriteSync["state"] = "syncing"): WriteSync => ({
    write: { pensionKey: OWNER, kind, writer: "vault", signature: "sigCreate", slot: 9_999, at: Date.now() },
    state,
  });
  const withSync = (data: LiveDashboard, sync: WriteSync | null): string => {
    mocked.buttons.length = 0;
    return renderToStaticMarkup(createElement(LiveNextStep, { data, pensionKey: OWNER, seatProblem: null, onOpenWallets, sync }));
  };

  it("the vault created in the modal stands where Create stood — no second Create, no wallets-page way round", () => {
    const html = withSync(noVault(), signedNow("create"));
    expect(html).toContain(LIVE_COPY.syncing.vaultCreated);
    expect(html).toContain('data-syncing="syncing"');
    expect(html).toMatch(/<svg[^>]*class="[^"]*motion-safe:animate-spin[^"]*"/);
    expect(buttons(LIVE_COPY.noVault.create)).toHaveLength(0);
    expect(html).not.toContain(LIVE_COPY.noVault.openWallets);
    // The checklist is still the stage's own: nothing is ticked before the page shows it.
    expect(done(html)).toBe(0);
  });

  it("past the cap: the still clock, and when it was signed — never 'reading' with no update bringing it", () => {
    const html = withSync(noVault(), signedNow("create", "late"));
    expect(html).toMatch(/Signed at \d{2}:\d{2} UTC · not on this page yet/);
    expect(html).not.toContain(LIVE_COPY.syncing.vaultCreated);
    expect(html).not.toContain("animate-spin");
    expect(buttons(LIVE_COPY.noVault.create)).toHaveLength(0);
  });

  it("a link stands where Link stood, and a created-and-linked wallet where Create and Import stood", () => {
    expect(withSync(liveDashboard({ snapshot: unlinkedSnapshot(), activity: null }), signedNow("link"))).toContain(LIVE_COPY.syncing.signed);
    expect(buttons(LIVE_COPY.notLinked.link)).toHaveLength(0);
    const noWallet = liveDashboard({ snapshot: liveSnapshot({ wallets: [] }), activity: null, privyWallets: [] });
    expect(withSync(noWallet, signedNow("createLink"))).toContain(LIVE_COPY.syncing.signed);
    expect(buttons(LIVE_COPY.noTradingWallet.create)).toHaveLength(0);
    expect(buttons(LIVE_COPY.noTradingWallet.import)).toHaveLength(0);
  });

  it("any other signature leaves the stage's button where it is", () => {
    expect(withSync(noVault(), signedNow("rule"))).not.toContain(LIVE_COPY.syncing.signed);
    expect(buttons(LIVE_COPY.noVault.create)).toHaveLength(1);
    withSync(liveDashboard({ snapshot: unlinkedSnapshot(), activity: null }), signedNow("withdraw"));
    expect(buttons(LIVE_COPY.notLinked.link)).toHaveLength(1);
    // And with nothing to say, the card is the one it always was.
    expect(withSync(noVault(), null)).toBe(render(noVault()));
  });
});
