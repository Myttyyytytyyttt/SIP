// One turn of the investment loop.
//
// THE TESTS THAT MATTER ARE THE DOUBLE-BUY ONES. Everything else here checks
// that the tick reports the right word; those check that a purchase which was
// broadcast and lost cannot be sent again. A second purchase from one decision
// spends the rolling cap on something nobody authorised at that size, and it is
// the one failure in this loop that costs money rather than time.
//
// The guard is the chain's own counter: `aggregateLifetimeInvested` only ever
// moves when `invest()` succeeds. So the tick asks the vault what happened
// rather than asking its own records, and there is no local state to drift.

import { describe, expect, it, vi } from "vitest";

import {
  alertFor,
  runInvestmentTick,
  type InvestmentTickDeps,
  type InvestmentTickOutcome,
} from "../src/investment-tick.js";
import { INVESTMENT_SLOT, slotHex } from "../src/investment-state.js";
import type { InvestmentChainAccess } from "../src/investment-chain.js";
import type { InvestChainAccess } from "../src/investment-submit.js";
import { basketHash, encodeBasket, type BasketLeg } from "../src/investment-plan.js";
import { encodeAbiParameters, keccak256 } from "viem";

/** The two pools the tick reads, keyed by the exact slots it asks for. */
function poolSlots(c0: string, c1: string, fee: number, ts: number, slot0: bigint, liquidity: bigint) {
  const id = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [c0 as `0x${string}`, c1 as `0x${string}`, fee, ts, "0x0000000000000000000000000000000000000000"],
    ),
  );
  const base = BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, 6n])));
  return new Map<string, bigint>([
    [`0x${base.toString(16).padStart(64, "0")}`, slot0],
    [`0x${(base + 3n).toString(16).padStart(64, "0")}`, liquidity],
  ]);
}

const VAULT = "0x0b5036063527bA4e32032e1b6B953c3677386BBD" as const;
const SENDER = "0xA93095bB98e8B578e1560deD648D194FE4A335fA" as const;
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as const;
const PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951" as const;
const REGISTRY = "0x9822E46dd34d9bE579b61D26708a45Bf81B64E49" as const;
const ADAPTER = "0x883e8530e3DAE691e9B9e7139C895f9AE8972C7A" as const;

const LEGS: BasketLeg[] = [{ targetAsset: NVDA, weightBps: 10_000, minOutRateWad: 8_000_000_000_000_000_000n }];
const BASKET = basketHash(LEGS);

const word = (v: bigint): `0x${string}` => `0x${v.toString(16).padStart(64, "0")}`;
const addrWord = (a: string): `0x${string}` => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;

/** Live mainnet pool state, so the quote is a real number rather than a stub. */
const SLOT0_WETH_USDG = 205700626957838899953564782158229023648850915035853007021591302797n;
const SLOT0_USDG_NVDA = 1234178647065076656731217521463323191303702096311274296337420321123n;
const L_WETH_USDG = 68_903_952_934_212_396n;
const L_USDG_NVDA = 1_171_748_594_528_528_804n;

interface ChainOptions {
  readonly hasInvestPath?: boolean;
  readonly basketHash?: bigint;
  readonly adapterActive?: boolean;
  readonly lifetimeInvested?: bigint;
  readonly enabled?: boolean;
  readonly policyNonce?: bigint;
}

/**
 * A vault and a PoolManager, answering only what the tick reads.
 *
 * Dispatches on the raw slot rather than on a call index, so a tick that reads
 * the wrong slot gets zero — the same thing the real chain would give it —
 * instead of whichever answer happened to be next.
 */
function fakeChain(options: ChainOptions = {}): InvestmentChainAccess {
  const {
    hasInvestPath = true,
    lifetimeInvested = 0n,
    enabled = true,
    policyNonce = 1n,
    basketHash: basket = BigInt(BASKET),
    adapterActive = true,
  } = options;

  const vaultSlots = new Map<string, bigint>([
    // policyNonce | enabled<<64 | paused<<72
    [slotHex(INVESTMENT_SLOT.packed), policyNonce | (enabled ? 1n << 64n : 0n)],
    [slotHex(INVESTMENT_SLOT.adapterId), 0xa1n],
    [slotHex(INVESTMENT_SLOT.basketHash), basket],
    // minInvestmentWei | maxPerCallWei<<128
    [slotHex(INVESTMENT_SLOT.limits), 100_000_000_000_000n | (10n ** 18n << 128n)],
    [slotHex(INVESTMENT_SLOT.rollingCap), 5n * 10n ** 18n],
    [slotHex(INVESTMENT_SLOT.lifetimeTotals), lifetimeInvested << 128n],
  ]);

  const poolState = new Map<string, bigint>([
    ...poolSlots(WETH, USDG, 200, 4, SLOT0_WETH_USDG, L_WETH_USDG),
    ...poolSlots(USDG, NVDA, 3000, 60, SLOT0_USDG_NVDA, L_USDG_NVDA),
  ]);

  return {
    call: async (to, data) => {
      if (data.startsWith("0x1e2eaeaf")) {
        const slot = `0x${data.slice(10)}`;
        if (to.toLowerCase() === VAULT.toLowerCase()) {
          if (!hasInvestPath) throw new Error("execution reverted");
          return word(vaultSlots.get(slot) ?? 0n);
        }
        // EACH POOL ANSWERS ITS OWN SLOTS. The first version returned the
        // NVDA pool's state for both, so the WETH->USDG hop priced ether as if
        // it were a share and the route quoted nothing — a fake that made a
        // working tick look broken.
        const v = poolState.get(slot);
        if (v === undefined) return word(0n);
        return word(v);
      }
      if (data === "0x23e89ea6") return addrWord(REGISTRY); // ADAPTER_REGISTRY()
      if (data.startsWith("0xc77c8802")) return word(1n); // adapterStatusEpoch
      if (data.startsWith("0x3b832410")) return word(adapterActive ? 1n : 0n); // isAdapterActive
      if (data.startsWith("0x8272e138")) return addrWord(ADAPTER); // getAdapter
      throw new Error(`unexpected call ${data.slice(0, 10)}`);
    },
    // A REAL InvestmentPolicyUpdated. The first version returned an empty log,
    // and every test that got past the short-circuits failed as NO_BASKET —
    // which is the CORRECT reading of an unrecoverable basket, so the fake was
    // quietly testing the wrong branch everywhere.
    getLogs: async () => [
      {
        data: encodeAbiParameters(
          [
            { type: "bool" },
            { type: "uint128" },
            { type: "uint128" },
            { type: "uint128" },
            { type: "bytes" },
          ],
          [enabled, 100_000_000_000_000n, 10n ** 18n, 5n * 10n ** 18n, encodeBasket(LEGS)],
        ),
        topics: [
          "0x33762beb3032fdfce9ce8af0a1c4a7e02bf8a609603068ddc6e78c38de1c7c02",
          word(policyNonce),
          BASKET,
          word(0xa1n),
        ] as `0x${string}`[],
      },
    ],
    getBlockNumber: async () => 1n,
  };
}

function deps(over: Partial<InvestmentTickDeps> = {}): InvestmentTickDeps {
  return {
    chain: fakeChain(),
    submitChain: {
      estimateGas: async () => 400_000n,
      getFeeQuote: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }),
      getPendingTransactionCount: async () => 1,
      sendRawTransaction: async () => `0x${"cd".repeat(32)}`,
      waitForReceipt: async () => ({ status: "success", gasUsed: 1n }),
    } satisfies InvestChainAccess,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    vault: VAULT,
    sender: SENDER,
    weth: WETH,
    usdg: USDG,
    poolManager: PM,
    chainId: 4663,
    wethUsdgFee: 200,
    wethUsdgTickSpacing: 4,
    stockPools: new Map([[NVDA.toLowerCase(), { fee: 3000, tickSpacing: 60 }]]),
    sharesQuoters: new Map(),
    logsFromBlock: 0n,
    readWethBalance: async () => 5n * 10n ** 17n,
    signer: null,
    live: false,
    outstanding: null,
    ...over,
  };
}

describe("a vault that cannot invest", () => {
  it("reports an un-upgraded implementation as unsupported, not as an error", async () => {
    const r = await runInvestmentTick(deps({ chain: fakeChain({ hasInvestPath: false }) }));
    expect(r.outcome).toBe("NOT_SUPPORTED");
    expect(r.detail).toContain("beacon");
  });

  it("stays quiet when investing is switched off", async () => {
    const r = await runInvestmentTick(deps({ chain: fakeChain({ enabled: false }) }));
    expect(r.outcome).toBe("IDLE");
  });

  /**
   * BELOW THE THRESHOLD IS NOT A PROBLEM. It is the resting state of a vault
   * that is working, and alerting on it would train an operator to ignore the
   * channel that also carries the states that matter.
   */
  it("stays quiet below the admin's threshold", async () => {
    const r = await runInvestmentTick(deps({ readWethBalance: async () => 1n }));
    expect(r.outcome).toBe("IDLE");
    expect(r.decision?.kind).toBe("BELOW_THRESHOLD");
  });
});

/**
 * A VAULT THAT BELIEVES IT IS INVESTING AND IS NOT.
 *
 * These are the states `decideInvestment` calls actionable, and from the outside
 * they are indistinguishable from a healthy idle vault — enabled, funded, and
 * buying nothing. Reporting them as IDLE breaks no other test, which is exactly
 * why they need their own: a mutation that collapsed the distinction survived
 * the whole file until these were written.
 */
describe("the states that must not be reported as resting", () => {
  it("flags a vault with no basket, however healthy it looks", async () => {
    const r = await runInvestmentTick(deps({ chain: fakeChain({ basketHash: 0n }) }));
    expect(r.outcome).toBe("NEEDS_ATTENTION");
    expect(r.outcome).not.toBe("IDLE");
    expect(r.decision?.kind).toBe("NO_BASKET");
  });

  /**
   * A guardian deactivating the adapter stops every vault using it in the same
   * block, and no retry fixes that. Reported as needing a human, not as waiting.
   */
  it("flags a retired adapter rather than waiting forever", async () => {
    const r = await runInvestmentTick(deps({ chain: fakeChain({ adapterActive: false }) }));
    expect(r.outcome).toBe("NEEDS_ATTENTION");
    expect(r.detail).toMatch(/no retry will fix/);
  });

  /** And the ordinary resting states stay quiet, or the distinction is useless. */
  it("keeps paused and below-threshold quiet", async () => {
    expect((await runInvestmentTick(deps({ readWethBalance: async () => 1n }))).outcome).toBe("IDLE");
    expect((await runInvestmentTick(deps({ chain: fakeChain({ enabled: false }) }))).outcome).toBe("IDLE");
  });
});

describe("never buying twice", () => {
  /**
   * THE ONE THAT MATTERS. A purchase was broadcast, the receipt never arrived,
   * and the transaction is still pending. Sending another would spend the cap
   * twice on a single decision.
   */
  it("refuses to buy while a previous attempt is unresolved", async () => {
    let sends = 0;
    const r = await runInvestmentTick(
      deps({
        chain: fakeChain({ lifetimeInvested: 100n }),
        outstanding: { lifetimeInvestedBefore: 100n, txHash: `0x${"ab".repeat(32)}` },
        live: true,
        // ARMS `expect(sends).toBe(0)`. Without a signer, submitInvestment
        // returns BLOCKED/NO_SIGNER before it ever reaches sendRawTransaction,
        // so the assertion that names the money was watching a door nothing
        // could walk through.
        signer: { address: SENDER, signTransaction: async () => `0x${"ab".repeat(100)}` },
        submitChain: {
          estimateGas: async () => 400_000n,
          getFeeQuote: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }),
          getPendingTransactionCount: async () => 1,
          sendRawTransaction: async () => {
            sends += 1;
            return `0x${"ff".repeat(32)}`;
          },
          // NO RECEIPT: genuinely still pending, which is what this test is
          // about. It used to stub a SUCCESSFUL receipt, which the tick had no
          // way to read and therefore no way to be misled by — now it does, and
          // a mined-successful transaction whose counter has not moved is a
          // different situation with its own test below.
          waitForReceipt: async () => null,
        },
      }),
    );
    expect(r.outcome).toBe("NEEDS_ATTENTION");
    expect(sends).toBe(0);
    expect(r.outstanding).not.toBeNull();
    expect(r.detail).toContain("could buy twice");
  });

  /**
   * THE STALL THIS EXISTS TO PREVENT.
   *
   * A reverted purchase moves no counter, so "did lifetimeInvested change?"
   * answered no forever and the vault was held in NEEDS_ATTENTION on every tick
   * until someone restarted the process and wiped the in-memory record. And a
   * revert is not exotic: the purchase carries a 90-second deadline while the
   * submit path waits 90 seconds for a receipt, so a transaction that uses its
   * whole wait lands expired and reverts with DeadlineExpired.
   */
  it("clears a reverted attempt, buys again, and asks each question with its own timeout", async () => {
    const OUTSTANDING = `0x${"ab".repeat(32)}` as const;
    const RESENT = `0x${"ff".repeat(32)}` as const;
    // WHAT waitForReceipt WAS ASKED, not merely that it answered. The first
    // version of this test stubbed it argument-blind, so neither the hash nor
    // the timeout was pinned by anything: RESOLVE_RECEIPT_MS could be changed to
    // 90_000, or the resolve could ask about the wrong transaction entirely, and
    // all eighteen tests in this file stayed green. Both mutants now fail here.
    const asked: [string, number][] = [];
    const r = await runInvestmentTick(
      deps({
        chain: fakeChain({ lifetimeInvested: 100n }),
        outstanding: { lifetimeInvestedBefore: 100n, txHash: OUTSTANDING },
        live: true,
        signer: { address: SENDER, signTransaction: async () => `0x${"ab".repeat(100)}` },
        submitChain: {
          estimateGas: async () => 400_000n,
          getFeeQuote: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }),
          getPendingTransactionCount: async () => 1,
          sendRawTransaction: async () => RESENT,
          waitForReceipt: async (hash, timeoutMs) => {
            asked.push([hash, timeoutMs]);
            return hash === OUTSTANDING
              ? { status: "reverted", gasUsed: 21_000n }
              : { status: "success", gasUsed: 1n };
          },
        },
      }),
    );
    // BOUGHT, not merely "not stuck". The weaker assertion this replaces was
    // satisfied by any early return, including an IDLE that never buys.
    expect(r.outcome).toBe("BOUGHT");
    expect(r.outstanding).toBeNull();
    // The resolve asks a short question about the OLD transaction; the submit
    // that follows waits the long timeout on the NEW one. Collapsing the two
    // into one number is the mistake this pins.
    expect(asked).toEqual([
      [OUTSTANDING, 5_000],
      [RESENT, 90_000],
    ]);
  });

  /**
   * THE ONE CASE THAT MUST NOT SELF-CLEAR. Mined, succeeded, and the counter did
   * not move: that contradicts the contract, so the fault is in our model of the
   * world rather than in the transaction. Buying again on top of a contradiction
   * is how one bug becomes two purchases.
   */
  it("refuses to clear a purchase that succeeded without moving the counter", async () => {
    let sends = 0;
    const r = await runInvestmentTick(
      deps({
        chain: fakeChain({ lifetimeInvested: 100n }),
        outstanding: { lifetimeInvestedBefore: 100n, txHash: `0x${"ab".repeat(32)}` },
        live: true,
        // ARMS `expect(sends).toBe(0)`. Without a signer, submitInvestment
        // returns BLOCKED/NO_SIGNER before it ever reaches sendRawTransaction,
        // so the assertion that names the money was watching a door nothing
        // could walk through.
        signer: { address: SENDER, signTransaction: async () => `0x${"ab".repeat(100)}` },
        submitChain: {
          estimateGas: async () => 400_000n,
          getFeeQuote: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }),
          getPendingTransactionCount: async () => 1,
          sendRawTransaction: async () => {
            sends += 1;
            return `0x${"ff".repeat(32)}`;
          },
          waitForReceipt: async () => ({ status: "success", gasUsed: 1n }),
        },
      }),
    );
    expect(r.outcome).toBe("NEEDS_ATTENTION");
    expect(sends).toBe(0);
    expect(r.outstanding).not.toBeNull();
    expect(r.detail).toContain("cannot both be true");
  });

  /**
   * THE COUNTER MOVED, so the lost purchase landed. Resolved from the chain,
   * not from our own records — which is the point: there is no local state to
   * fall out of sync.
   */
  it("recognises a lost purchase that landed, and clears it", async () => {
    const r = await runInvestmentTick(
      deps({
        chain: fakeChain({ lifetimeInvested: 500n }),
        outstanding: { lifetimeInvestedBefore: 100n, txHash: `0x${"ab".repeat(32)}` },
      }),
    );
    expect(r.outcome).toBe("RECONCILED");
    expect(r.outstanding).toBeNull();
    expect(r.detail).toContain("100");
    expect(r.detail).toContain("500");
  });

  /** A receiptless send carries the marker forward rather than dropping it. */
  it("carries the counter forward when a send gets no receipt", async () => {
    const r = await runInvestmentTick(
      deps({
        chain: fakeChain({ lifetimeInvested: 42n }),
        live: true,
        signer: { address: SENDER, signTransaction: async () => `0x${"ab".repeat(100)}` },
        submitChain: {
          estimateGas: async () => 400_000n,
          getFeeQuote: async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }),
          getPendingTransactionCount: async () => 1,
          sendRawTransaction: async () => `0x${"ee".repeat(32)}`,
          waitForReceipt: async () => null,
        },
      }),
    );
    expect(r.outcome).toBe("NEEDS_ATTENTION");
    expect(r.outstanding?.lifetimeInvestedBefore).toBe(42n);
    expect(r.outstanding?.txHash).toBe(`0x${"ee".repeat(32)}`);
  });

  /**
   * RESOLVING COMES BEFORE DECIDING. Deciding first would size a new purchase
   * against a balance that the pending transaction is about to change.
   */
  it("resolves an outstanding attempt before reading anything else", async () => {
    const readWethBalance = vi.fn(async () => 5n * 10n ** 17n);
    await runInvestmentTick(
      deps({
        chain: fakeChain({ lifetimeInvested: 500n }),
        outstanding: { lifetimeInvestedBefore: 100n, txHash: `0x${"ab".repeat(32)}` },
        readWethBalance,
      }),
    );
    expect(readWethBalance).not.toHaveBeenCalled();
  });
});

describe("the pool a leg trades in", () => {
  /**
   * A leg with no configured pool is REFUSED, never quoted against a default.
   * Mainnet carries hookless pools for these pairs at 85%, 90% and 99.9%, so a
   * guess is not a smaller version of the right answer.
   */
  it("refuses a basket leg it has no pool for", async () => {
    const r = await runInvestmentTick(deps({ stockPools: new Map() }));
    expect(r.outcome).toBe("NEEDS_ATTENTION");
    expect(r.detail).toContain("no pool is configured");
    expect(r.detail).toContain(NVDA);
  });

  /**
   * THE DESK SEAM. A desk-routed leg's previewDeposit must be asked at the
   * QUOTER (the map's value) and never at the asset itself — the exact
   * one-token regression `readPreviewDeposit(chain, leg.targetAsset, …)`
   * type-checks, reads more natural than the correct code, and turns the
   * listing into a silently dead NEEDS_ATTENTION that blames the wrong
   * contract. The asset here REVERTS its preview, like the real pToken does
   * while Arcus keeps deposits gated, so the mutant cannot pass by accident.
   */
  it("asks the desk for the preview, never the asset", async () => {
    const DESK = "0x00000000000000000000000000000000000d05c0" as const;
    const previewSelector = "0xef8b30f7";
    const asked: string[] = [];
    const base = fakeChain();
    const chain = {
      ...base,
      call: async (to: `0x${string}`, data: `0x${string}`) => {
        if (data.startsWith(previewSelector)) {
          asked.push(to.toLowerCase());
          if (to.toLowerCase() === DESK) return `0x${(10n ** 30n).toString(16).padStart(64, "0")}` as `0x${string}`;
          throw new Error("execution reverted"); // the pToken's gated preview
        }
        return base.call(to, data);
      },
    };
    const r = await runInvestmentTick(
      deps({ chain, sharesQuoters: new Map([[NVDA.toLowerCase(), DESK]]) }),
    );
    expect(r.outcome).toBe("DRY_RUN");
    expect(asked).toEqual([DESK]);
  });
});

// Which outcomes reach a human.
//
// THE BUG THIS GUARDS AGAINST WAS AN OMISSION, NOT A WRONG ANSWER. The
// supervisor decided this with an if/else on two outcomes, so `REFUSED` — a
// purchase that was planned and then blocked, by a missing signer or an estimate
// that reverted — matched neither branch and produced no alert and no log. The
// only trace was the `investing` line printed just before it.
//
// That is the exact shape of a first live purchase dying on an `Unauthorized()`
// nobody ever sees, which is why it is tested rather than read.
describe("deciding what reaches a human", () => {
  const ALL: readonly InvestmentTickOutcome[] = [
    "NOT_SUPPORTED",
    "IDLE",
    "NEEDS_ATTENTION",
    "RECONCILED",
    "BOUGHT",
    "DRY_RUN",
    "REFUSED",
    "FAILED",
  ];

  /**
   * EVERY outcome has a decision. `alertFor` is a switch over the union with no
   * `default`, so a new outcome added without a decision fails to compile — but
   * only if every member is really listed there, which is what this checks.
   */
  it("has an answer for every outcome, so none can fall between the branches", () => {
    for (const outcome of ALL) {
      expect(alertFor(outcome), `no decision for ${outcome}`).not.toBeUndefined();
    }
  });

  it("pages loudly only for a purchase that reverted on chain", () => {
    expect(alertFor("FAILED")).toEqual({ severity: "critical", what: "failed" });
    for (const outcome of ALL.filter((o) => o !== "FAILED")) {
      expect(alertFor(outcome)?.severity).not.toBe("critical");
    }
  });

  /** The regression itself: a blocked submission must not be silent. */
  it("alerts on REFUSED, which used to vanish", () => {
    const decision = alertFor("REFUSED");
    expect(decision).not.toBeNull();
    expect(decision?.severity).toBe("warn");
    expect(decision?.what).toContain("refused");
  });

  it("warns when the vault believes it is investing and is not", () => {
    expect(alertFor("NEEDS_ATTENTION")?.severity).toBe("warn");
  });

  /**
   * SILENCE IS ALSO A DECISION. `NOT_SUPPORTED` is every vault until its beacon
   * is upgraded and `IDLE` is the resting state of a working one; alerting on
   * either would page on every tick of every vault and teach an operator to
   * ignore the channel that also carries the two above.
   */
  it("stays quiet for the resting states and for the loop working", () => {
    for (const outcome of ["IDLE", "NOT_SUPPORTED", "BOUGHT", "RECONCILED", "DRY_RUN"] as const) {
      expect(alertFor(outcome), `${outcome} should be silent`).toBeNull();
    }
  });
});
