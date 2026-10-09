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
  nextInvestment,
  nextInvestmentOf,
  pendingLines,
  pendingSteps,
  solUnderWrapLine,
  wrapLineAhead,
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
  /** The vault's free SOL could not be read: the snapshot carries no withdrawable lamports. */
  readonly freeUnread?: boolean;
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
      withdrawableLamports: setup.freeUnread === true ? undefined : free.toString(),
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
    expect(pendingLines(steps, NOW_MS)[0]!.amount).toBe("0.018 SOL");
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
    expect(pendingLines(steps, NOW_MS)[0]).toMatchObject({ title: PENDING_COPY.buying("SPYx and ANTHROPIC"), amount: "$2.50", active: true });
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
      expect(pendingLines(steps, NOW_MS).every((line) => !line.active)).toBe(true);
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
    expect(pendingLines(steps, NOW_MS)[0]).toMatchObject({ active: false, title: PENDING_COPY.convertingWaiting, sub: PENDING_COPY.rest.price_limits });
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
    expect(pendingLines(steps, NOW_MS)[0]).toMatchObject({ active: false, title: PENDING_COPY.convertingWaiting, sub: PENDING_COPY.rest.safety_floor });
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
    const line = pendingLines(pendingSteps(dashboard(at(12))), NOW_MS)[0]!;
    expect(line.active).toBe(false);
    expect(line.title).toBe(PENDING_COPY.convertingWaiting);
    expect(line.sub).toBe(PENDING_COPY.slow("11:48 UTC"));
  });

  /**
   * A STEP STUCK SINCE BEFORE TODAY SAYS ITS DAY (review 2026-10-09): "Not done
   * since 23:58 UTC" read at noon the next day passes for a few minutes.
   */
  it("says the day it has been stuck since, once that is not the page's own day", () => {
    const since = (ms: number): Setup => ({ ...OWNER_CASE, entries: [liveEntry(signature(1), seconds(ms), [wrapped("18000000")])] });
    // NOW_MS is Sep 16, 12:00 UTC.
    const subOf = (ms: number): string => pendingLines(pendingSteps(dashboard(since(ms))), NOW_MS)[0]!.sub;
    expect(subOf(Date.UTC(2026, 8, 15, 23, 58))).toBe(PENDING_COPY.slow("yesterday, 23:58 UTC"));
    expect(subOf(Date.UTC(2026, 8, 13, 9, 5))).toBe(PENDING_COPY.slow("Sep 13, 09:05 UTC"));
    expect(subOf(Date.UTC(2026, 8, 16, 0, 5))).toBe(PENDING_COPY.slow("00:05 UTC"));
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
    expect(pendingLines(steps, NOW_MS)[0]).toMatchObject({ active: false, title: PENDING_COPY.convertingWaiting, sub: PENDING_COPY.slowUntimed });
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

  it("says the SOL, not a dollar figure, when no price was read — on its own, beside a figure that is not shown", () => {
    expect(nextInvestmentOf(pendingSteps(dashboard({ ...OWNER_CASE, prices: null })))).toEqual({ extraUsdcRaw: null, note: PENDING_COPY.unpricedConverting("0.018") });
    const stats = toDashboardMock(dashboard({ ...OWNER_CASE, prices: null }), { complete: true }).stats;
    expect(stats.readyToInvestUsd).toBeNull();
    expect(stats.nextInvestmentNote).toBe(`${PENDING_COPY.unpricedConverting("0.018")} · ${PENDING_COPY.unknown.price}`);
    expect(stats.nextInvestmentNote).not.toMatch(/^Plus|Includes/);
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
    expect(stats.nextInvestmentNote).toBe(PENDING_COPY.includesWaiting("$0.39", "0.0011"));
    // A saving of what the bar lacks crosses the line too, so that is what is to go — and the line still gates it.
    expect(stats.toGoUsd).toBe(0.608669);
    expect(stats.nextInvestmentGate).toBe("wrap_line");
  });

  it("says what moves the SOL from the keeper's constant, not a figure typed into the words", () => {
    // The free SOL's own shortfall: the line less what it holds.
    const short = Number(BigInt(Math.round(KEEPER_DUST.sol * 1e9)) - UNDER_LINE) / 1e9;
    expect(PENDING_COPY.includesWaiting("$0.39", short.toFixed(4))).toBe(statsOf(owner()).nextInvestmentNote);
    // And the whole line, where it is the next saving's to cross.
    expect(statsOf(owner({ free: 0n, usdc: 800_000n })).nextInvestmentNote).toBe(PENDING_COPY.lineAhead(String(KEEPER_DUST.sol), "$0.50"));
  });

  /**
   * EACH HOLDING REACHES ITS OWN LINE (review 2026-10-09). The keeper wraps the
   * free SOL from its line and converts the wSOL from its own; it never pools
   * them. 0.003 free and 0.003 wrapped is 0.006 held and nothing moves, so no
   * line may say "once your vault holds 0.005 SOL" — only what moves it: the
   * savings that take the free SOL to the line.
   */
  it("never says the SOL converts once the vault holds the line: free SOL and wSOL do not pool", () => {
    const data = owner({ free: 3_000_000n, wsol: 3_000_000n });
    expect(pendingSteps(data)).toEqual([]);
    const note = statsOf(data).nextInvestmentNote!;
    expect(note).toBe(PENDING_COPY.includesWaiting(formatUsd(value(3_000_000n) + value(3_000_000n)), "0.002"));
    expect(note).not.toMatch(/holds|gathered|has gathered/);
    for (const text of [
      PENDING_COPY.includesWaiting("$1", "0.1"),
      PENDING_COPY.unpricedWaiting("0.1", "0.1"),
      PENDING_COPY.includesBoth("$1", "$1", "0.1"),
      PENDING_COPY.unpricedBoth("0.1", "0.1", "0.1"),
      PENDING_COPY.includesBothSlow("$1", "$1", "0.1"),
      PENDING_COPY.unpricedBothSlow("0.1", "0.1", "0.1"),
      PENDING_COPY.lineAhead("0.005", "$0.50"),
    ]) {
      expect(text).not.toMatch(/your vault holds|has gathered|keeper|poll/i);
    }
  });

  it("moves no counted figure when the SOL crosses the line; what is to go is then the whole line the next saving must cross", () => {
    const under = statsOf(owner({ free: WRAP_DUST_LAMPORTS - 1n, entries: FRESH }));
    const at = statsOf(owner({ free: WRAP_DUST_LAMPORTS, entries: FRESH }));
    expect(under.readyToInvestUsd).toBe(0.500193);
    expect(at.readyToInvestUsd).toBe(under.readyToInvestUsd);
    // Under it, one more lamport crosses the line and the $0.50 the basket lacks is the larger figure.
    expect(under.toGoUsd).toBe(0.499807);
    // At it, the conversion takes all of it, and the next saving lands on an empty vault: it must bring the whole line.
    expect(at.toGoUsd).toBe(Number(value(WRAP_DUST_LAMPORTS)) / 1e6);
    expect(under.nextInvestmentNote).toBe(PENDING_COPY.includesWaiting("$0.50", "<0.0001"));
    expect(at.nextInvestmentNote).toBe(`${PENDING_COPY.includesConverting("$0.50")} · ${PENDING_COPY.lineAhead("0.005", "$0.50")}`);
    expect([under.nextInvestmentGate, at.nextInvestmentGate]).toEqual(["wrap_line", "wrap_line"]);
  });

  it("adds free SOL under the line to wSOL converting on its own, and says the one sum the bar adds", () => {
    const data = owner({ wsol: CONVERT_DUST_LAMPORTS, entries: FRESH });
    const steps = pendingSteps(data);
    expect(steps).toEqual([expect.objectContaining({ kind: "converting", state: "active", amountRaw: CONVERT_DUST_LAMPORTS })]);
    const waiting = solUnderWrapLine(data);
    expect(waiting).toMatchObject({ lamports: UNDER_LINE, shortLamports: 1_088_201n });
    const total = value(CONVERT_DUST_LAMPORTS) + value(UNDER_LINE);
    expect(nextInvestmentOf(steps, waiting)).toEqual({ extraUsdcRaw: total, note: PENDING_COPY.includesBoth(formatUsd(total), "$0.39", "0.0011") });
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
      // Held, and said: no saving converts while the rest stands, so the USDC's gap is no promise of a buy.
      expect([stats.nextInvestmentNote, stats.nextInvestmentGate]).toEqual([PENDING_COPY.rest[rest as Exclude<PendingRest, "slow">], "held"]);
      expect(stats.nextInvestmentParts).toMatchObject({ usdc: 0.4, converting: 0, waiting: 0, held: Number(value(UNDER_LINE)) / 1e6 });
    }
  });

  /**
   * NO PRICE, NO FIGURE (review 2026-10-09). The bar used to show the USDC
   * alone — "$0.30 of $1.00" — beside SOL it had not valued, and "$0.70 to go"
   * that left the wrap line out. A figure made with an unknown is unknown.
   */
  it("shows no figure and no to-go when no price was read, and says the SOL in SOL and why", () => {
    const data = owner({ usdc: 300_000n, prices: null });
    expect(nextInvestmentOf(pendingSteps(data), solUnderWrapLine(data))).toEqual({ extraUsdcRaw: null, note: PENDING_COPY.unpricedWaiting("0.0039", "0.0011") });
    const stats = statsOf(data);
    expect([stats.readyToInvestUsd, stats.toGoUsd, stats.nextInvestmentGate]).toEqual([null, null, "unknown"]);
    expect(stats.nextInvestmentNote).toBe(`${PENDING_COPY.unpricedWaiting("0.0039", "0.0011")} · ${PENDING_COPY.unknown.price}`);
    // The holdings hide the dollar column without prices; the parts do as well, and agree with Pending's dash.
    expect(stats.nextInvestmentParts).toEqual({ usdc: null, converting: 0, waiting: null, held: 0 });
    expect(stats.pendingUsd).toBeNull();
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

  /**
   * AN OVERDUE CONVERSION BESIDE SOL UNDER THE LINE (review 2026-10-09): the
   * one-sum line said "on its way to USDC" over a conversion the keeper had
   * failed for 20 minutes, while the bar stopped short and named nothing.
   */
  it("does not call an overdue conversion on its way when SOL also waits under the line", () => {
    const late = owner({ wsol: 18_000_000n, entries: [liveEntry(signature(1), minutesAgo(20), [wrapped("18000000")])] });
    expect(pendingSteps(late)[0]).toMatchObject({ kind: "converting", state: "waiting", rest: "slow" });
    const total = value(18_000_000n) + value(UNDER_LINE);
    const stats = statsOf(late);
    expect(stats.nextInvestmentNote).toBe(PENDING_COPY.includesBothSlow(formatUsd(total), "$0.39", "0.0011"));
    expect(stats.nextInvestmentNote).not.toBe(PENDING_COPY.includesBoth(formatUsd(total), "$0.39", "0.0011"));
    expect([stats.toGoUsd, stats.nextInvestmentGate]).toEqual([0, "slow"]);
    // Without a price, in SOL, and the same.
    const unpriced = owner({ wsol: 18_000_000n, prices: null, entries: [liveEntry(signature(1), minutesAgo(20), [wrapped("18000000")])] });
    expect(nextInvestmentOf(pendingSteps(unpriced), solUnderWrapLine(unpriced)).note).toBe(PENDING_COPY.unpricedBothSlow("0.0219", "0.0039", "0.0011"));
    const alone = owner({ free: 0n, wsol: 18_000_000n, prices: null, entries: [liveEntry(signature(1), minutesAgo(20), [wrapped("18000000")])] });
    expect(nextInvestmentOf(pendingSteps(alone), solUnderWrapLine(alone)).note).toBe(PENDING_COPY.unpricedConvertingSlow("0.018"));
  });
});

/**
 * THE LINE BINDS EVERY SAVING, NOT ONLY THE SOL UNDER IT (review 2026-10-09).
 * After a wrap the vault holds no free SOL, so solUnderWrapLine says nothing —
 * and "to go" read as the USDC's own gap: USDC $0.80 of $1.00 said "$0.20 to
 * go", a $0.43 saving landed under the line, the keeper wrapped none of it
 * and bought nothing ($0.40 a leg), and only then did the card name the line.
 */
describe("the wrap line the next saving must cross", () => {
  const OWNER_POLICY: Partial<InvestmentPolicyJson> = {
    minInvestment: "500000",
    maxPerCall: "149000000",
    legs: [
      { mint: SPYX_MINT, weightBps: 5_000, minOutRateWad: "1" },
      { mint: ANTHROPIC_MINT, weightBps: 5_000, minOutRateWad: "1" },
    ],
  };
  const owner = (setup: Setup = {}): LiveDashboard => dashboard({ free: 0n, usdc: 0n, policy: OWNER_POLICY, ...setup });
  const statsOf = (data: LiveDashboard) => toDashboardMock(data, { complete: true }).stats;
  const LINE_USD = Number(usdcRawForLamports(WRAP_DUST_LAMPORTS, PER_SOL)) / 1e6;

  it("is what is to go with no free SOL at all, when it is more than the basket lacks, and the line under the bar says it", () => {
    const data = owner({ usdc: 800_000n });
    expect(solUnderWrapLine(data)).toBeNull();
    expect(wrapLineAhead(data)).toEqual({ shortLamports: WRAP_DUST_LAMPORTS, shortUsdcRaw: usdcRawForLamports(WRAP_DUST_LAMPORTS, PER_SOL) });
    const stats = statsOf(data);
    expect(stats.readyToInvestUsd).toBe(0.8);
    expect(stats.toGoUsd).toBeGreaterThanOrEqual(LINE_USD);
    expect(stats.toGoUsd).toBe(LINE_USD);
    expect(stats.nextInvestmentGate).toBe("wrap_line");
    expect(stats.nextInvestmentNote).toBe(PENDING_COPY.lineAhead("0.005", "$0.50"));
  });

  it("is the whole line while the free SOL is being converted: the next saving lands on an empty vault", () => {
    const data = owner({ free: 8_000_000n, entries: FRESH });
    expect(pendingSteps(data)).toEqual([expect.objectContaining({ kind: "converting", state: "active", amountRaw: 8_000_000n })]);
    expect(wrapLineAhead(data)?.shortLamports).toBe(WRAP_DUST_LAMPORTS);
    const stats = statsOf(data);
    expect(stats.readyToInvestUsd).toBe(Number(usdcRawForLamports(8_000_000n, PER_SOL)) / 1e6);
    expect([stats.toGoUsd, stats.nextInvestmentGate]).toEqual([LINE_USD, "wrap_line"]);
    expect(stats.nextInvestmentNote).toBe(`${PENDING_COPY.includesConverting("$0.80")} · ${PENDING_COPY.lineAhead("0.005", "$0.50")}`);
  });

  it("is not what is to go when the basket lacks more than the line: any such saving crosses it", () => {
    const stats = statsOf(owner({ usdc: 200_000n }));
    expect([stats.toGoUsd, stats.nextInvestmentGate, stats.nextInvestmentNote]).toEqual([0.8, null, null]);
  });

  it("cannot be weighed without a price, and is not claimed either way: no figure, no to-go, and the line says why", () => {
    const stats = statsOf(owner({ usdc: 800_000n, prices: null }));
    expect([stats.readyToInvestUsd, stats.toGoUsd, stats.nextInvestmentGate, stats.nextInvestmentNote]).toEqual([null, null, "unknown", PENDING_COPY.unknown.price]);
  });

  it("is nothing under a rest the page can read, or with the vault's SOL unread", () => {
    expect(wrapLineAhead(owner({ usdc: 800_000n, paused: true }))).toBeNull();
    expect(wrapLineAhead(owner({ policy: { ...OWNER_POLICY, minConvertRateWad: "0" } }))).toBeNull();
    // The rest is what holds the buy, and the line says it: the USDC's gap stays, never a promise.
    const stats = statsOf(owner({ usdc: 800_000n, paused: true }));
    expect([stats.toGoUsd, stats.nextInvestmentGate, stats.nextInvestmentNote]).toEqual([0.2, "held", PENDING_COPY.rest.paused]);
  });
});

/**
 * A BASKET THE USDC BUYS, HELD BY A REST THE PAGE CAN READ (review
 * 2026-10-09): the vault paused with $1.20 of USDC read "$1.20 of $1.00 ·
 * $0.00 to go" on a full bar, with nothing under it — a buy the paused keeper
 * would never make.
 */
describe("a basket the USDC buys, under a rest", () => {
  const OWNER_POLICY: Partial<InvestmentPolicyJson> = {
    minInvestment: "500000",
    maxPerCall: "149000000",
    legs: [
      { mint: SPYX_MINT, weightBps: 5_000, minOutRateWad: "1" },
      { mint: ANTHROPIC_MINT, weightBps: 5_000, minOutRateWad: "1" },
    ],
  };
  const statsOf = (setup: Setup) => toDashboardMock(dashboard({ usdc: 1_200_000n, policy: OWNER_POLICY, entries: FRESH, ...setup }), { complete: true }).stats;

  it("is gated by that rest, and the line under the bar names it", () => {
    const paused = statsOf({ paused: true });
    expect(paused).not.toMatchObject({ toGoUsd: 0, nextInvestmentGate: null });
    expect([paused.toGoUsd, paused.nextInvestmentGate, paused.nextInvestmentNote]).toEqual([0, "held", PENDING_COPY.rest.paused]);
    const rests: readonly (readonly [Exclude<PendingRest, "slow">, Setup])[] = [
      ["buying_off", { policy: { ...OWNER_POLICY, enabled: false } }],
      ["protocol_paused", { protocolPaused: true }],
      ["month_cap", { policy: { ...OWNER_POLICY, maxRolling30d: "999999" } }],
      ["price_limits", { policy: { ...OWNER_POLICY, legs: [{ mint: SPYX_MINT, weightBps: 10_000, minOutRateWad: "131283650130637570" }] } }],
    ];
    for (const [rest, setup] of rests) {
      const stats = statsOf(setup);
      expect([stats.toGoUsd, stats.nextInvestmentGate, stats.nextInvestmentNote]).toEqual([0, "held", PENDING_COPY.rest[rest]]);
    }
  });

  it("is a buy coming, with no gate, when nothing rests it", () => {
    const stats = statsOf({});
    expect([stats.toGoUsd, stats.nextInvestmentGate, stats.nextInvestmentNote]).toEqual([0, null, PENDING_COPY.readyToBuy]);
  });
});

/**
 * WHAT NEXT INVESTMENT IS MADE OF, HELD TO PENDING IN RAW UNITS (review
 * 2026-10-09). The bar's figure is USDC + SOL converting + SOL waiting under
 * the keeper's lines; the SOL a rest holds back is the fourth part, pending and
 * not counted. Rounded dollars would hide a raw unit lost between them, so the
 * sums are asserted in lamports and in USDC raw, never in dollars.
 */
describe("Next investment, part by part", () => {
  const OWNER_POLICY: Partial<InvestmentPolicyJson> = {
    minInvestment: "500000",
    maxPerCall: "149000000",
    legs: [
      { mint: SPYX_MINT, weightBps: 5_000, minOutRateWad: "1" },
      { mint: ANTHROPIC_MINT, weightBps: 5_000, minOutRateWad: "1" },
    ],
  };
  const OVERDUE = [liveEntry(signature(1), minutesAgo(20), [wrapped("18000000")])];
  const CASES: readonly (readonly [string, Setup])[] = [
    ["nothing in the vault", { usdc: 0n }],
    ["the owner's wrap, converting", OWNER_CASE],
    ["the owner's $0.43 under the wrap line", { free: 3_911_799n, usdc: 0n, policy: OWNER_POLICY }],
    ["free SOL and wSOL each under their own line", { free: 3_000_000n, wsol: 3_000_000n, usdc: 250_000n, policy: OWNER_POLICY }],
    ["wSOL converting on its own, free SOL under the line", { free: 3_911_799n, wsol: CONVERT_DUST_LAMPORTS, entries: FRESH, policy: OWNER_POLICY }],
    // One sum of these two values a raw unit more than the two rows: the step must be valued row by row.
    ["free SOL over the line, taking the wSOL with it", { free: 5_000_000n, wsol: 1_234_567n, usdc: 700_001n, entries: FRESH }],
    ["a conversion overdue", { free: 0n, wsol: 18_000_000n, usdc: 1n, entries: OVERDUE }],
    ["USDC that buys the basket", { usdc: 5_000_000n, wsol: 1_000n, entries: FRESH }],
    ["paused", { free: 20_000_000n, wsol: 1_234_567n, usdc: 400_000n, paused: true }],
    ["buying off", { free: 3_911_799n, wsol: 7_654_321n, usdc: 400_000n, policy: { ...OWNER_POLICY, enabled: false } }],
    ["SaverFi paused", { free: 20_000_000n, usdc: 400_000n, protocolPaused: true }],
    ["the 30-day limit", { free: 3_911_799n, usdc: 400_000n, policy: { ...OWNER_POLICY, maxRolling30d: "999999" } }],
    ["converting off", { free: 20_000_000n, wsol: 999_999n, usdc: 400_000n, policy: { ...OWNER_POLICY, minConvertRateWad: "0" } }],
    ["the old SOL limit", { ...OWNER_CASE, usdc: 10_000_000n, policy: { minConvertRateWad: "100038711555492563" } }],
    ["the safety floor", { free: 3_911_799n, wsol: 1_234_567n, usdc: 400_000n, policy: { ...OWNER_POLICY, minConvertRateWad: "100038711555492563" } }],
    ["no price", { ...OWNER_CASE, free: 3_911_799n, usdc: 300_000n, prices: null }],
    ["no price, no money", { usdc: 0n, prices: null }],
    ["the free SOL unread", { freeUnread: true, wsol: 1_234_567n, usdc: 400_000n }],
  ];

  for (const [name, setup] of CASES) {
    it(`adds up, in raw units: ${name}`, () => {
      const data = dashboard(setup);
      const steps = pendingSteps(data);
      const next = nextInvestment(data, steps)!;
      expect(next).not.toBeNull();
      const { parts } = next;
      const free = data.vault.withdrawable;
      const wsol = data.holdings.find((row) => row.kind === "wsol")?.amountRaw ?? 0n;

      // THE SOL: every lamport the vault holds outside its rent, in exactly one part.
      const lamports = [parts.convertingLamports, parts.waitingLamports, parts.heldLamports];
      if (lamports.every((part) => part !== null)) {
        expect(free).not.toBeNull();
        expect(lamports.reduce((total, part) => total! + part!, 0n)).toBe(free! + wsol);
      } else {
        // Only the free SOL unread leaves a holding unplaced here; no price leaves every lamport placed.
        expect(free).toBeNull();
      }

      // THE DOLLARS: the four parts are the footer's Pending, to the raw unit.
      const raw = [parts.usdcRaw, parts.convertingRaw, parts.waitingRaw, parts.heldRaw];
      if (raw.every((part) => part !== null)) {
        expect(data.notInvestedUsdcRaw).not.toBeNull();
        expect(raw.reduce((total, part) => total! + part!, 0n)).toBe(data.notInvestedUsdcRaw);
      }

      // THE FIGURE: USDC + converting + waiting, or unknown when any of them is.
      const counted = [parts.usdcRaw, parts.convertingRaw, parts.waitingRaw];
      expect(next.readyRaw).toBe(counted.every((part) => part !== null) ? counted.reduce((total, part) => total! + part!, 0n) : null);
      const stats = toDashboardMock(data, { complete: true }).stats;
      expect(stats.readyToInvestUsd).toBe(next.readyRaw === null ? null : Number(next.readyRaw) / 1e6);
      expect(stats.nextInvestmentParts).toEqual({
        usdc: parts.usdcRaw === null ? null : Number(parts.usdcRaw) / 1e6,
        converting: parts.convertingRaw === null ? null : Number(parts.convertingRaw) / 1e6,
        waiting: parts.waitingRaw === null ? null : Number(parts.waitingRaw) / 1e6,
        held: parts.heldRaw === null ? null : Number(parts.heldRaw) / 1e6,
      });
      if (next.readyRaw !== null && parts.heldRaw === 0n) expect(stats.readyToInvestUsd).toBe(stats.pendingUsd);

      // AND THE ROWS AGREE: the converting part is the step the column draws, the waiting part the SOL under the lines.
      if (parts.convertingLamports !== null) {
        const step = steps.find((entry) => entry.kind === "converting" && (entry.state === "active" || entry.rest === "slow"));
        expect(parts.convertingLamports).toBe(step?.amountRaw ?? 0n);
        if (parts.convertingRaw !== null) expect(parts.convertingRaw).toBe(step?.valueUsdcRaw ?? 0n);
      }
      if (parts.waitingLamports !== null) expect(parts.waitingLamports).toBe(solUnderWrapLine(data)?.lamports ?? 0n);
    });
  }

  it("counts the SOL a rest holds as held, and never in the figure", () => {
    const next = nextInvestment(dashboard({ free: 20_000_000n, wsol: 1_234_567n, usdc: 400_000n, paused: true }))!;
    expect(next.parts).toMatchObject({ usdcRaw: 400_000n, convertingRaw: 0n, waitingRaw: 0n, heldLamports: 21_234_567n });
    expect(next.readyRaw).toBe(400_000n);
    expect(next.gate).toBe("held");
  });

  it("is nothing to measure without a basket: no policy, or the vault's USDC unread", () => {
    expect(nextInvestment(dashboard({ free: 20_000_000n, policy: "missing" }))).toBeNull();
    expect(nextInvestment(dashboard({ free: 20_000_000n, tokensReadable: false }))).toBeNull();
  });
});

/**
 * WHAT THE PAGE CANNOT WEIGH IS SAID, NEVER GUESSED (review 2026-10-09). The
 * bar used to count what it could read and leave the rest out: the free SOL
 * unread added nothing, and a switch unread built no step at all — so "$0.00
 * to go" promised a buy the page had no grounds for.
 */
describe("Next investment, unknown", () => {
  const OWNER_POLICY: Partial<InvestmentPolicyJson> = {
    minInvestment: "500000",
    maxPerCall: "149000000",
    legs: [
      { mint: SPYX_MINT, weightBps: 5_000, minOutRateWad: "1" },
      { mint: ANTHROPIC_MINT, weightBps: 5_000, minOutRateWad: "1" },
    ],
  };
  const statsOf = (data: LiveDashboard) => toDashboardMock(data, { complete: true }).stats;

  it("has no figure and no to-go when the vault's free SOL could not be read, and says so", () => {
    const stats = statsOf(dashboard({ freeUnread: true, wsol: 1_000_000n, usdc: 400_000n, policy: OWNER_POLICY }));
    expect([stats.readyToInvestUsd, stats.toGoUsd, stats.nextInvestmentGate, stats.nextInvestmentNote]).toEqual([null, null, "unknown", PENDING_COPY.unknown.balance]);
    expect(stats.nextInvestmentParts).toEqual({ usdc: 0.4, converting: null, waiting: null, held: 0 });
  });

  it("says nothing of a sum it cannot make: no 'Includes' line under the dash, even for wSOL converting", () => {
    const stats = statsOf(dashboard({ freeUnread: true, wsol: 18_000_000n, usdc: 0n, entries: FRESH, policy: OWNER_POLICY }));
    expect(pendingSteps(dashboard({ freeUnread: true, wsol: 18_000_000n, entries: FRESH }))[0]).toMatchObject({ kind: "converting", state: "active" });
    expect(stats.readyToInvestUsd).toBeNull();
    expect(stats.nextInvestmentNote).toBe(PENDING_COPY.unknown.balance);
  });

  it("still says a basket the USDC alone buys is ready, whatever the SOL", () => {
    const stats = statsOf(dashboard({ freeUnread: true, usdc: 5_000_000n, entries: FRESH, policy: OWNER_POLICY }));
    expect([stats.readyToInvestUsd, stats.toGoUsd, stats.nextInvestmentGate, stats.nextInvestmentNote]).toEqual([null, 0, null, PENDING_COPY.readyToBuy]);
  });

  it("is unknown whatever the USDC when a switch the turn reads could not be read", () => {
    for (const usdc of [400_000n, 5_000_000n]) {
      const data = dashboard({ usdc, entries: FRESH, policy: OWNER_POLICY });
      // The vault's pause unread: the keeper's turn may not run at all.
      const unread: LiveDashboard = { ...data, vault: { ...data.vault, paused: null } };
      const next = nextInvestment(unread)!;
      expect([next.toGoRaw, next.gate, next.note]).toEqual([null, "unknown", PENDING_COPY.unknown.switch]);
      // With no SOL there is nothing to place, and the figure is the USDC.
      expect(next.readyRaw).toBe(usdc);
    }
    const withSol = dashboard({ free: 3_911_799n, usdc: 400_000n, policy: OWNER_POLICY });
    expect(nextInvestment({ ...withSol, vault: { ...withSol.vault, paused: null } })!.parts).toMatchObject({ convertingRaw: null, waitingRaw: null, heldRaw: null });
  });

  it("names the input in words the owner knows", () => {
    for (const text of Object.values(PENDING_COPY.unknown)) expect(text).not.toMatch(/keeper|poll|\bread\b|lamport|wad/i);
  });
});

describe("the words", () => {
  it("joins a basket's names the way the rest of the page does", () => {
    expect(namesOf(["SPYx"])).toBe("SPYx");
    expect(namesOf(["SPYx", "ANTHROPIC"])).toBe("SPYx and ANTHROPIC");
    expect(namesOf(["SPYx", "GLDx", "ANTHROPIC"])).toBe("SPYx, GLDx and ANTHROPIC");
  });

  it("gives an active conversion its SOL and the sweep, and a resting one its reason", () => {
    expect(pendingLines(pendingSteps(dashboard(OWNER_CASE)), NOW_MS)[0]).toEqual({
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
    expect(pendingLines(pendingSteps(dashboard({ ...OWNER_CASE, paused: true })), NOW_MS)[0]).toMatchObject({ title: PENDING_COPY.convertingWaiting, sub: PENDING_COPY.rest.paused, active: false });
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
