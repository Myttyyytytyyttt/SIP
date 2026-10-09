// What the keeper is about to do with a live vault's money (owner, 2026-10-08),
// through the REAL model: every dashboard below is a snapshot and a page of
// history put through toLiveDashboard, never a hand-written view.

import { ANTHROPIC_MINT, SPYX_MINT, USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";
import { describe, expect, it } from "vitest";

import { formatUsd, usdcRawForLamports } from "@/lib/amounts";
import { PENDING_COPY } from "@/lib/live-copy";
import { toDashboardMock } from "@/lib/live-mock";
import {
  CONVERT_DUST_LAMPORTS,
  PENDING_STALL_MS,
  WRAP_DUST_LAMPORTS,
  anyActive,
  namesOf,
  nextInvestmentOf,
  pendingLines,
  pendingSteps,
  solUnderWrapLine,
  type PendingRest,
} from "@/lib/live-pending";
import type { LiveDashboard, LiveEntryJson, LiveSnapshotJson, VaultEventJson } from "@/lib/live-types";
import type { InvestmentPolicyJson } from "@/lib/vault-api";
import {
  NOW_MS,
  PRICES,
  liveActivity,
  liveEntry,
  liveSnapshot,
  policyState,
  seconds,
  settledEvent,
  signature,
  tokenAccount,
} from "../../test/fixtures/live-dashboard";
import { toLiveDashboard } from "@/lib/live-model";
import { KEEPER_DUST } from "../../../solana-core/test/fixtures/keeper-policy";

const PER_SOL = 100_038_711n;
const RENT = 1_285_240n;
const wrapped = (lamports: string): VaultEventJson => ({ kind: "wrapped", lamports }) as VaultEventJson;
const converted = (): VaultEventJson => ({ kind: "converted", lamportsSpent: "18000000", usdcReceivedRaw: "1800000" }) as VaultEventJson;
const minutesAgo = (minutes: number): number => seconds(NOW_MS - minutes * 60_000);

interface Setup {
  /** Free SOL above the vault's rent, lamports. */
  readonly free?: bigint;
  readonly wsol?: bigint;
  readonly usdc?: bigint;
  readonly policy?: Partial<InvestmentPolicyJson> | "missing" | "unreadable";
  readonly paused?: boolean;
  readonly protocolPaused?: boolean | null;
  readonly entries?: readonly LiveEntryJson[];
  readonly prices?: LiveSnapshotJson["prices"];
  readonly tokensReadable?: boolean;
  readonly mode?: 0 | 1;
  /** The history did not answer: toLiveDashboard is handed no page at all. */
  readonly activityUnread?: boolean;
  /** Entries read from the trading wallets' links (settlements outside the vault's own page). */
  readonly linkEntries?: readonly LiveEntryJson[];
}

/** A vault with nothing in flight unless the setup says so. */
function dashboard(setup: Setup = {}): LiveDashboard {
  const base = liveSnapshot();
  const free = setup.free ?? 0n;
  const vaultState = base.vault.state!;
  const items = [
    ...(setup.wsol === undefined ? [] : [tokenAccount(WSOL_MINT, setup.wsol.toString(), "x", 9)]),
    ...(setup.usdc === undefined ? [] : [tokenAccount(USDC_MINT, setup.usdc.toString(), "x", 6)]),
  ];
  const policy: LiveSnapshotJson["policy"] =
    setup.policy === "missing"
      ? { status: "missing", address: base.policy.address }
      : setup.policy === "unreadable"
        ? { status: "unreadable", address: base.policy.address }
        : { status: "exists", address: base.policy.address, state: policyState(setup.policy ?? {}) };
  const snapshot = liveSnapshot({
    vault: {
      ...base.vault,
      lamports: (RENT + free).toString(),
      rentFloor: RENT.toString(),
      withdrawableLamports: free.toString(),
      state: { ...vaultState, paused: setup.paused ?? false, skimMode: setup.mode ?? 0 },
    },
    policy,
    config: { ...base.config, status: setup.protocolPaused === null ? "unreadable" : "exists", paused: setup.protocolPaused ?? false },
    prices: setup.prices === undefined ? PRICES : setup.prices,
    vaultTokenAccounts: setup.tokensReadable === false ? { status: "unreadable", items: [] } : { status: "exists", items },
  });
  return toLiveDashboard({
    snapshot,
    activity: setup.activityUnread === true ? null : liveActivity(setup.entries ?? []),
    ...(setup.linkEntries === undefined ? {} : { linkEntries: setup.linkEntries }),
    privyWallets: [],
  });
}

/** A conversion a minute ago: the newest move toward both steps, so either is timed and under way. */
const FRESH: readonly LiveEntryJson[] = [liveEntry(signature(7), minutesAgo(1), [converted()])];

/** The owner's screenshot: SOL wrapped a minute ago, nothing converted yet, nothing in USDC. */
const OWNER_CASE: Setup = { wsol: 18_000_000n, usdc: 0n, entries: [liveEntry(signature(1), minutesAgo(1), [wrapped("18000000")])] };

describe("SOL on its way to USDC", () => {
  it("is the owner's case: wSOL just wrapped is converting, under way, at today's price", () => {
    const steps = pendingSteps(dashboard(OWNER_CASE));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "converting", state: "active", rest: null, amountRaw: 18_000_000n });
    expect(steps[0]!.valueUsdcRaw).toBe(usdcRawForLamports(18_000_000n, PER_SOL));
    expect(steps[0]!.since).toBe(minutesAgo(1) * 1_000);
    expect(anyActive(steps)).toBe(true);
  });

  it("counts free SOL from the keeper's wrap line up, and not one lamport under it", () => {
    expect(pendingSteps(dashboard({ free: WRAP_DUST_LAMPORTS - 1n }))).toEqual([]);
    const at = pendingSteps(dashboard({ free: WRAP_DUST_LAMPORTS }));
    expect(at).toHaveLength(1);
    expect(at[0]).toMatchObject({ kind: "converting", amountRaw: WRAP_DUST_LAMPORTS });
  });

  it("counts held wSOL from the convert's dust line up, and not one lamport under it", () => {
    expect(pendingSteps(dashboard({ wsol: CONVERT_DUST_LAMPORTS - 1n }))).toEqual([]);
    expect(pendingSteps(dashboard({ wsol: CONVERT_DUST_LAMPORTS }))[0]).toMatchObject({ kind: "converting", amountRaw: CONVERT_DUST_LAMPORTS });
  });

  it("leaves free SOL under the wrap line out when only the held wSOL converts", () => {
    // wrapPlan wraps nothing under WRAP_DUST_LAMPORTS; shouldConvert converts the wSOL already held.
    const data = dashboard({ free: WRAP_DUST_LAMPORTS - 1n, wsol: CONVERT_DUST_LAMPORTS, entries: FRESH });
    const steps = pendingSteps(data);
    expect(steps[0]).toMatchObject({ kind: "converting", state: "active", amountRaw: CONVERT_DUST_LAMPORTS });
    expect(nextInvestmentOf(steps).extraUsdcRaw).toBe(usdcRawForLamports(CONVERT_DUST_LAMPORTS, PER_SOL));
  });

  it("adds wSOL under its own dust line when a wrap is coming anyway: the convert takes everything wrapped", () => {
    expect(pendingSteps(dashboard({ free: WRAP_DUST_LAMPORTS, wsol: 1_000n }))[0]!.amountRaw).toBe(WRAP_DUST_LAMPORTS + 1_000n);
  });

  it("says nothing about a vault holding only its rent", () => {
    expect(pendingSteps(dashboard({ free: 0n, wsol: 0n, usdc: 0n }))).toEqual([]);
  });

  it("still sees the free SOL when the token list could not be read, and nothing it would have to guess", () => {
    const steps = pendingSteps(dashboard({ free: 20_000_000n, usdc: 50_000_000n, tokensReadable: false }));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "converting", amountRaw: 20_000_000n });
  });

  it("has no dollar value without a price, and says the SOL instead", () => {
    const steps = pendingSteps(dashboard({ ...OWNER_CASE, prices: null }));
    expect(steps[0]!.valueUsdcRaw).toBeNull();
    expect(pendingLines(steps)[0]!.amount).toBe("0.018 SOL");
  });

  it("rests, without a loader, while the policy's conversion floor is 0", () => {
    const steps = pendingSteps(dashboard({ ...OWNER_CASE, policy: { minConvertRateWad: "0" } }));
    expect(steps[0]).toMatchObject({ kind: "converting", state: "waiting", rest: "conversion_off" });
    expect(anyActive(steps)).toBe(false);
  });
});

describe("USDC ready to buy the basket", () => {
  // 60 / 40 at a $1 minimum: the lightest leg clears it from $2.50.
  const BASKET: Partial<InvestmentPolicyJson> = {
    minInvestment: "1000000",
    legs: [
      { mint: SPYX_MINT, weightBps: 6_000, minOutRateWad: "1" },
      { mint: ANTHROPIC_MINT, weightBps: 4_000, minOutRateWad: "1" },
    ],
  };

  it("buys from the balance at which EVERY leg clears the minimum, and not a raw unit under it", () => {
    expect(pendingSteps(dashboard({ usdc: 2_499_999n, policy: BASKET }))).toEqual([]);
    const steps = pendingSteps(dashboard({ usdc: 2_500_000n, policy: BASKET, entries: [liveEntry(signature(2), minutesAgo(1), [converted()])] }));
    expect(steps).toEqual([
      { kind: "buying", state: "active", rest: null, amountRaw: 2_500_000n, valueUsdcRaw: 2_500_000n, symbols: ["SPYx", "ANTHROPIC"], since: minutesAgo(1) * 1_000 },
    ]);
    expect(pendingLines(steps)[0]).toMatchObject({ title: PENDING_COPY.buying("SPYx and ANTHROPIC"), amount: "$2.50", active: true });
  });

  it("spends no more than one call's cap", () => {
    const steps = pendingSteps(dashboard({ usdc: 10_000_000n, policy: { ...BASKET, maxPerCall: "3000000" } }));
    expect(steps[0]).toMatchObject({ kind: "buying", amountRaw: 3_000_000n });
  });

  it("says nothing when one call's cap could never buy the basket", () => {
    expect(pendingSteps(dashboard({ usdc: 10_000_000n, policy: { ...BASKET, maxPerCall: "2000000" } }))).toEqual([]);
  });

  it("rests on the 30-day limit when what is left of it cannot buy the basket", () => {
    const steps = pendingSteps(dashboard({ usdc: 10_000_000n, wsol: 20_000_000n, policy: { ...BASKET, maxRolling30d: "2499999" } }));
    expect(steps.map((step) => [step.kind, step.state, step.rest])).toEqual([
      ["converting", "waiting", "month_cap"],
      ["buying", "waiting", "month_cap"],
    ]);
    // At exactly the basket's minimum the limit leaves room, and the buy spends only that room.
    const room = pendingSteps(dashboard({ usdc: 10_000_000n, policy: { ...BASKET, maxRolling30d: "2500000" }, entries: FRESH }));
    expect(room).toEqual([expect.objectContaining({ kind: "buying", state: "active", amountRaw: 2_500_000n })]);
  });

  /**
   * WHAT THE 30 DAYS ALREADY SPENT COUNTS. The keeper's rollingDecision rests
   * the whole turn when max_rolling_30d less what the buckets hold is under
   * basketMinimum — nothing is wrapped, converted or bought — so a $100 cap
   * with $97.50 already spent leaves $2.50, exactly this basket's minimum.
   */
  const SPENT_TODAY = (raw: string): Partial<InvestmentPolicyJson> => {
    const today = Math.floor(NOW_MS / 86_400_000);
    return {
      ...BASKET,
      maxRolling30d: "100000000",
      bucketDays: [today, ...Array.from({ length: 30 }, () => 0)],
      bucketAmounts: [raw, ...Array.from({ length: 30 }, () => "0")],
    };
  };

  it("rests on the 30-day limit from what was already spent in it, not from the cap alone", () => {
    const capped = dashboard({ usdc: 10_000_000n, wsol: 20_000_000n, policy: SPENT_TODAY("97500001"), entries: FRESH });
    expect(capped.policy.usedLast30d).toBe(97_500_001n);
    const steps = pendingSteps(capped);
    expect(steps.map((step) => [step.kind, step.state, step.rest])).toEqual([
      ["converting", "waiting", "month_cap"],
      ["buying", "waiting", "month_cap"],
    ]);
    // And the SOL it holds back is not counted as on its way.
    expect(nextInvestmentOf(steps)).toEqual({ extraUsdcRaw: null, note: null });
    // One raw unit more of room is the basket's minimum: under way, spending only that room.
    const room = pendingSteps(dashboard({ usdc: 10_000_000n, wsol: 20_000_000n, policy: SPENT_TODAY("97500000"), entries: FRESH }));
    expect(room.map((step) => [step.kind, step.state, step.amountRaw])).toEqual([
      ["converting", "active", 20_000_000n],
      ["buying", "active", 2_500_000n],
    ]);
  });

  it("rounds the basket's minimum UP, as the keeper's basketMinimum does, when the lightest weight does not divide it", () => {
    // ⌈1,000,000 × 10,000 / 3,333⌉ = 3,000,301; rounded down it would be 3,000,300.
    const cap = (maxRolling30d: string): Partial<InvestmentPolicyJson> => ({
      minInvestment: "1000000",
      maxRolling30d,
      legs: [
        { mint: SPYX_MINT, weightBps: 6_667, minOutRateWad: "1" },
        { mint: ANTHROPIC_MINT, weightBps: 3_333, minOutRateWad: "1" },
      ],
    });
    expect(pendingSteps(dashboard({ wsol: 20_000_000n, policy: cap("3000300"), entries: FRESH }))[0]).toMatchObject({ kind: "converting", state: "waiting", rest: "month_cap" });
    expect(pendingSteps(dashboard({ wsol: 20_000_000n, policy: cap("3000301"), entries: FRESH }))[0]).toMatchObject({ kind: "converting", state: "active", rest: null });
  });

  it("says nothing for USDC the token list could not count", () => {
    expect(pendingSteps(dashboard({ usdc: 10_000_000n, tokensReadable: false }))).toEqual([]);
  });
});

describe("what stops the keeper's turn, in its own order", () => {
  const BOTH: Setup = { free: 20_000_000n, usdc: 10_000_000n };

  it("is nothing at all with no policy, or one that could not be read: no row, no loader", () => {
    expect(pendingSteps(dashboard({ ...BOTH, policy: "missing" }))).toEqual([]);
    expect(pendingSteps(dashboard({ ...BOTH, policy: "unreadable" }))).toEqual([]);
  });

  it("is buying switched off, before either pause", () => {
    const steps = pendingSteps(dashboard({ ...BOTH, policy: { enabled: false }, paused: true }));
    expect(steps.map((step) => step.rest)).toEqual(["buying_off", "buying_off"]);
  });

  it("is the vault's pause, then the protocol's", () => {
    expect(pendingSteps(dashboard({ ...BOTH, paused: true, protocolPaused: true })).map((step) => step.rest)).toEqual(["paused", "paused"]);
    expect(pendingSteps(dashboard({ ...BOTH, protocolPaused: true })).map((step) => step.rest)).toEqual(["protocol_paused", "protocol_paused"]);
  });

  it("does not claim a pause it could not read: an unread protocol config does not rest the step", () => {
    expect(pendingSteps(dashboard({ ...BOTH, protocolPaused: null, entries: FRESH })).map((step) => step.state)).toEqual(["active", "active"]);
  });

  it("draws no loader for any of them", () => {
    for (const setup of [{ policy: { enabled: false } }, { paused: true }, { protocolPaused: true }] as const) {
      const steps = pendingSteps(dashboard({ ...BOTH, ...setup }));
      expect(steps.length).toBeGreaterThan(0);
      expect(anyActive(steps)).toBe(false);
      expect(pendingLines(steps).every((line) => !line.active)).toBe(true);
    }
  });

  it("is the same for a profit vault and a volume one: the keeper converts and buys for both", () => {
    expect(pendingSteps(dashboard({ ...OWNER_CASE, mode: 1 }))).toEqual(pendingSteps(dashboard({ ...OWNER_CASE, mode: 0 })));
  });
});

/**
 * A POLICY SIGNED BEFORE 2026-10-08 WHOSE OLD LIMITS STOP SOMETHING NOW
 * (live-model.ts oldLimitsStopOf). The keeper measures each leg WITH its floor
 * before the wrap, so a stock's passed limit refuses the whole turn; it applies
 * the SOL floor only on the convert's send path, so the SOL limit alone leaves
 * the wSOL unconverted while the USDC held is still invested.
 */
describe("old price limits that stop the keeper", () => {
  /** SOL's floor over today's rate (PRICES), the stock legs' floors under theirs. */
  const SOL_FLOOR_PASSED: Partial<InvestmentPolicyJson> = { minConvertRateWad: "100038711555492563" };
  /** SPYx's floor over today's rate. */
  const LEG_FLOOR_PASSED: Partial<InvestmentPolicyJson> = { legs: [{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: "131283650130637570" }] };

  it("rests the conversion, without a loader, while SOL sits under the old SOL limit — and still buys with the USDC held", () => {
    const data = dashboard({ ...OWNER_CASE, entries: [...OWNER_CASE.entries!, ...FRESH], usdc: 10_000_000n, policy: SOL_FLOOR_PASSED });
    expect(data.policy.oldLimitsStop).toBe("convert");
    const steps = pendingSteps(data);
    expect(steps.map((step) => [step.kind, step.state, step.rest])).toEqual([
      ["converting", "waiting", "price_limits"],
      ["buying", "active", null],
    ]);
    expect(pendingLines(steps)[0]).toMatchObject({ active: false, title: PENDING_COPY.convertingWaiting, sub: PENDING_COPY.rest.price_limits });
  });

  it("rests both steps while a stock sits past its old limit: the keeper refuses the whole turn", () => {
    const data = dashboard({ ...OWNER_CASE, usdc: 10_000_000n, policy: LEG_FLOOR_PASSED });
    expect(data.policy.oldLimitsStop).toBe("basket");
    const steps = pendingSteps(data);
    expect(steps.map((step) => [step.kind, step.state, step.rest])).toEqual([
      ["converting", "waiting", "price_limits"],
      ["buying", "waiting", "price_limits"],
    ]);
    expect(anyActive(steps)).toBe(false);
  });

  it("does not count SOL the old limits hold back in Next investment", () => {
    for (const policy of [SOL_FLOOR_PASSED, LEG_FLOOR_PASSED]) {
      const data = dashboard({ ...OWNER_CASE, usdc: 1_000_000n, policy });
      expect(nextInvestmentOf(pendingSteps(data))).toEqual({ extraUsdcRaw: null, note: null });
      expect(toDashboardMock(data, { complete: true }).stats.readyToInvestUsd).toBe(1);
    }
  });

  it("points at the one switch, in the owner's words", () => {
    expect(PENDING_COPY.rest.price_limits).toContain("Switch to live-price buying");
    expect(PENDING_COPY.rest.price_limits).not.toMatch(/keeper|wad|bps|floor/i);
  });

  it("says nothing of old limits that do not stop anything today", () => {
    // policyState's own floors are 10 % under SOL and 5 % under SPYx: held, not blocking.
    expect(dashboard(OWNER_CASE).policy.oldLimitsStop).toBeNull();
    expect(pendingSteps(dashboard(OWNER_CASE))[0]).toMatchObject({ state: "active", rest: null });
  });
});

/**
 * SOL UNDER A NEWER POLICY'S SAFETY FLOOR (owner, 2026-10-09): legs at 1 wad,
 * the SOL floor at half the price at signing. convert.rs refuses every
 * conversion under it, so the conversion rests on it — no loader — while the
 * USDC already held is still invested. It is the one price move the owner must
 * sign again for, and the row says so.
 */
describe("SOL under the safety floor", () => {
  const LIVE_LEGS = [{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: "1" }];
  /** One wad over PRICES' SOL rate. */
  const UNDER: Partial<InvestmentPolicyJson> = { legs: LIVE_LEGS, minConvertRateWad: "100038711555492563" };
  /** Half of PRICES' SOL rate: SOL is over it. */
  const OVER: Partial<InvestmentPolicyJson> = { legs: LIVE_LEGS, minConvertRateWad: "50019355777746281" };

  it("rests the conversion on the safety floor, without a loader, and still buys with the USDC held", () => {
    const data = dashboard({ ...OWNER_CASE, entries: [...OWNER_CASE.entries!, ...FRESH], usdc: 10_000_000n, policy: UNDER });
    expect([data.policy.safetyFloorStop, data.policy.oldLimitsStop]).toEqual([true, null]);
    const steps = pendingSteps(data);
    expect(steps.map((step) => [step.kind, step.state, step.rest])).toEqual([
      ["converting", "waiting", "safety_floor"],
      ["buying", "active", null],
    ]);
    expect(pendingLines(steps)[0]).toMatchObject({ active: false, title: PENDING_COPY.convertingWaiting, sub: PENDING_COPY.rest.safety_floor });
    expect(nextInvestmentOf(steps).extraUsdcRaw).toBeNull();
  });

  it("converts as usual while SOL is over it", () => {
    const data = dashboard({ ...OWNER_CASE, entries: [...OWNER_CASE.entries!, ...FRESH], policy: OVER });
    expect(data.policy.safetyFloorStop).toBe(false);
    expect(pendingSteps(data)[0]).toMatchObject({ kind: "converting", state: "active", rest: null });
  });

  it("points at approving again, in the owner's words", () => {
    expect(PENDING_COPY.rest.safety_floor).toContain("Approve again at today's price");
    expect(PENDING_COPY.rest.safety_floor).not.toMatch(/keeper|wad|bps/i);
  });
});

describe("a loader that stops claiming progress", () => {
  const at = (minutes: number): Setup => ({ ...OWNER_CASE, entries: [liveEntry(signature(1), minutesAgo(minutes), [wrapped("18000000")])] });

  it("runs for PENDING_STALL_MS after the chain last moved toward the step, and not a second longer", () => {
    expect(PENDING_STALL_MS).toBe(5 * 60_000);
    expect(pendingSteps(dashboard(at(5)))[0]).toMatchObject({ state: "active", rest: null });
    const late = dashboard({ ...OWNER_CASE, entries: [liveEntry(signature(1), seconds(NOW_MS - PENDING_STALL_MS - 1_000), [wrapped("18000000")])] });
    expect(pendingSteps(late)[0]).toMatchObject({ state: "waiting", rest: "slow" });
  });

  it("says since when, at the time the chain moved", () => {
    const line = pendingLines(pendingSteps(dashboard(at(12))))[0]!;
    expect(line.active).toBe(false);
    expect(line.title).toBe(PENDING_COPY.convertingWaiting);
    expect(line.sub).toBe(PENDING_COPY.slow("11:48 UTC"));
  });

  it("times from the NEWEST move: a settlement after an old wrap starts the clock again", () => {
    const entries = [liveEntry(signature(3), minutesAgo(1), [settledEvent("20000000")]), liveEntry(signature(1), minutesAgo(30), [wrapped("18000000")])];
    expect(pendingSteps(dashboard({ ...OWNER_CASE, entries }))[0]).toMatchObject({ state: "active", since: minutesAgo(1) * 1_000 });
  });

  it("does not time from a transaction that failed, or a settlement that moved nothing", () => {
    const failed: LiveEntryJson = { ...liveEntry(signature(4), minutesAgo(1), [wrapped("18000000")]), ok: false };
    const nothing = liveEntry(signature(5), minutesAgo(1), [settledEvent("0", false, "0")]);
    const old = liveEntry(signature(1), minutesAgo(30), [wrapped("18000000")]);
    expect(pendingSteps(dashboard({ ...OWNER_CASE, entries: [failed, nothing, old] }))[0]).toMatchObject({ state: "waiting", rest: "slow", since: minutesAgo(30) * 1_000 });
  });

  /**
   * NO EVIDENCE, NO LOADER. A step the loaded history shows no successful move
   * toward has no clock to stop its loader by: drawn "active", it would spin
   * for as long as the condition held — beside a history that could not be
   * read, or over a first page of failed conversions.
   */
  it("waits, without a loader or a clock, when the loaded history holds nothing to time it by", () => {
    const steps = pendingSteps(dashboard({ wsol: 18_000_000n, entries: [] }));
    expect(steps[0]).toMatchObject({ kind: "converting", state: "waiting", rest: "slow", since: null });
    expect(anyActive(steps)).toBe(false);
    expect(pendingLines(steps)[0]).toMatchObject({ active: false, title: PENDING_COPY.convertingWaiting, sub: PENDING_COPY.slowUntimed });
  });

  it("waits when the history could not be read at all, for SOL converting and for USDC ready to buy", () => {
    const steps = pendingSteps(dashboard({ wsol: 18_000_000n, usdc: 10_000_000n, activityUnread: true }));
    expect(steps.map((step) => [step.kind, step.state, step.rest, step.since])).toEqual([
      ["converting", "waiting", "slow", null],
      ["buying", "waiting", "slow", null],
    ]);
    expect(anyActive(steps)).toBe(false);
  });

  it("waits over a first page of failed conversions: a failed transaction is no move toward the step", () => {
    const failedConvert = (index: number): LiveEntryJson => ({ ...liveEntry(signature(20 + index), minutesAgo(index + 1), [converted()]), ok: false });
    const steps = pendingSteps(dashboard({ wsol: 18_000_000n, entries: Array.from({ length: 15 }, (_, index) => failedConvert(index)) }));
    expect(steps[0]).toMatchObject({ kind: "converting", state: "waiting", rest: "slow", since: null });
  });

  it("times from a settlement found only on a wallet's link, outside the vault's own page", () => {
    // The vault's page holds only an old wrap; the newest settle is in the link stream (settlementRows).
    const steps = pendingSteps(
      dashboard({
        ...OWNER_CASE,
        entries: [liveEntry(signature(1), minutesAgo(30), [wrapped("18000000")])],
        linkEntries: [liveEntry(signature(31), minutesAgo(1), [settledEvent("20000000")])],
      }),
    );
    expect(steps[0]).toMatchObject({ kind: "converting", state: "active", rest: null, since: minutesAgo(1) * 1_000 });
  });
});

describe("Next investment", () => {
  it("counts the SOL being converted, and says so", () => {
    const steps = pendingSteps(dashboard(OWNER_CASE));
    const value = usdcRawForLamports(18_000_000n, PER_SOL);
    expect(nextInvestmentOf(steps)).toEqual({ extraUsdcRaw: value, note: PENDING_COPY.includesConverting("$1.80") });
    const stats = toDashboardMock(dashboard(OWNER_CASE), { complete: true }).stats;
    expect(stats.readyToInvestUsd).toBe(Number(value) / 1e6);
    expect(stats.nextInvestmentNote).toBe(PENDING_COPY.includesConverting("$1.80"));
  });

  it("fills the bar from zero when the vault has no USDC account yet: the first conversion creates it", () => {
    // OWNER_CASE without the USDC account at all, as before the keeper's first convert.
    const data = dashboard({ wsol: 18_000_000n, entries: OWNER_CASE.entries });
    expect(data.holdings.some((row) => row.kind === "usdc")).toBe(false);
    const stats = toDashboardMock(data, { complete: true }).stats;
    expect(stats.readyToInvestUsd).toBe(Number(usdcRawForLamports(18_000_000n, PER_SOL)) / 1e6);
    expect(stats.thresholdUsd).toBe(5);
    expect(stats.nextInvestmentNote).toBe(PENDING_COPY.includesConverting("$1.80"));
  });

  it("says no 'Includes' line under a sum it cannot show: the token list unread", () => {
    const stats = toDashboardMock(dashboard({ free: 18_000_000n, entries: FRESH, tokensReadable: false }), { complete: true }).stats;
    expect(stats.readyToInvestUsd).toBeNull();
    expect(stats.nextInvestmentNote).toBeNull();
  });

  it("keeps counting it while the conversion is slow: it is still on its way", () => {
    const late = dashboard({ ...OWNER_CASE, entries: [liveEntry(signature(1), minutesAgo(20), [wrapped("18000000")])] });
    expect(nextInvestmentOf(pendingSteps(late)).extraUsdcRaw).toBe(usdcRawForLamports(18_000_000n, PER_SOL));
  });

  it("does not count SOL a pause or a switched-off policy holds back", () => {
    for (const setup of [{ paused: true }, { policy: { enabled: false } }, { policy: { minConvertRateWad: "0" } }] as const) {
      const data = dashboard({ ...OWNER_CASE, usdc: 1_000_000n, ...setup });
      expect(nextInvestmentOf(pendingSteps(data))).toEqual({ extraUsdcRaw: null, note: null });
      expect(toDashboardMock(data, { complete: true }).stats.readyToInvestUsd).toBe(1);
    }
  });

  it("says the SOL, not a dollar figure, when no price was read", () => {
    expect(nextInvestmentOf(pendingSteps(dashboard({ ...OWNER_CASE, prices: null })))).toEqual({ extraUsdcRaw: null, note: PENDING_COPY.plusConverting("0.018") });
  });

  it("says a basket is ready when the USDC alone buys it", () => {
    expect(nextInvestmentOf(pendingSteps(dashboard({ usdc: 5_000_000n, entries: FRESH })))).toEqual({ extraUsdcRaw: null, note: PENDING_COPY.readyToBuy });
  });

  it("adds nothing and says nothing when nothing is in flight", () => {
    const data = dashboard({ usdc: 1_000_000n });
    expect(nextInvestmentOf(pendingSteps(data))).toEqual({ extraUsdcRaw: null, note: null });
    expect(toDashboardMock(data, { complete: true }).stats.nextInvestmentNote).toBeNull();
  });
});

/**
 * SOL UNDER THE KEEPER'S WRAP LINE (owner, 2026-10-09). His vault as read on
 * mainnet: 3,911,799 lamports free from one settlement, no wSOL, no USDC, and a
 * 50 / 50 basket at $0.50 a leg — $1.00 for the basket. The bar read "$0.00 of
 * $1.00 · $1.00 to go" beside "Pending $0.43": the keeper wraps nothing under
 * 0.005 SOL, so no converting step was built, and the bar counted USDC alone.
 */
describe("SOL under the keeper's wrap line", () => {
  /** The owner's policy: $0.50 a leg, SPYx and ANTHROPIC at half each, $149 a call, legs at live price. */
  const OWNER_POLICY: Partial<InvestmentPolicyJson> = {
    minInvestment: "500000",
    maxPerCall: "149000000",
    legs: [
      { mint: SPYX_MINT, weightBps: 5_000, minOutRateWad: "1" },
      { mint: ANTHROPIC_MINT, weightBps: 5_000, minOutRateWad: "1" },
    ],
  };
  /** The settlement that did not reach the bar, lamports: 1,088,201 short of the line. */
  const UNDER_LINE = 3_911_799n;
  const owner = (setup: Setup = {}): LiveDashboard => dashboard({ free: UNDER_LINE, usdc: 0n, policy: OWNER_POLICY, ...setup });
  const statsOf = (data: LiveDashboard) => toDashboardMock(data, { complete: true }).stats;
  const value = (lamports: bigint): bigint => usdcRawForLamports(lamports, PER_SOL);

  it("is the owner's case: no row, the SOL counted at today's price, the same figure as Pending", () => {
    const data = owner();
    expect(pendingSteps(data)).toEqual([]);
    expect(solUnderWrapLine(data)).toEqual({ lamports: UNDER_LINE, shortLamports: 1_088_201n, valueUsdcRaw: 391_331n, shortUsdcRaw: 108_862n });
    const stats = statsOf(data);
    // $0.39 at the fixture's $100.04; the $0.43 he saw was the same SOL at that night's price.
    expect(stats.readyToInvestUsd).toBe(0.391331);
    expect(stats.readyToInvestUsd).toBe(stats.pendingUsd);
    expect(stats.thresholdUsd).toBe(1);
    expect(stats.nextInvestmentNote).toBe(PENDING_COPY.includesWaiting("$0.39", "0.005", "0.0011"));
    // A saving of what the bar lacks crosses the line too, so that is what is to go — and the line still gates it.
    expect(stats.toGoUsd).toBe(0.608669);
    expect(stats.nextInvestmentGate).toBe("wrap_line");
  });

  it("names the line from the keeper's constant, not a figure typed into the words", () => {
    expect(PENDING_COPY.includesWaiting("$0.39", String(KEEPER_DUST.sol), "0.0011")).toBe(statsOf(owner()).nextInvestmentNote);
  });

  it("moves no figure when the SOL crosses the line: only the line under the bar changes", () => {
    const under = statsOf(owner({ free: WRAP_DUST_LAMPORTS - 1n, entries: FRESH }));
    const at = statsOf(owner({ free: WRAP_DUST_LAMPORTS, entries: FRESH }));
    expect(under.readyToInvestUsd).toBe(0.500193);
    expect(at.readyToInvestUsd).toBe(under.readyToInvestUsd);
    expect(at.toGoUsd).toBe(under.toGoUsd);
    expect(under.nextInvestmentNote).toBe(PENDING_COPY.includesWaiting("$0.50", "0.005", "<0.0001"));
    expect(at.nextInvestmentNote).toBe(PENDING_COPY.includesConverting("$0.50"));
    expect([under.nextInvestmentGate, at.nextInvestmentGate]).toEqual(["wrap_line", null]);
  });

  it("adds free SOL under the line to wSOL converting on its own, and says the one sum the bar adds", () => {
    const data = owner({ wsol: CONVERT_DUST_LAMPORTS, entries: FRESH });
    const steps = pendingSteps(data);
    expect(steps).toEqual([expect.objectContaining({ kind: "converting", state: "active", amountRaw: CONVERT_DUST_LAMPORTS })]);
    const waiting = solUnderWrapLine(data);
    expect(waiting).toMatchObject({ lamports: UNDER_LINE, shortLamports: 1_088_201n });
    const total = value(CONVERT_DUST_LAMPORTS) + value(UNDER_LINE);
    expect(nextInvestmentOf(steps, waiting)).toEqual({ extraUsdcRaw: total, note: PENDING_COPY.includesBoth(formatUsd(total), "$0.39", "0.005", "0.0011") });
    const stats = statsOf(data);
    expect(stats.readyToInvestUsd).toBe(stats.pendingUsd);
    // $0.89 counted: the $0.11 the bar lacks would not reach the line, so the line is what is to go.
    expect([stats.toGoUsd, stats.nextInvestmentGate]).toEqual([0.108862, "wrap_line"]);
  });

  it("counts wSOL under its own line beside free SOL under the wrap line: both wait for the same wrap", () => {
    const data = owner({ free: 1_000n, wsol: 1_000_000n });
    expect(pendingSteps(data)).toEqual([]);
    expect(solUnderWrapLine(data)).toEqual({
      lamports: 1_001_000n,
      shortLamports: WRAP_DUST_LAMPORTS - 1_000n,
      valueUsdcRaw: value(1_000n) + value(1_000_000n),
      shortUsdcRaw: value(WRAP_DUST_LAMPORTS - 1_000n),
    });
    const stats = statsOf(data);
    expect(stats.readyToInvestUsd).toBe(stats.pendingUsd);
  });

  it("still counts the free SOL when the token list could not be read, and no wSOL it would have to guess", () => {
    expect(solUnderWrapLine(owner({ wsol: 1_000_000n, tokensReadable: false }))).toMatchObject({ lamports: UNDER_LINE });
  });

  it("is nothing over the line, where the converting step holds it all, and nothing for a vault holding only its rent", () => {
    expect(solUnderWrapLine(owner({ free: WRAP_DUST_LAMPORTS, wsol: 1_000n }))).toBeNull();
    expect(solUnderWrapLine(owner({ free: 0n, wsol: 0n }))).toBeNull();
    expect(solUnderWrapLine(owner({ policy: "missing" }))).toBeNull();
  });

  it("does not count SOL a rest the page can read holds back — the very rest the converting row would wait on", () => {
    const rests: readonly (readonly [PendingRest, Setup])[] = [
      ["paused", { paused: true }],
      ["buying_off", { policy: { ...OWNER_POLICY, enabled: false } }],
      ["protocol_paused", { protocolPaused: true }],
      ["month_cap", { policy: { ...OWNER_POLICY, maxRolling30d: "999999" } }],
      ["conversion_off", { policy: { ...OWNER_POLICY, minConvertRateWad: "0" } }],
      // An old policy whose SOL limit SOL has passed, and one whose stock limit has.
      ["price_limits", { policy: { minConvertRateWad: "100038711555492563" } }],
      ["price_limits", { policy: { legs: [{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: "131283650130637570" }] } }],
      // A live-price policy with SOL under its safety floor.
      ["safety_floor", { policy: { ...OWNER_POLICY, minConvertRateWad: "100038711555492563" } }],
    ];
    for (const [rest, setup] of rests) {
      expect(pendingSteps(dashboard({ ...setup, free: 20_000_000n }))[0]).toMatchObject({ kind: "converting", rest });
      const data = dashboard({ usdc: 400_000n, ...setup, free: UNDER_LINE });
      expect(solUnderWrapLine(data)).toBeNull();
      const stats = statsOf(data);
      expect(stats.readyToInvestUsd).toBe(0.4);
      expect([stats.nextInvestmentNote, stats.nextInvestmentGate]).toEqual([null, null]);
    }
  });

  it("says the SOL, not dollars, when no price was read, and keeps the USDC", () => {
    const data = owner({ usdc: 300_000n, prices: null });
    expect(nextInvestmentOf(pendingSteps(data), solUnderWrapLine(data))).toEqual({ extraUsdcRaw: null, note: PENDING_COPY.plusWaiting("0.0039", "0.005", "0.0011") });
    const stats = statsOf(data);
    expect(stats.readyToInvestUsd).toBe(0.3);
    // The dollars the bar shows are the USDC's; to go is their gap, the SOL said beside them.
    expect([stats.toGoUsd, stats.nextInvestmentGate]).toEqual([0.7, "wrap_line"]);
  });

  it("never reads $0.00 to go while the keeper idles: USDC under the basket, and SOL under the line that would fill it", () => {
    const stats = statsOf(owner({ usdc: 800_000n }));
    // $1.19 of $1.00 — and nothing is bought: $0.40 a leg from the USDC, and the SOL moves only from the line.
    expect(stats.readyToInvestUsd).toBe(1.191331);
    expect([stats.toGoUsd, stats.nextInvestmentGate]).toEqual([0.108862, "wrap_line"]);
    expect(stats.toGoUsd).toBe(Number(value(1_088_201n)) / 1e6);
  });

  it("is nothing to go, with no gate, once the USDC alone buys the basket", () => {
    const stats = statsOf(owner({ usdc: 1_000_000n, entries: FRESH }));
    expect([stats.toGoUsd, stats.nextInvestmentGate, stats.nextInvestmentNote]).toEqual([0, null, PENDING_COPY.readyToBuy]);
  });

  it("gates on a conversion that is overdue when it alone would complete the basket, and does not call it under way", () => {
    const late = owner({ free: 0n, wsol: 18_000_000n, entries: [liveEntry(signature(1), minutesAgo(20), [wrapped("18000000")])] });
    expect(pendingSteps(late)[0]).toMatchObject({ kind: "converting", state: "waiting", rest: "slow" });
    const stats = statsOf(late);
    expect([stats.toGoUsd, stats.nextInvestmentGate, stats.nextInvestmentNote]).toEqual([0, "slow", PENDING_COPY.includesConvertingSlow("$1.80")]);
    // The same SOL under way gates nothing.
    const active = statsOf(owner({ free: 0n, wsol: 18_000_000n, entries: OWNER_CASE.entries }));
    expect([active.toGoUsd, active.nextInvestmentGate, active.nextInvestmentNote]).toEqual([0, null, PENDING_COPY.includesConverting("$1.80")]);
  });

  it("says no to-go and no gate where there is no basket to measure", () => {
    const stats = statsOf(owner({ tokensReadable: false }));
    expect([stats.readyToInvestUsd, stats.toGoUsd, stats.nextInvestmentGate]).toEqual([null, null, null]);
  });
});

describe("the words", () => {
  it("joins a basket's names the way the rest of the page does", () => {
    expect(namesOf(["SPYx"])).toBe("SPYx");
    expect(namesOf(["SPYx", "ANTHROPIC"])).toBe("SPYx and ANTHROPIC");
    expect(namesOf(["SPYx", "GLDx", "ANTHROPIC"])).toBe("SPYx, GLDx and ANTHROPIC");
  });

  it("gives an active conversion its SOL and the sweep, and a resting one its reason", () => {
    expect(pendingLines(pendingSteps(dashboard(OWNER_CASE)))[0]).toEqual({
      key: "converting",
      kind: "converting",
      active: true,
      rest: null,
      title: PENDING_COPY.converting,
      sub: PENDING_COPY.convertingSub("0.018"),
      amount: "$1.80",
      // Its line already says the SOL; the re-priced dollars are not read out.
      amountSpoken: "",
    });
    expect(pendingLines(pendingSteps(dashboard({ ...OWNER_CASE, paused: true })))[0]).toMatchObject({ title: PENDING_COPY.convertingWaiting, sub: PENDING_COPY.rest.paused, active: false });
  });
});

/** THE WEBSITE'S HALF OF KEEPER_DUST (packages/solana-core/test/fixtures/keeper-policy.ts). */
describe("the keeper's dust lines", () => {
  it("are the vector's, in lamports and in the SOL they print as", () => {
    expect([WRAP_DUST_LAMPORTS, CONVERT_DUST_LAMPORTS]).toEqual([KEEPER_DUST.web.wrapDustLamports, KEEPER_DUST.web.convertDustLamports]);
    expect(KEEPER_DUST.web).toMatchObject({ wrapDustLamports: KEEPER_DUST.keeper.wrapDustLamports, convertDustLamports: KEEPER_DUST.keeper.convertDustLamports });
    expect(Number(WRAP_DUST_LAMPORTS) / 1e9).toBe(KEEPER_DUST.sol);
  });

  it("move exactly where the keeper's do", () => {
    expect(pendingSteps(dashboard({ free: KEEPER_DUST.boundary.moves }))).toHaveLength(1);
    expect(pendingSteps(dashboard({ free: KEEPER_DUST.boundary.stays }))).toEqual([]);
    expect(pendingSteps(dashboard({ wsol: KEEPER_DUST.boundary.moves }))).toHaveLength(1);
    expect(pendingSteps(dashboard({ wsol: KEEPER_DUST.boundary.stays }))).toEqual([]);
  });
});
