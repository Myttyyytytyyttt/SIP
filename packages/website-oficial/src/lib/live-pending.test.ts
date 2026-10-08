// What the keeper is about to do with a live vault's money (owner, 2026-10-08),
// through the REAL model: every dashboard below is a snapshot and a page of
// history put through toLiveDashboard, never a hand-written view.

import { ANTHROPIC_MINT, SPYX_MINT, USDC_MINT, WSOL_MINT } from "@sip/solana-core/client";
import { describe, expect, it } from "vitest";

import { usdcRawForLamports } from "@/lib/amounts";
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
  return toLiveDashboard({ snapshot, activity: liveActivity(setup.entries ?? []), privyWallets: [] });
}

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
    const room = pendingSteps(dashboard({ usdc: 10_000_000n, policy: { ...BASKET, maxRolling30d: "2500000" } }));
    expect(room).toEqual([expect.objectContaining({ kind: "buying", state: "active", amountRaw: 2_500_000n })]);
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
    expect(pendingSteps(dashboard({ ...BOTH, protocolPaused: null })).map((step) => step.state)).toEqual(["active", "active"]);
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

  it("stays under way when the loaded history holds nothing to time it by", () => {
    expect(pendingSteps(dashboard({ wsol: 18_000_000n, entries: [] }))[0]).toMatchObject({ state: "active", since: null });
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
    expect(nextInvestmentOf(pendingSteps(dashboard({ usdc: 5_000_000n })))).toEqual({ extraUsdcRaw: null, note: PENDING_COPY.readyToBuy });
  });

  it("adds nothing and says nothing when nothing is in flight", () => {
    const data = dashboard({ usdc: 1_000_000n });
    expect(nextInvestmentOf(pendingSteps(data))).toEqual({ extraUsdcRaw: null, note: null });
    expect(toDashboardMock(data, { complete: true }).stats.nextInvestmentNote).toBeNull();
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
