// The dashboard's "Your first savings arrived" card: what it would sign for a
// basket chosen on the setup, and when it may stand at all.

import { DEFAULT_INVEST_CAPS, OFFERED_LEGS, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT, defaultInvestPolicy } from "@sip/solana-core/client";
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
import { TooltipProvider } from "@/components/ui/tooltip";
import { VaultWriteLock } from "@/hooks/use-vault-actions";
import { VaultScreenContext, type VaultScreenValue } from "@/hooks/use-vault-state";
import { START_BUYING_COPY } from "@/lib/live-copy";
import type { LiveDashboard } from "@/lib/live-types";
import type { VaultApi, VaultStateJson } from "@/lib/vault-api";
import { DEFAULT_VENUE_NAME } from "@/lib/vault-flows";
import { liveDashboard, liveSnapshot, OWNER, VAULT } from "../../../test/fixtures/live-dashboard";

const [SPYX, ANTHROPIC] = OFFERED_LEGS.map((leg) => leg.mint);

describe("startBuyingPlan: what the card would sign", () => {
  it("one stock: all of it, the form's own minimum and 30-day cap, $25 per buy, investing on, the default venue", () => {
    const { request } = startBuyingPlan([SPYX!]);
    expect(request).not.toBeNull();
    expect([...request!.weights!.entries()]).toEqual([[SPYX, 10_000]]);
    expect(request!.maxPerCall).toBe(START_BUYING_PER_BUY_RAW);
    expect(request!.maxRolling30d).toBe(DEFAULT_INVEST_CAPS.maxRolling30d);
    expect(request!.minInvestment).toBe(defaultInvestPolicy(OFFERED_LEGS.length).minInvestment);
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
    // Nothing is bought before the whole buy clears each leg's minimum: $2.50 a leg, $5 in all.
    expect(purchaseRaw).toBe(5_000_000n);
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

function render(data: LiveDashboard, state: VaultStateJson = vaultState()): string {
  const screen: VaultScreenValue = { pensionKey: OWNER, view: { kind: "ready", state }, refresh: vi.fn(), api: {} as VaultApi };
  return renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(VaultScreenContext.Provider, { value: screen }, createElement(VaultWriteLock, null, createElement(LiveStartBuying, { data, pensionKey: OWNER, onRefresh: vi.fn() }))),
    ),
  );
}

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
    // The conversion is said whether or not today's prices could be read: this fixture has none for the legs.
    expect(html).toContain("Your SOL savings, now and later, are sold for USDC");
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
});
