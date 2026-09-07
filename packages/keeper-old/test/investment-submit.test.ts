// Encoding the purchase, and refusing to send one that would revert.
//
// THE ENCODING TEST IS THE ONE THAT EARNS ITS KEEP. `invest` ends in two adjacent
// `uint64` arguments — `expectedAdapterStatusEpoch` then
// `expectedInvestmentPolicyNonce` — and swapping them compiles, encodes, and
// produces a transaction that reverts naming two numbers which both look
// plausible. Nothing but a fixture with distinct values catches it.

import { describe, expect, it } from "vitest";
import { toFunctionSelector } from "viem";
import { abis } from "@nuvem/contracts-artifacts";

import type { InvestCall } from "../src/investment-plan.js";
import {
  describeInvestPlan,
  encodeInvestCalldata,
  submitInvestment,
  type InvestChainAccess,
  type InvestSigner,
} from "../src/investment-submit.js";

const VAULT = "0x0b5036063527bA4e32032e1b6B953c3677386BBD" as const;
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as const;

/** Epoch and nonce deliberately different, and neither is 0 or 1. */
const CALL: InvestCall = {
  legs: [{ targetAsset: NVDA, weightBps: 10_000, minOutRateWad: 8_000_000_000_000_000_000n }],
  amountIn: 406_589_807_384_335n,
  minAmountsOut: [3_300_000_000_000_000n],
  deadline: 2_000_000_000,
  policyNonce: 7n,
  adapterStatusEpoch: 42n,
  quoted: [{ targetAsset: NVDA, legAmount: 406_589_807_384_335n, quote: 3_335_000_000_000_000n }],
};

function chainStub(over: Partial<InvestChainAccess> = {}): InvestChainAccess {
  return {
    estimateGas: async () => 350_000n,
    getFeeQuote: async () => ({ maxFeePerGas: 100_000_000n, maxPriorityFeePerGas: 1_000_000n }),
    getPendingTransactionCount: async () => 11,
    sendRawTransaction: async () => `0x${"cd".repeat(32)}`,
    waitForReceipt: async () => ({ status: "success", gasUsed: 331_000n }),
    ...over,
  };
}

const signer: InvestSigner = {
  address: "0xA93095bB98e8B578e1560deD648D194FE4A335fA",
  signTransaction: async () => `0x${"ab".repeat(100)}`,
};

describe("encoding the call", () => {
  /**
   * DERIVED FROM THE COMPILED CONTRACT, not transcribed.
   *
   * The first draft of this test asserted a hand-written `0x8d1a696d`, which is
   * not `invest` — it is nothing. A wrong constant here would have passed
   * whenever the encoder was wrong in the same way, and failed whenever it was
   * right. Deriving from the artifact means this test compares the encoder
   * against the contract it will actually call, and drifts only when they do.
   */
  it("starts with the selector the compiled vault answers to", () => {
    const fragment = (abis.PersonalVault as readonly { type?: string; name?: string }[]).find(
      (entry) => entry.type === "function" && entry.name === "invest",
    );
    expect(fragment).toBeDefined();
    const expected = toFunctionSelector(fragment as never);
    expect(encodeInvestCalldata(CALL).slice(0, 10)).toBe(expected);
  });

  /**
   * THE ADJACENT uint64s. Both are 64-bit, both sit at the end, and both encode
   * to a plausible word. If the order flips, this fixture's 42 and 7 appear in
   * the wrong order in the calldata — which is the only way to see it.
   */
  it("puts the adapter epoch before the policy nonce", () => {
    const data = encodeInvestCalldata(CALL);
    const epochWord = data.indexOf((42n).toString(16).padStart(64, "0"));
    const nonceWord = data.indexOf((7n).toString(16).padStart(64, "0"));
    expect(epochWord).toBeGreaterThan(-1);
    expect(nonceWord).toBeGreaterThan(-1);
    expect(epochWord).toBeLessThan(nonceWord);
  });

  it("changes when any argument changes", () => {
    const base = encodeInvestCalldata(CALL);
    expect(encodeInvestCalldata({ ...CALL, amountIn: CALL.amountIn + 1n })).not.toBe(base);
    expect(encodeInvestCalldata({ ...CALL, minAmountsOut: [1n] })).not.toBe(base);
    expect(encodeInvestCalldata({ ...CALL, policyNonce: 8n })).not.toBe(base);
    expect(encodeInvestCalldata({ ...CALL, adapterStatusEpoch: 43n })).not.toBe(base);
    expect(encodeInvestCalldata({ ...CALL, deadline: CALL.deadline + 1 })).not.toBe(base);
  });
});

describe("submitting", () => {
  it("plans without sending in dry-run mode", async () => {
    let sent = false;
    const result = await submitInvestment({
      live: false,
      chain: chainStub({
        sendRawTransaction: async () => {
          sent = true;
          return `0x${"00".repeat(32)}`;
        },
      }),
      vault: VAULT,
      from: signer.address,
      chainId: 4663,
      call: CALL,
      signer: null,
    });
    expect(result.kind).toBe("DRY_RUN");
    expect(sent).toBe(false);
    if (result.kind !== "DRY_RUN") return;
    // No nonce is reserved for a transaction that will not exist.
    expect(result.plan.nonce).toBeNull();
    expect(result.plan.to).toBe(VAULT);
    expect(result.plan.value).toBe(0n);
  });

  it("adds headroom over the estimate", async () => {
    const result = await submitInvestment({
      live: false,
      chain: chainStub({ estimateGas: async () => 100_000n }),
      vault: VAULT,
      from: signer.address,
      chainId: 4663,
      call: CALL,
      signer: null,
    });
    if (result.kind !== "DRY_RUN") throw new Error("expected a dry run");
    expect(result.plan.gasLimit).toBe(125_000n);
  });

  /**
   * ESTIMATION IS THE PRE-FLIGHT. It executes the call, so a replaced basket, a
   * deactivated adapter or an unreachable floor all surface here — for free, with
   * the vault's own revert reason — instead of costing gas on chain.
   */
  it("blocks, without spending anything, when the vault would revert", async () => {
    let sent = false;
    const result = await submitInvestment({
      live: true,
      chain: chainStub({
        estimateGas: async () => {
          throw new Error("execution reverted: InvestmentBasketMismatch()");
        },
        sendRawTransaction: async () => {
          sent = true;
          return `0x${"00".repeat(32)}`;
        },
      }),
      vault: VAULT,
      from: signer.address,
      chainId: 4663,
      call: CALL,
      signer,
    });
    expect(result.kind).toBe("BLOCKED");
    expect(sent).toBe(false);
    if (result.kind !== "BLOCKED") return;
    expect(result.reason).toBe("ESTIMATION_REVERTED");
    expect(result.detail).toContain("InvestmentBasketMismatch");
  });

  it("refuses live mode with no signer rather than sending unsigned", async () => {
    const result = await submitInvestment({
      live: true,
      chain: chainStub(),
      vault: VAULT,
      from: signer.address,
      chainId: 4663,
      call: CALL,
      signer: null,
    });
    expect(result.kind).toBe("BLOCKED");
    if (result.kind !== "BLOCKED") return;
    expect(result.reason).toBe("NO_SIGNER");
  });

  it("confirms a mined purchase and reports the gas it used", async () => {
    const result = await submitInvestment({
      live: true,
      chain: chainStub(),
      vault: VAULT,
      from: signer.address,
      chainId: 4663,
      call: CALL,
      signer,
    });
    expect(result.kind).toBe("CONFIRMED");
    if (result.kind !== "CONFIRMED") return;
    expect(result.gasUsed).toBe(331_000n);
    expect(result.plan.nonce).toBe(11);
  });

  it("reports a reverted purchase as failed rather than confirmed", async () => {
    const result = await submitInvestment({
      live: true,
      chain: chainStub({ waitForReceipt: async () => ({ status: "reverted", gasUsed: 21_000n }) }),
      vault: VAULT,
      from: signer.address,
      chainId: 4663,
      call: CALL,
      signer,
    });
    expect(result.kind).toBe("FAILED");
  });

  /**
   * NEVER RESENT. A purchase with no receipt may still be mined, and retrying
   * would buy twice from one decision — spending the rolling cap on something
   * nobody authorised at that size. Unresolved is the only safe report.
   */
  it("leaves a receiptless purchase unresolved instead of retrying", async () => {
    let sends = 0;
    const result = await submitInvestment({
      live: true,
      chain: chainStub({
        sendRawTransaction: async () => {
          sends += 1;
          return `0x${"ef".repeat(32)}`;
        },
        waitForReceipt: async () => null,
      }),
      vault: VAULT,
      from: signer.address,
      chainId: 4663,
      call: CALL,
      signer,
    });
    expect(result.kind).toBe("UNRESOLVED");
    expect(sends).toBe(1);
  });

  it("signs for the pending nonce, not the mined one", async () => {
    let signedNonce = -1;
    await submitInvestment({
      live: true,
      chain: chainStub({ getPendingTransactionCount: async () => 99 }),
      vault: VAULT,
      from: signer.address,
      chainId: 4663,
      call: CALL,
      signer: {
        ...signer,
        signTransaction: async (tx) => {
          signedNonce = tx.nonce;
          return `0x${"ab".repeat(100)}`;
        },
      },
    });
    expect(signedNonce).toBe(99);
  });
});

describe("who the call comes from", () => {
  /**
   * FOUND ON A MAINNET FORK, NOT IN A UNIT TEST. `from` used to default to the
   * vault when there was no signer, which reads as harmless and is not: the vault
   * is neither its own admin nor an ACTIVE trading account, so every estimate
   * reverted `Unauthorized()` (0x82b42900) and the tool blamed the plan. A dry run
   * whose sender is wrong measures nothing.
   */
  it("estimates from the address that would actually send", async () => {
    let seen = "";
    await submitInvestment({
      live: false,
      chain: chainStub({
        estimateGas: async (args) => {
          seen = args.from;
          return 300_000n;
        },
      }),
      vault: VAULT,
      from: signer.address,
      chainId: 4663,
      call: CALL,
      signer: null,
    });
    expect(seen).toBe(signer.address);
    expect(seen).not.toBe(VAULT);
  });
});

describe("describing a plan", () => {
  it("renders every bigint as a string so it can be logged as JSON", () => {
    const described = describeInvestPlan({
      from: signer.address,
      to: VAULT,
      value: 0n,
      data: "0x",
      chainId: 4663,
      gasLimit: 1n,
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 3n,
      estimatedGasCostWei: 4n,
      nonce: 5,
      call: CALL,
    });
    expect(() => JSON.stringify(described)).not.toThrow();
    expect(described.policyNonce).toBe("7");
    expect(described.adapterStatusEpoch).toBe("42");
  });
});
