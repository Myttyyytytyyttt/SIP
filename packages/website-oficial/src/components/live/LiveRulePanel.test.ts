// THE RULE CARD SIGNS, AND WHAT IT SIGNS IS PINNED HERE.
//
// Every control on the sample's card now reaches the pension key: rate and
// pause through set_policy_v2, the threshold through set_invest_policy. Both
// writes put EVERY field of their account on chain, so the one thing that must
// never happen is a field this card does not show going out as a guess — a
// stored limit overwritten, a basket reset to equal shares, a paused policy
// quietly un-paused. These tests drive the card's signer directly and read
// exactly what each press asks the wallet to sign.

import { PROFIT_BPS_MAX, PROFIT_BPS_MIN, VOLUME_BPS_MAX, VOLUME_BPS_MIN } from "@sip/solana-core/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RuleSigner } from "@/components/savings-rule-panel";
import type { InvestRequest, VaultRuleRequest } from "@/hooks/use-vault-actions";
import { LIVE_COPY } from "@/lib/live-copy";
import type { InvestmentPolicyJson, VaultStateJson } from "@/lib/vault-api";
import type { SavingsRule, SavingsStats } from "@/mocks/types";

import { liveSnapshot, policyState } from "../../../test/fixtures/live-dashboard";

const calls = vi.hoisted(() => ({
  rule: [] as unknown[],
  policy: [] as unknown[],
  signer: null as RuleSigner | null,
  state: null as unknown,
}));

vi.mock("@/hooks/use-vault-state", () => ({
  useVaultScreen: () => (calls.state === null ? null : { pensionKey: "owner", view: { kind: "ready", state: calls.state }, refresh: () => undefined, api: {} }),
}));

vi.mock("@/hooks/use-vault-actions", () => {
  const writer = (sink: unknown[]) => ({
    progress: { phase: "idle" },
    running: false,
    busyElsewhere: false,
    unconfirmed: false,
    setPolicy: (input: unknown) => {
      sink.push(input);
      return Promise.resolve();
    },
    investPolicy: (input: unknown) => {
      sink.push(input);
      return Promise.resolve();
    },
    buildAgain: () => Promise.resolve(),
    checkAgain: () => Promise.resolve(),
    dismiss: () => undefined,
  });
  return { useVaultWrite: (key: string) => (key === "vault" ? writer(calls.rule) : writer(calls.policy)) };
});

// The panel itself is the sample's and has its own test; here only what the card hands it matters.
vi.mock("@/components/savings-rule-panel", () => ({
  SavingsRulePanel: (props: { signer: RuleSigner }) => {
    calls.signer = props.signer;
    return null;
  },
}));

import { LiveRulePanel, RATE_RANGES, minimumFor } from "@/components/live/LiveRulePanel";

/** The vault account as the chain stores it: profit at 20 %, limits 0.06 / 0.05 SOL. */
const account = liveSnapshot().vault.state!;

function vaultState(policy: InvestmentPolicyJson | null, status: "exists" | "missing" | "unreadable" = policy === null ? "missing" : "exists"): VaultStateJson {
  return {
    owner: "owner",
    programId: "program",
    vault: { status: "exists", address: "vault", state: account as never },
    policy: { status, address: "policy", ...(policy === null ? {} : { state: policy }) },
    config: { address: "config", status: "exists", exists: true, paused: false },
    walletLinks: [],
    holdings: { status: "exists", items: [] },
    vaultTokenAccounts: { status: "exists", items: [] },
  } as unknown as VaultStateJson;
}

const RULE: SavingsRule = { mode: "profit", rateBps: 2_000, thresholdUsd: 5, targets: [], paused: false };
const STATS = {} as SavingsStats;

/** Mounts the card and returns the signer it built. */
function signerFor(state: VaultStateJson | null): RuleSigner {
  calls.state = state;
  calls.signer = null;
  renderToStaticMarkup(createElement(LiveRulePanel, { rule: RULE, stats: STATS, activity: [], now: "2026-09-16T12:00:00.000Z", onRefresh: () => undefined }));
  return calls.signer!;
}

beforeEach(() => {
  calls.rule.length = 0;
  calls.policy.length = 0;
});

describe("the ranges are the program's", () => {
  it("offers exactly the rates the vault's own mode accepts", () => {
    expect(RATE_RANGES.profit.min).toBe(PROFIT_BPS_MIN);
    expect(RATE_RANGES.profit.max).toBe(PROFIT_BPS_MAX);
    expect(RATE_RANGES.volume.min).toBe(VOLUME_BPS_MIN);
    expect(RATE_RANGES.volume.max).toBe(VOLUME_BPS_MAX);
    for (const mode of ["profit", "volume"] as const) {
      for (const preset of RATE_RANGES[mode].presets) expect(preset >= RATE_RANGES[mode].min && preset <= RATE_RANGES[mode].max, `${mode} ${preset}`).toBe(true);
    }
  });

  it("gives a profit vault the profit range, not the sample's volume one", () => {
    const signer = signerFor(vaultState(policyState()));
    expect([signer.rateMin, signer.rateMax]).toEqual([PROFIT_BPS_MIN, PROFIT_BPS_MAX]);
  });
});

describe("rate and pause sign the vault's rule — every other field as stored", () => {
  it("changes the active mode's rate and sends the other five exactly as the chain holds them", () => {
    signerFor(vaultState(policyState())).onUpdate({ rateBps: 3_000, thresholdUsd: 5, paused: false }, { rule: true, threshold: false });
    const [sent] = calls.rule as VaultRuleRequest[];
    expect(sent).toEqual({
      mode: account.skimMode,
      skimBps: 3_000,
      volumeBps: account.volumeBps,
      paused: account.paused,
      maxContribution: BigInt(account.maxContribution),
      walletReserve: BigInt(account.walletReserve),
    });
    expect(calls.policy).toEqual([]);
  });

  it("pauses without touching the rate", () => {
    signerFor(vaultState(policyState())).onUpdate({ rateBps: account.skimBps, thresholdUsd: 5, paused: true }, { rule: true, threshold: false });
    const [sent] = calls.rule as VaultRuleRequest[];
    expect(sent!.paused).toBe(true);
    expect(sent!.skimBps).toBe(account.skimBps);
  });
});

describe("the threshold signs the investing policy — only its minimum changed", () => {
  /**
   * AN OMITTED FIELD IS A DEFAULT, and the defaults are not neutral: equal
   * weights over the whole shelf, the product's caps, and `enabled: true`. So
   * the stored caps, basket and pause travel with every threshold change.
   */
  it("sends the stored caps, basket and enabled with the new minimum", () => {
    const stored = policyState({ enabled: false });
    signerFor(vaultState(stored)).onUpdate({ rateBps: account.skimBps, thresholdUsd: 12, paused: false }, { rule: false, threshold: true });
    const [sent] = calls.policy as InvestRequest[];
    expect(sent!.maxPerCall).toBe(BigInt(stored.maxPerCall));
    expect(sent!.maxRolling30d).toBe(BigInt(stored.maxRolling30d));
    // A paused policy stays paused: the threshold is not a resume button.
    expect(sent!.enabled).toBe(false);
    expect([...(sent!.weights ?? new Map())]).toEqual(stored.legs.map((leg) => [leg.mint, leg.weightBps]));
    // One leg at 100 %: the basket invests at $12 when that leg's minimum is $12.
    expect(sent!.minInvestment).toBe(12_000_000n);
    expect(calls.rule).toEqual([]);
  });

  it("never signs the threshold in the same breath as the rule: the second waits for the first to land", () => {
    signerFor(vaultState(policyState())).onUpdate({ rateBps: 3_000, thresholdUsd: 12, paused: false }, { rule: true, threshold: true });
    expect(calls.rule).toHaveLength(1);
    expect(calls.policy).toEqual([]);
  });

  it("refuses a threshold the stored cap per buy cannot reach", () => {
    // $1,000 per buy on one leg: a $2,000 basket threshold asks one leg for $2,000.
    expect(signerFor(vaultState(policyState())).thresholdProblem(2_000)).not.toBeNull();
    expect(signerFor(vaultState(policyState())).thresholdProblem(10)).toBeNull();
  });
});

describe("the basket's one threshold, made true", () => {
  it("is the inverse of the chain's own: minimum × 10 000 ÷ the lightest leg", () => {
    expect(minimumFor(10_000_000n, [10_000])).toBe(10_000_000n);
    expect(minimumFor(10_000_000n, [5_000, 5_000])).toBe(5_000_000n);
    // …and signing it gives back a basket threshold no higher than the one typed.
    for (const weights of [[10_000], [5_000, 5_000], [3_334, 3_333, 3_333], [7_000, 3_000]]) {
      const minimum = minimumFor(25_000_000n, weights);
      const lightest = BigInt(Math.min(...weights));
      const investsAt = (minimum * 10_000n + lightest - 1n) / lightest;
      expect(investsAt <= 25_000_000n, weights.join("/")).toBe(true);
    }
  });
});

describe("what cannot be signed is not offered", () => {
  it("offers nothing while the vault's own state has not been read", () => {
    const signer = signerFor(null);
    expect(signer.busy).toBe(true);
    expect(signer.thresholdLocked).toBe(LIVE_COPY.reading);
  });

  it("locks the threshold, with the reason, when investing is not set up", () => {
    expect(signerFor(vaultState(null)).thresholdLocked).toBe(LIVE_COPY.investingNotSetUp);
  });

  it("never treats a policy it could not read as a missing one", () => {
    expect(signerFor(vaultState(null, "unreadable")).thresholdLocked).toBe(LIVE_COPY.policyUnreadable);
  });

  it("signs nothing when there is no vault account to send back", () => {
    const signer = signerFor(null);
    signer.onUpdate({ rateBps: 3_000, thresholdUsd: 12, paused: false }, { rule: true, threshold: true });
    expect(calls.rule).toEqual([]);
    expect(calls.policy).toEqual([]);
  });
});
