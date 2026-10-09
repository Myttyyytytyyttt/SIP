// The dashboard's "Your first savings arrived" card: what it would sign for a
// basket chosen on the setup, and when it may stand at all.

import { DEFAULT_INVEST_CAPS, OFFERED_LEGS, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ choice: null as unknown }));

vi.mock("@/hooks/use-onboarding-closed", () => ({ useBasketChoice: () => mocked.choice }));
vi.mock("@privy-io/react-auth/solana", () => ({
  useWallets: () => ({ ready: true, wallets: [] }),
  useSignTransaction: () => ({ signTransaction: vi.fn() }),
  useSignMessage: () => ({ signMessage: vi.fn() }),
}));

import { LiveStartBuying, START_BUYING_PER_BUY_RAW, startBuyingPlan, startBuyingRent } from "@/components/live/LiveStartBuying";
import { START_BUYING_WRITER, type WriteSync } from "@/components/live/last-write-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VaultWriteLock, WriteLockContext, type WriteLock } from "@/hooks/use-vault-actions";
import { VaultScreenContext, type VaultScreenValue } from "@/hooks/use-vault-state";
import { LIVE_COPY, START_BUYING_COPY } from "@/lib/live-copy";
import type { LiveDashboard } from "@/lib/live-types";
import type { VaultApi, VaultStateJson } from "@/lib/vault-api";
import { INVEST_COPY, LINK_COPY } from "@/lib/vault-copy";
import { DEFAULT_VENUE_NAME } from "@/lib/vault-flows";
import { liveDashboard, liveSnapshot, OWNER, VAULT } from "../../../test/fixtures/live-dashboard";

const [SPYX, ANTHROPIC] = OFFERED_LEGS.map((leg) => leg.mint);

describe("startBuyingPlan: what the card would sign", () => {
  it("one stock: all of it, the $10 base as its minimum, the form's 30-day cap, $25 per buy, investing on, the default venue", () => {
    const { request } = startBuyingPlan([SPYX!]);
    expect(request).not.toBeNull();
    expect([...request!.weights!.entries()]).toEqual([[SPYX, 10_000]]);
    expect(request!.maxPerCall).toBe(START_BUYING_PER_BUY_RAW);
    expect(request!.maxRolling30d).toBe(DEFAULT_INVEST_CAPS.maxRolling30d);
    // THE $10 BASE (owner, 09-25): a one-stock basket buys when $10 is ready, not at a share of the shelf's $5.
    expect(request!.minInvestment).toBe(10_000_000n);
    expect(request!.enabled).toBe(true);
    expect(request!.venue).toBe(DEFAULT_VENUE_NAME);
  });

  it("both stocks: an equal split in whole percents, summing to 10,000, within the basket's window", () => {
    const { request, legs, purchaseRaw } = startBuyingPlan([ANTHROPIC!, SPYX!]);
    expect(request).not.toBeNull();
    // The shelf's order, whatever order the mints came in.
    expect([...request!.weights!.entries()]).toEqual([
      [SPYX, 5_000],
      [ANTHROPIC, 5_000],
    ]);
    expect(legs.map((leg) => leg.weightBps)).toEqual([5_000, 5_000]);
    // Nothing is bought before the whole buy clears each leg's minimum: $5 a leg, the $10 base in all.
    expect(request!.minInvestment).toBe(5_000_000n);
    expect(purchaseRaw).toBe(10_000_000n);
    expect(request!.maxPerCall).toBeGreaterThanOrEqual(purchaseRaw!);
  });

  it("offers nothing to sign for stocks not on the shelf", () => {
    expect(startBuyingPlan([]).request).toBeNull();
    expect(startBuyingPlan(["NotOnTheShelf1111111111111111111111111111"]).request).toBeNull();
  });
});

// ── when the card may stand ──────────────────────────────────────────────────

function vaultState(policy: "missing" | "exists" = "missing"): VaultStateJson {
  return {
    owner: OWNER,
    vault: { status: "exists", address: VAULT, lamports: "201285240", rentFloor: "1285240", withdrawableLamports: "200000000" },
    policy: policy === "missing" ? { status: "missing", address: `${VAULT}-policy` } : { status: "exists", address: `${VAULT}-policy` },
    config: { address: "config", status: "exists", exists: true, paused: false },
    walletLinks: [],
    holdings: { status: "exists", items: [] },
    vaultTokenAccounts: { status: "exists", items: [] },
    rents: { vault: "1285240", link: "1305560", policy: "7642080", tokenAccount: "2039280", legTokenAccounts: {} },
    prices: { slot: 1, convertWad: "100038711555492562", usdcRawPerSol: "100038711", legs: [] },
  } as unknown as VaultStateJson;
}

function render(data: LiveDashboard, state: VaultStateJson = vaultState(), lock: WriteLock | null = null): string {
  const screen: VaultScreenValue = { pensionKey: OWNER, view: { kind: "ready", state }, refresh: vi.fn(), api: {} as VaultApi };
  const card = createElement(LiveStartBuying, { data, pensionKey: OWNER, onRefresh: vi.fn() });
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(VaultScreenContext.Provider, { value: screen }, lock === null ? createElement(VaultWriteLock, null, card) : createElement(WriteLockContext.Provider, { value: lock }, card)),
    ),
  );
}

/** The page's lock, held by another write on the screen (a rule save, a link). */
const heldElsewhere: WriteLock = {
  holder: "rule-settings",
  acquire: () => false,
  release: () => undefined,
  consents: new Map(),
  unconfirmedLinks: new Set(),
  setUnconfirmedLink: () => undefined,
};

/** An active pension (its first settlement landed) with no investing policy. */
const activeNoPolicy = (): LiveDashboard => liveDashboard({ snapshot: liveSnapshot({ policy: { status: "missing", address: `${VAULT}-policy` } as never }) });

beforeEach(() => {
  mocked.choice = { kind: "stocks", mints: [SPYX, ANTHROPIC] };
});

describe("startBuyingRent: the rent this signature charges, as the build charges it", () => {
  const account = (mint: string, status: "missing" | "exists", tokenProgram = TOKEN_PROGRAM) => ({ mint, status, tokenProgram, address: `${mint}-ata` });
  const withAccounts = (items: unknown[]): VaultStateJson =>
    ({ ...vaultState(), vaultTokenAccounts: { status: "exists", items }, rents: { ...vaultState().rents, legTokenAccounts: { [SPYX!]: "2136720", [ANTHROPIC!]: "2220240" } } }) as unknown as VaultStateJson;

  it("counts the policy and at most two missing accounts among wSOL, USDC and the chosen stocks — never the ones the keeper creates", () => {
    const fresh = withAccounts([
      account(WSOL_MINT, "missing"),
      account(USDC_MINT, "missing"),
      account(SPYX!, "missing", TOKEN_2022_PROGRAM),
      account(ANTHROPIC!, "missing", TOKEN_2022_PROGRAM),
    ]);
    // policy 7,642,080 + wSOL 2,039,280 + USDC 2,039,280: the two stock accounts ride on the keeper.
    expect(startBuyingRent(fresh, [SPYX!, ANTHROPIC!])).toBe(7_642_080n + 2_039_280n + 2_039_280n);
    // With wSOL and USDC already there, the chosen stock's account rides along — and only the chosen one.
    const holding = withAccounts([account(WSOL_MINT, "exists"), account(USDC_MINT, "exists"), account(SPYX!, "missing", TOKEN_2022_PROGRAM), account(ANTHROPIC!, "missing", TOKEN_2022_PROGRAM)]);
    expect(startBuyingRent(holding, [SPYX!])).toBe(7_642_080n + 2_136_720n);
  });

  it("says nothing it could not read", () => {
    expect(startBuyingRent({ ...vaultState(), vaultTokenAccounts: { status: "unreadable", items: [] } } as unknown as VaultStateJson, [SPYX!])).toBeNull();
  });
});

describe("LiveStartBuying", () => {
  it("stands once the first savings arrived, for stocks chosen on the setup, and asks for the tick before it signs", () => {
    const data = activeNoPolicy();
    expect(data.stage).toBe("active");
    const html = render(data);
    expect(html).toContain(START_BUYING_COPY.title);
    expect(html).toContain(START_BUYING_COPY.lede("SPYx and ANTHROPIC, 50 % each"));
    expect(html).toContain(START_BUYING_COPY.details);
    expect(html).toContain('name="start-buying-acknowledge"');
    // Unticked: the button is there and greyed.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Start buying<\/button>/);
    expect(html).toContain(START_BUYING_COPY.keepSol);
    // The fee line for the leg whose issuer charges, and none for the one that cannot.
    expect(html).toContain("ANTHROPIC’s issuer takes");
    expect(html).not.toContain("SPYx’s issuer takes");
    // NO SIGNED PRICE FLOOR (owner, 2026-10-08): one line on the card, and the
    // keeper's checks and what the chain still enforces under the details.
    expect(html).toContain(START_BUYING_COPY.livePrice);
    expect(html).toContain(INVEST_COPY.priceTitle);
    expect(html).toContain("the quote less 2 % (4 % for ANTHROPIC)");
    expect(html).toContain("If SaverFi&#x27;s keeper failed, or its key were stolen, nothing on Solana would stop a buy at a bad price");
    expect(html).not.toMatch(/never sold below|never bought above|Price limits are set/);
    // The conversion is said, at the live price.
    expect(html).toContain("Your SOL savings, now and later, are sold for USDC at the live price");
    // The depth risk the full form puts in an amber box is under the details too.
    expect(html).toContain("buys only where the market can take the whole buy");

  });

  it("stays away when there is nothing to ask: SOL chosen, no choice here, a policy already, or no savings yet", () => {
    mocked.choice = { kind: "sol" };
    expect(render(activeNoPolicy())).toBe("");
    mocked.choice = null;
    expect(render(activeNoPolicy())).toBe("");
    mocked.choice = { kind: "stocks", mints: [SPYX] };
    // A policy on the live read.
    expect(render(liveDashboard())).toBe("");
    // A policy on the vault screen's own read, while the live one is behind.
    expect(render(activeNoPolicy(), vaultState("exists"))).toBe("");
    // No settlement yet: nothing saved, no settlement on the link, no history.
    const base = liveSnapshot();
    const wallet = base.wallets[0]!;
    const waiting = liveDashboard({
      snapshot: liveSnapshot({
        policy: { status: "missing", address: `${VAULT}-policy` } as never,
        vault: { ...base.vault, state: { ...(base.vault as { state: object }).state, lifetimeSaved: "0" } } as never,
        wallets: [{ ...wallet, link: { ...wallet.link!, settlementNonce: "0" } }] as never,
      }),
      activity: null,
    });
    expect(waiting.stage).toBe("waiting_first_settlement");
    expect(render(waiting)).toBe("");
  });

  it("says why its buttons are greyed while another signature holds the page's lock, and only then", () => {
    const html = render(activeNoPolicy(), vaultState(), heldElsewhere);
    expect(html).toContain(LINK_COPY.busy);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Keep as SOL<\/button>/);
    expect(render(activeNoPolicy())).not.toContain(LINK_COPY.busy);
  });

  it("stands in a box that grows in and closes over its last state — simply open on the page's first paint", () => {
    const html = render(activeNoPolicy());
    expect(html).toMatch(/^<div class="grid transition-\[grid-template-rows,opacity,margin-top\][^"]* grid-rows-\[1fr\] opacity-100 mt-0"><div class="min-h-0 min-w-0"><div[^>]*data-start-buying=""/);
  });
});

/**
 * ITS APPROVAL, LANDED AND NOT ON THE PAGE YET (10-09, plan B4): nothing left to
 * press — the tick, Start buying and Keep as SOL give way — and the card says
 * the pension is updating, or past the cap that it is not on this page yet.
 */
describe("once its approval has landed", () => {
  const own = (state: WriteSync["state"], writer = START_BUYING_WRITER): WriteSync => ({
    write: { pensionKey: OWNER, kind: "policy", writer, signature: "sigBuying", slot: 9_999, at: Date.now() },
    state,
  });
  const withSync = (sync: WriteSync | null): string => {
    const screen: VaultScreenValue = { pensionKey: OWNER, view: { kind: "ready", state: vaultState() }, refresh: vi.fn(), api: {} as VaultApi };
    return renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(VaultScreenContext.Provider, { value: screen }, createElement(VaultWriteLock, null, createElement(LiveStartBuying, { data: activeNoPolicy(), pensionKey: OWNER, onRefresh: vi.fn(), sync }))),
      ),
    );
  };

  it("offers nothing more to sign or choose, and says the pension is updating", () => {
    const html = withSync(own("syncing"));
    expect(html).toContain(START_BUYING_COPY.title);
    expect(html).not.toContain('name="start-buying-acknowledge"');
    expect(html).not.toContain(`>${START_BUYING_COPY.start}</button>`);
    expect(html).not.toContain(START_BUYING_COPY.keepSol);
    expect(html).toContain(LIVE_COPY.syncing.signed);
    expect(html).toMatch(/<svg[^>]*class="[^"]*motion-safe:animate-spin[^"]*"/);
  });

  it("past the cap, says when it was signed and that the page does not show it yet — still", () => {
    const html = withSync(own("late"));
    expect(html).toMatch(/Signed at \d{2}:\d{2} UTC · not on this page yet/);
    expect(html).not.toContain(LIVE_COPY.syncing.signed);
    expect(html).not.toContain(`>${START_BUYING_COPY.start}</button>`);
  });

  it("another card's signature changes nothing here", () => {
    expect(withSync(own("syncing", "policy"))).toBe(withSync(null));
    expect(withSync(null)).toContain('name="start-buying-acknowledge"');
  });
});
