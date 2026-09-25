// THE VAULT SETTINGS' LIVE ARITHMETIC, PINNED.
//
// The gear's one Save can sign two instructions that each write EVERY field of
// their account, so the failure these tests exist for is a field the dialog
// does not show going out as a guess: a stored limit overwritten with 0, a
// paused policy quietly resumed, a basket reset to the shelf's equal split, a
// cap left outside the window of the basket it now caps. Each case reads
// exactly what would be handed to the wallet.

import { ANTHROPIC_MINT, DEFAULT_INVEST_CAPS, DEFAULT_RATES, FIGUREAI_MINT, JUPITER_V6, MODE_PROFIT, MODE_VOLUME, SPYX_MINT, investmentReadiness } from "@sip/solana-core/client";
import { describe, expect, it } from "vitest";

import {
  LEAST_THRESHOLD_RAW,
  liveCategories,
  liveSeed,
  planSettings,
  refreshRequest,
  settingsPolicyPlan,
  type LiveSeed,
} from "@/components/live/rule-settings-plan";
import { START_BUYING_PER_BUY_RAW } from "@/components/live/LiveStartBuying";
import { atLeastUsd, atMostUsd, resignStoredPolicy } from "@/components/wallets/InvestingCard";
import { formatUsd, rawFrom } from "@/lib/amounts";
import { basketLimits, catalogueAsset } from "@/lib/basket-picker";
import { LIVE_COPY } from "@/lib/live-copy";
import type { BasketChoice } from "@/lib/onboarding-memory";
import { BASE_THRESHOLD_RAW, minimumFor, type SettingsDraft } from "@/lib/rule-settings";
import { SETTINGS_COPY } from "@/lib/settings-copy";
import type { InvestmentPolicyJson, VaultAccountJson, VaultStateJson } from "@/lib/vault-api";
import { INVEST_COPY, VAULT_COPY, ratePercent } from "@/lib/vault-copy";

import { liveSnapshot, policyState } from "../../../test/fixtures/live-dashboard";

/** The vault account as the chain stores it: profit at 20 %, volume 2 % unused, limits 0.06 / 0.05 SOL. */
const ACCOUNT = liveSnapshot().vault.state! as unknown as VaultAccountJson;

const leg = (mint: string, weightBps: number) => ({ mint, weightBps, minOutRateWad: "1" });

/** The owner's policy today: SPYx and ANTHROPIC at 50/50, $5 a leg ($10 in all), $149 per buy, on Jupiter. */
const OWNERS_POLICY = policyState({
  venueProgram: JUPITER_V6,
  legs: [leg(SPYX_MINT, 5_000), leg(ANTHROPIC_MINT, 5_000)],
  minInvestment: "5000000",
  maxPerCall: "149000000",
  maxRolling30d: "4619000000",
});

function vaultState(
  policy: InvestmentPolicyJson | null,
  options: { readonly status?: "exists" | "missing" | "unreadable"; readonly account?: Partial<VaultAccountJson> | null } = {},
): VaultStateJson {
  const status = options.status ?? (policy === null ? "missing" : "exists");
  const account = options.account === null ? undefined : { ...ACCOUNT, ...(options.account ?? {}) };
  return {
    owner: "owner",
    programId: "program",
    vault: { status: account === undefined ? "missing" : "exists", address: "vault", ...(account === undefined ? {} : { state: account }) },
    policy: { status, address: "policy", ...(policy === null ? {} : { state: policy }) },
    config: { address: "config", status: "exists", exists: true, paused: false },
    walletLinks: [],
    holdings: { status: "exists", items: [] },
    vaultTokenAccounts: { status: "exists", items: [] },
    rents: null,
    prices: null,
  } as unknown as VaultStateJson;
}

function seedOf(state: VaultStateJson, choice: BasketChoice | null = null): LiveSeed {
  const seed = liveSeed(state, choice);
  if ("problem" in seed) throw new Error(`no seed: ${seed.problem}`);
  return seed;
}

/** planSettings over a seed and the draft it opened on, with `edit` applied. */
function plan(state: VaultStateJson, edit: Partial<SettingsDraft>, options: { readonly choice?: BasketChoice | null; readonly volumeOffered?: boolean } = {}) {
  const seed = seedOf(state, options.choice ?? null);
  return planSettings({ state, seed, draft: { ...seed.draft, ...edit }, volumeOffered: options.volumeOffered ?? false });
}

const weightsOf = (map: ReadonlyMap<string, number> | undefined) => [...(map ?? new Map<string, number>()).entries()];

// ── (1) THE SEED ─────────────────────────────────────────────────────────────

describe("liveSeed: what the dialog opens on", () => {
  it("reads the rule off the vault and the basket off the policy, at the threshold the policy invests at", () => {
    const seed = seedOf(vaultState(OWNERS_POLICY));
    expect(seed.draft).toEqual({
      mode: "profit",
      rateBps: 2_000,
      paused: false,
      picked: [
        { id: SPYX_MINT, percent: "50" },
        { id: ANTHROPIC_MINT, percent: "50" },
      ],
      threshold: "10",
    });
    expect(seed.rates).toEqual({ profit: 2_000, volume: 200 });
    expect(seed.buying).toMatchObject({ kind: "policy", thresholdRaw: 10_000_000n, caps: { maxPerCall: 149_000_000n, maxRolling30d: 4_619_000_000n }, venue: "jupiter-v6", enabled: true, notices: [] });
  });

  it("says so when the stored venue cannot be checked and the default stands in for it", () => {
    const seed = seedOf(vaultState(policyState()));
    expect(seed.buying.kind).toBe("policy");
    if (seed.buying.kind !== "policy") return;
    expect(seed.buying.venue).toBe("jupiter-v6");
    expect(seed.buying.notices).toEqual([INVEST_COPY.editVenueReplaced("jupiter-v6")]);
    // One leg at $5 invests at $5: the stored threshold, not the $10 base.
    expect(seed.draft.threshold).toBe("5");
  });

  it("opens a volume vault on its volume rate", () => {
    const seed = seedOf(vaultState(OWNERS_POLICY, { account: { skimMode: MODE_VOLUME } }));
    expect([seed.draft.mode, seed.draft.rateBps]).toEqual(["volume", 200]);
  });

  it("with no policy: the choice kept on this device, at its equal split, and the $10 base", () => {
    const seed = seedOf(vaultState(null), { kind: "stocks", mints: [ANTHROPIC_MINT, SPYX_MINT] });
    expect(seed.buying).toEqual({ kind: "choice", choice: { kind: "stocks", mints: [SPYX_MINT, ANTHROPIC_MINT] } });
    expect(seed.draft.picked).toEqual([
      { id: SPYX_MINT, percent: "50" },
      { id: ANTHROPIC_MINT, percent: "50" },
    ]);
    expect(seed.draft.threshold).toBe("10");
    expect(seedOf(vaultState(null)).draft.picked).toEqual([]);
  });

  it("locks the Buying half, with its reason, when the policy cannot be read or put back on a form", () => {
    expect(seedOf(vaultState(null, { status: "unreadable" })).buying).toEqual({ kind: "locked", message: LIVE_COPY.policyUnreadable });
    const fractional = policyState({ venueProgram: JUPITER_V6, legs: [leg(SPYX_MINT, 3_333), leg(ANTHROPIC_MINT, 6_667)] });
    expect(seedOf(vaultState(fractional)).buying).toEqual({ kind: "locked", message: INVEST_COPY.editFractionalShare("SPYx", ratePercent(3_333)) });
  });

  it("offers no seed at all without a vault account", () => {
    expect(liveSeed(vaultState(OWNERS_POLICY, { account: null }), null)).toEqual({ problem: VAULT_COPY.noVault });
  });

  it("keys the form on what it opened on", () => {
    const a = seedOf(vaultState(OWNERS_POLICY)).key;
    expect(seedOf(vaultState(OWNERS_POLICY)).key).toBe(a);
    expect(seedOf(vaultState(OWNERS_POLICY, { account: { skimBps: 3_000 } })).key).not.toBe(a);
    expect(seedOf(vaultState({ ...OWNERS_POLICY, enabled: false })).key).not.toBe(a);
    expect(seedOf(vaultState({ ...OWNERS_POLICY, maxPerCall: "100000000" })).key).not.toBe(a);
  });
});

// ── (3) SAVING: set_policy_v2 ────────────────────────────────────────────────

describe("planSettings, Saving: all six fields, the ones not shown exactly as stored", () => {
  it("a rate change sends the rate and the other five as the chain holds them — and nothing for Buying", () => {
    const result = plan(vaultState(OWNERS_POLICY), { rateBps: 3_000 });
    expect(result.problem).toBeNull();
    expect(result.rule).toEqual({ mode: MODE_PROFIT, skimBps: 3_000, volumeBps: 200, paused: false, maxContribution: 60_000_000n, walletReserve: 50_000_000n });
    expect(result.policy).toBeNull();
    expect(result.changes).toEqual({ rule: true, buying: false });
    expect(result.approvals).toBe(1);
  });

  it("a pause sends the stored rate back unchanged", () => {
    expect(plan(vaultState(OWNERS_POLICY), { paused: true }).rule).toEqual({
      mode: MODE_PROFIT,
      skimBps: 2_000,
      volumeBps: 200,
      paused: true,
      maxContribution: 60_000_000n,
      walletReserve: 50_000_000n,
    });
  });

  it("nothing changed: nothing is signed (set_policy_v2 would bump the nonce even so)", () => {
    const result = plan(vaultState(OWNERS_POLICY), {});
    expect(result).toMatchObject({ rule: null, policy: null, choice: null, problem: null, approvals: 0, changes: { rule: false, buying: false } });
  });

  it("refuses Volume while SaverFi does not offer it, and signs it whole when it does", () => {
    const refused = plan(vaultState(OWNERS_POLICY), { mode: "volume", rateBps: 100 });
    expect(refused.rule).toBeNull();
    expect(refused.problem).toEqual({ section: "saving", message: LIVE_COPY.volumeNotOffered });
    expect(plan(vaultState(OWNERS_POLICY), { mode: "volume", rateBps: 100 }, { volumeOffered: true }).rule).toEqual({
      mode: MODE_VOLUME,
      skimBps: 2_000,
      volumeBps: 100,
      paused: false,
      maxContribution: 60_000_000n,
      walletReserve: 50_000_000n,
    });
  });

  it("a legacy volume vault can only move to Profit, and any other rule from it is refused up front", () => {
    const state = vaultState(OWNERS_POLICY, { account: { skimMode: MODE_VOLUME } });
    expect(plan(state, { mode: "profit", rateBps: 2_000 }).rule).toEqual({ mode: MODE_PROFIT, skimBps: 2_000, volumeBps: 200, paused: false, maxContribution: 60_000_000n, walletReserve: 50_000_000n });
    expect(plan(state, { paused: true }).problem).toEqual({ section: "saving", message: LIVE_COPY.volumeNotOffered });
  });

  it("an unreadable limit is a refusal, never 0n", () => {
    for (const account of [{ maxContribution: null }, { walletReserve: "not a number" }] as Partial<VaultAccountJson>[]) {
      const result = plan(vaultState(OWNERS_POLICY, { account }), { rateBps: 3_000 });
      expect(result.rule).toBeNull();
      expect(result.problem).toEqual({ section: "saving", message: VAULT_COPY.unreadable });
    }
  });

  it("refuses a rate outside the mode's range", () => {
    expect(plan(vaultState(OWNERS_POLICY), { rateBps: 150 }).problem).toEqual({ section: "saving", message: SETTINGS_COPY.rateOutOfRange("2.01 %", "100 %") });
  });
});

// ── (3) BUYING: set_invest_policy ────────────────────────────────────────────

describe("planSettings, Buying: every field re-sent", () => {
  it("a threshold edit keeps the stored caps, the stored `enabled` (a paused policy stays paused) and the stored basket", () => {
    const paused = { ...OWNERS_POLICY, enabled: false };
    const result = plan(vaultState(paused), { threshold: "20" });
    expect(result.problem).toBeNull();
    expect(result.rule).toBeNull();
    expect(result.policy).toEqual({
      maxPerCall: 149_000_000n,
      maxRolling30d: 4_619_000_000n,
      enabled: false,
      minInvestment: minimumFor(20_000_000n, [5_000, 5_000]),
      weights: new Map([
        [SPYX_MINT, 5_000],
        [ANTHROPIC_MINT, 5_000],
      ]),
      venue: "jupiter-v6",
    });
    expect(result.policy!.minInvestment).toBe(10_000_000n);
    expect(result.notices).toContain(SETTINGS_COPY.buyingStaysPaused);
    expect(result.changes).toEqual({ rule: false, buying: true });
    expect(result.approvals).toBe(1);
  });

  it("a basket edit re-derives the per-leg minimum from the $10 threshold, and a new leg asks for the issuer box", () => {
    const spyxOnly = policyState({ venueProgram: JUPITER_V6, legs: [leg(SPYX_MINT, 10_000)], minInvestment: "10000000", maxPerCall: "25000000", maxRolling30d: "775000000" });
    const result = plan(vaultState(spyxOnly), {
      picked: [
        { id: SPYX_MINT, percent: "50" },
        { id: ANTHROPIC_MINT, percent: "50" },
      ],
    });
    expect(result.problem).toBeNull();
    expect(result.policy).toMatchObject({ maxPerCall: 25_000_000n, maxRolling30d: 775_000_000n, enabled: true, minInvestment: 5_000_000n, venue: "jupiter-v6" });
    expect(weightsOf(result.policy!.weights)).toEqual([
      [SPYX_MINT, 5_000],
      [ANTHROPIC_MINT, 5_000],
    ]);
    expect(result.newLegs.map((asset) => asset.mint)).toEqual([ANTHROPIC_MINT]);
    expect(result.acknowledge).toContain("ANTHROPIC");
  });

  it("the same basket in another order, at the same threshold, signs nothing", () => {
    const result = plan(vaultState(OWNERS_POLICY), {
      picked: [
        { id: ANTHROPIC_MINT, percent: "50" },
        { id: SPYX_MINT, percent: "50" },
      ],
      threshold: "10.00",
    });
    expect(result).toMatchObject({ policy: null, rule: null, problem: null, approvals: 0 });
  });

  it("both halves: the rule and the policy, two approvals", () => {
    const result = plan(vaultState(OWNERS_POLICY), { rateBps: 3_000, threshold: "20" });
    expect(result.rule).not.toBeNull();
    expect(result.policy).not.toBeNull();
    expect(result.approvals).toBe(2);
  });

  it("shares that do not add up, a threshold under $1 and one that is not a number are the Buying half's refusals", () => {
    expect(plan(vaultState(OWNERS_POLICY), { picked: [{ id: SPYX_MINT, percent: "50" }, { id: ANTHROPIC_MINT, percent: "40" }] }).problem).toEqual({
      section: "buying",
      message: INVEST_COPY.weightsSum("90 %"),
    });
    expect(plan(vaultState(OWNERS_POLICY), { threshold: "0.5" }).problem).toEqual({ section: "buying", message: SETTINGS_COPY.thresholdTooSmall(formatUsd(LEAST_THRESHOLD_RAW)) });
    const typo = plan(vaultState(OWNERS_POLICY), { threshold: "ten" });
    expect(typo.policy).toBeNull();
    expect(typo.problem?.section).toBe("buying");
  });

  it("a policy cannot be emptied from here: pausing is how buying stops", () => {
    expect(plan(vaultState(OWNERS_POLICY), { picked: [] }).problem).toEqual({ section: "buying", message: INVEST_COPY.basketEmpty });
  });

  it("an asset the shelf refuses is never signed into a basket", () => {
    const result = plan(vaultState(OWNERS_POLICY), { picked: [{ id: SPYX_MINT, percent: "50" }, { id: FIGUREAI_MINT, percent: "50" }] });
    expect(result.policy).toBeNull();
    expect(result.problem).toEqual({ section: "buying", message: SETTINGS_COPY.notOnShelf("FIGUREAI") });
  });
});

describe("settingsPolicyPlan: the $10 base, and the cap held inside the window", () => {
  it("$10 is the basket's threshold whatever the number of assets", () => {
    const at = (picked: { id: string; percent: string }[]) =>
      settingsPolicyPlan({ picked, threshold: "10", stored: null, enabled: true, venue: "jupiter-v6" }).request!.minInvestment;
    expect(at([{ id: SPYX_MINT, percent: "100" }])).toBe(10_000_000n);
    expect(
      at([
        { id: SPYX_MINT, percent: "50" },
        { id: ANTHROPIC_MINT, percent: "50" },
      ]),
    ).toBe(5_000_000n);
    // Three legs cannot be built from today's two-stock shelf; the arithmetic is the same function.
    expect(minimumFor(BASE_THRESHOLD_RAW, [3_400, 3_300, 3_300])).toBe(3_300_000n);
    // And each comes back as exactly $10 through the keeper's own reading of it (pending.ts).
    for (const weights of [[10_000], [5_000, 5_000], [3_400, 3_300, 3_300]]) {
      const legs = weights.map((weightBps) => ({ weightBps }));
      expect(investmentReadiness(0n, legs, minimumFor(BASE_THRESHOLD_RAW, weights), 1_000_000_000n)!.investsAtRaw).toBe(BASE_THRESHOLD_RAW);
    }
  });

  it("with no stored cap it starts at the start card's $25, inside the window", () => {
    const result = settingsPolicyPlan({ picked: [{ id: SPYX_MINT, percent: "100" }], threshold: "10", stored: null, enabled: true, venue: "jupiter-v6" });
    expect(result.request).toMatchObject({ maxPerCall: START_BUYING_PER_BUY_RAW, maxRolling30d: DEFAULT_INVEST_CAPS.maxRolling30d });
    expect(result.capMoved).toBeNull();
    expect(result.newLegs.map((asset) => asset.symbol)).toEqual(["SPYx"]);
  });

  it("a stored $1,000 cap over 100 % ANTHROPIC comes down to the ceiling, and says so", () => {
    const anthropic = catalogueAsset(ANTHROPIC_MINT)!;
    const window = basketLimits([{ asset: anthropic, weightBps: 10_000 }], 10_000_000n);
    expect(window.ceilingRaw).toBe(149_000_000n);
    const result = settingsPolicyPlan({
      picked: [{ id: ANTHROPIC_MINT, percent: "100" }],
      threshold: "10",
      stored: { maxPerCall: 1_000_000_000n, maxRolling30d: 31_000_000_000n },
      enabled: true,
      venue: "jupiter-v6",
    });
    expect(result.problem).toBeNull();
    expect(result.capMoved).toEqual({ from: 1_000_000_000n, to: 149_000_000n });
    expect(result.request).toMatchObject({ maxPerCall: 149_000_000n, maxRolling30d: 31_000_000_000n, minInvestment: 10_000_000n });

    // Through planSettings the move is said before Save.
    const stored = policyState({ venueProgram: JUPITER_V6, legs: [leg(SPYX_MINT, 10_000)], minInvestment: "10000000", maxPerCall: "1000000000" });
    const planned = plan(vaultState(stored), { picked: [{ id: ANTHROPIC_MINT, percent: "100" }] });
    expect(planned.policy?.maxPerCall).toBe(149_000_000n);
    expect(planned.notices).toContain(SETTINGS_COPY.capMoved("$1,000.00", "$149.00"));
  });

  it("a stored cap under a raised threshold's floor comes up to it", () => {
    const result = settingsPolicyPlan({
      picked: [{ id: SPYX_MINT, percent: "100" }],
      threshold: "50",
      stored: { maxPerCall: 25_000_000n, maxRolling30d: 30_000_000n },
      enabled: true,
      venue: "jupiter-v6",
    });
    expect(result.capMoved).toEqual({ from: 25_000_000n, to: 50_000_000n });
    // The 30-day cap is never under one buy.
    expect(result.request).toMatchObject({ maxPerCall: 50_000_000n, maxRolling30d: 50_000_000n, minInvestment: 50_000_000n });
  });

  it("a threshold above the ceiling is refused with the empty window, never with a cap raised past it", () => {
    const result = settingsPolicyPlan({
      picked: [{ id: ANTHROPIC_MINT, percent: "100" }],
      threshold: "200",
      stored: { maxPerCall: 149_000_000n, maxRolling30d: 4_619_000_000n },
      enabled: true,
      venue: "jupiter-v6",
    });
    expect(result.request).toBeNull();
    expect(result.problem).toBe(INVEST_COPY.capWindowEmpty(atLeastUsd(200_000_000n), atMostUsd(149_000_000n), "ANTHROPIC"));
  });

  it("names the lightest leg's slice, so a leg too small to measure can be warned about", () => {
    const result = settingsPolicyPlan({
      picked: [
        { id: SPYX_MINT, percent: "90" },
        { id: ANTHROPIC_MINT, percent: "10" },
      ],
      threshold: "10",
      stored: null,
      enabled: true,
      venue: "jupiter-v6",
    });
    expect(result.lightest?.symbol).toBe("ANTHROPIC");
    expect(result.lightestSliceRaw).toBe(1_000_000n);
  });
});

// ── (3) NO POLICY: a choice, never a signature ───────────────────────────────

describe("planSettings with no policy: the basket is a choice kept on this device", () => {
  it("picking stocks keeps them as a choice, in the shelf's order, and signs nothing", () => {
    const result = plan(vaultState(null), {
      picked: [
        { id: ANTHROPIC_MINT, percent: "50" },
        { id: SPYX_MINT, percent: "50" },
      ],
    });
    expect(result).toMatchObject({ rule: null, policy: null, problem: null, approvals: 0, choice: { kind: "stocks", mints: [SPYX_MINT, ANTHROPIC_MINT] } });
  });

  it("unpicking everything keeps SOL; the same stocks again changes nothing", () => {
    const stocks: BasketChoice = { kind: "stocks", mints: [SPYX_MINT] };
    expect(plan(vaultState(null), { picked: [] }, { choice: stocks }).choice).toEqual({ kind: "sol" });
    expect(plan(vaultState(null), {}, { choice: stocks }).choice).toBeNull();
  });

  it("the threshold is not the choice's to change: it applies when buying starts", () => {
    expect(plan(vaultState(null), { threshold: "25" }).changes.buying).toBe(false);
  });

  it("a stock setup does not offer cannot be kept", () => {
    expect(plan(vaultState(null), { picked: [{ id: FIGUREAI_MINT, percent: "100" }] }).problem).toEqual({ section: "buying", message: SETTINGS_COPY.notOnShelf("FIGUREAI") });
  });
});

// ── (4) REFRESH PRICE LIMITS ─────────────────────────────────────────────────

describe("refreshRequest: the investing card's 'Sign again', byte for byte", () => {
  /** What InvestingCard's PolicySummary hands `start` on "Sign again" (InvestingCard.tsx). */
  function signAgain(policy: InvestmentPolicyJson) {
    const resign = resignStoredPolicy(policy);
    if (!resign.ok) throw new Error(resign.message);
    const maxPerCall = rawFrom(policy.maxPerCall) ?? 0n;
    const maxRolling30d = rawFrom(policy.maxRolling30d) ?? 0n;
    return { maxPerCall, maxRolling30d, enabled: policy.enabled, minInvestment: resign.minInvestment, weights: resign.weights };
  }

  it("equals it on the owner's policy, and on a paused one", () => {
    for (const policy of [OWNERS_POLICY, { ...OWNERS_POLICY, enabled: false }]) {
      const request = refreshRequest(policy);
      expect(request).toEqual(signAgain(policy));
      expect("venue" in request).toBe(false);
    }
  });

  it("refuses with resign's own reason when the stored cap is over its basket's ceiling", () => {
    const over = policyState({ venueProgram: JUPITER_V6, legs: [leg(ANTHROPIC_MINT, 10_000)], minInvestment: "10000000", maxPerCall: "1000000000" });
    const resign = resignStoredPolicy(over);
    expect(resign.ok).toBe(false);
    expect(refreshRequest(over)).toEqual({ problem: resign.ok ? "" : resign.message });
  });
});

// ── (5) THE SHELF ────────────────────────────────────────────────────────────

describe("liveCategories: the catalogue as the dialog lists it", () => {
  it("lists stocks & funds first, then private companies, each offered asset tickable by mint", () => {
    const categories = liveCategories();
    expect(categories.map((category) => category.id)).toEqual(["xstock", "prestock"]);
    const [xstock, prestock] = categories;
    expect(xstock!.title).toBe(SETTINGS_COPY.categories.xstock);
    expect(xstock!.help).toBe(SETTINGS_COPY.help.xstock);
    expect(prestock!.title).toBe(SETTINGS_COPY.categories.prestock);
    expect(xstock!.assets.map((asset) => asset.id)).toContain(SPYX_MINT);
    expect(prestock!.assets.map((asset) => asset.id)).toContain(ANTHROPIC_MINT);
    expect(prestock!.assets.find((asset) => asset.id === ANTHROPIC_MINT)).toMatchObject({ symbol: "ANTHROPIC" });
  });

  it("names the refused ones and never offers them as tiles", () => {
    const prestock = liveCategories().find((category) => category.id === "prestock")!;
    expect(prestock.unavailable).toContain("FIGUREAI");
    const tickable = liveCategories().flatMap((category) => category.assets.map((asset) => asset.symbol));
    for (const symbol of prestock.unavailable) expect(tickable).not.toContain(symbol);
  });
});

// ── review fixes and the switch to Volume (09-25) ────────────────────────────

describe("a stored leg the shelf no longer offers", () => {
  const withRetired = policyState({
    venueProgram: JUPITER_V6,
    legs: [leg(SPYX_MINT, 5_000), leg(FIGUREAI_MINT, 5_000)],
    minInvestment: "5000000",
    maxPerCall: "149000000",
    maxRolling30d: "4619000000",
  });

  it("does not make the untouched form read as a basket change", () => {
    const result = plan(vaultState(withRetired), {});
    expect(result.changes.buying).toBe(false);
    expect(result.approvals).toBe(0);
  });

  it("never blocks a pause or a new rate behind a basket nobody edited", () => {
    const paused = plan(vaultState(withRetired), { paused: true });
    expect(paused.problem).toBeNull();
    expect(paused.rule?.paused).toBe(true);
    expect(paused.policy).toBeNull();
  });
});

describe("switching a profit vault to Volume", () => {
  it("starts the bar at the product's default volume rate, not the leftover the vault was created with", () => {
    const seed = seedOf(vaultState(OWNERS_POLICY, { account: { volumeBps: 150 } }));
    expect(seed.draft.mode).toBe("profit");
    expect(seed.rates.volume).toBe(DEFAULT_RATES.volumeBps);
  });

  it("keeps a volume vault's own chosen rate", () => {
    const seed = seedOf(vaultState(OWNERS_POLICY, { account: { skimMode: MODE_VOLUME, volumeBps: 150 } }));
    expect(seed.rates.volume).toBe(150);
  });

  it("signs mode 1 and the new volume rate, every other field exactly as stored, and says what the switch means", () => {
    const result = plan(vaultState(OWNERS_POLICY), { mode: "volume", rateBps: 100 }, { volumeOffered: true });
    expect(result.problem).toBeNull();
    expect(result.rule).toEqual({
      mode: MODE_VOLUME,
      skimBps: ACCOUNT.skimBps,
      volumeBps: 100,
      paused: ACCOUNT.paused,
      maxContribution: BigInt(ACCOUNT.maxContribution),
      walletReserve: BigInt(ACCOUNT.walletReserve),
    });
    expect(result.policy).toBeNull();
    for (const line of SETTINGS_COPY.volumeSwitch) expect(result.notices).toContain(line);
  });

  it("says nothing about the switch on a rate change that stays on Profit", () => {
    const result = plan(vaultState(OWNERS_POLICY), { rateBps: 3_000 }, { volumeOffered: true });
    for (const line of SETTINGS_COPY.volumeSwitch) expect(result.notices).not.toContain(line);
  });
});
