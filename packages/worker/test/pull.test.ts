// Tests for the pull module: the Privy seat (privy.ts) and the broadcast
// ordering (submit.ts). No network: Privy is a fake `SeatApi`, the chain is a
// hand-built `RpcClient` that logs every call, and a throwaway viem account
// stands in for Privy's TEE so the raw bytes — and therefore the hash — are real.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, hexToBigInt, keccak256, toFunctionSelector, type AbiFunction } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import type { Address, Fill, Hex, Ledger, PullIntent, PullOutcome, RpcClient, SettlementAttestation, VolumeWindow } from "../src/types.js";
import { privySeatSigner, requireSignerId, seatOf, seatSignerOver, type PrivyWalletRecord, type SeatApi, type SeatSigner, type SeatTransaction } from "../src/pull/privy.js";
// The settle calldata and the executor ABI have ONE home (attest/phase0.ts and
// attest/snapshot.ts); submit.ts imports the encoder like everyone else, and so
// does this file, so the test cannot pass against a second copy.
import { encodeSettleCalldata } from "../src/attest/phase0.js";
import { EXECUTOR_ABI } from "../src/attest/snapshot.js";
import {
  FALLBACK_GAS_LIMIT,
  GAS_FLOOR_MULTIPLIER,
  PullBroadcastError,
  assertSignedMatches,
  estimatePullGas,
  feeQuote,
  gasFloorWei,
  pendingNonce,
  planPull,
  submitPull,
} from "../src/pull/submit.js";

// ── fixture and the §1 truth table ──────────────────────────────────────────

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/mainnet-4663.json", import.meta.url), "utf8")) as Record<string, unknown>;

const WALLET: Address = "0xc455bf7f16ebbc2b07cb26d1dd46194977974e7d";
const VAULT: Address = "0x1111111111111111111111111111111111111111";
const EXECUTOR: Address = "0xfa92abf15dfaf470cc8833cb01464bd6ca139e16";
const CHAIN_ID = 4663;

interface RecordedTx {
  readonly hash: Hex;
  readonly blockNumber: Hex;
  readonly transactionIndex: Hex;
  readonly value: Hex;
}

const recordedTx = (prefix: string): RecordedTx => {
  const key = Object.keys(FIXTURE).find((k) => k.startsWith(`eth_getTransactionByHash|["${prefix}`));
  if (key === undefined) throw new Error(`fixture has no transaction starting ${prefix}`);
  return FIXTURE[key] as RecordedTx;
};

/** DESIGN.md §1: the four GMGN fills of the fixture wallet, gross notional and fee to the wei. */
const TRUTH = [
  { prefix: "0x27259f99", side: "buy", notional: 20_000_000_000_000_000n, fee: 200_000_000_000_000n },
  { prefix: "0x5578486d", side: "buy", notional: 1_000_000_000_000_000n, fee: 10_000_000_000_000n },
  { prefix: "0x0688bd57", side: "sell", notional: 22_251_309_406_981_553n, fee: 222_513_094_069_815n },
  { prefix: "0x0e5cd4ab", side: "sell", notional: 906_846_740_302_383n, fee: 9_068_467_403_023n },
] as const;

const GMGN: Address = "0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc";
const TOKEN: Address = "0x2222222222222222222222222222222222222222";

const fixtureFills = (): readonly Fill[] =>
  TRUTH.map((truth) => {
    const tx = recordedTx(truth.prefix);
    return {
      wallet: WALLET,
      txHash: tx.hash,
      blockL2: hexToBigInt(tx.blockNumber),
      txIndex: Number(hexToBigInt(tx.transactionIndex)),
      side: truth.side,
      venue: "gmgn",
      tokenIn: truth.side === "buy" ? "native" : TOKEN,
      tokenOut: truth.side === "buy" ? TOKEN : "native",
      notionalWei: truth.notional,
      feeWei: truth.fee,
      source: "venue",
    };
  });

const SAVINGS_BPS = 20;
const BATCH_ROOT: Hex = `0x${"ab".repeat(32)}`;

const fixtureWindow = (): VolumeWindow => {
  const fills = fixtureFills();
  const sumNotionalWei = fills.reduce((acc, fill) => acc + fill.notionalWei, 0n);
  const blocks = fills.map((fill) => fill.blockL2);
  return {
    wallet: WALLET,
    vault: VAULT,
    startL2: blocks.reduce((a, b) => (a < b ? a : b)) - 10n,
    endL2: blocks.reduce((a, b) => (a > b ? a : b)) + 64n,
    fills,
    sumNotionalWei,
    savingsBps: SAVINGS_BPS,
    owedWei: (sumNotionalWei * BigInt(SAVINGS_BPS)) / 10_000n,
    batchRoot: BATCH_ROOT,
  };
};

const attestationFor = (window: VolumeWindow, contribution: bigint): SettlementAttestation => ({
  chainId: BigInt(CHAIN_ID),
  vault: window.vault,
  account: window.wallet,
  executor: EXECUTOR,
  bindingEpoch: 1n,
  policyNonce: 2n,
  settlementNonce: 3n,
  adminEpoch: 1n,
  localPauseEpoch: 0n,
  globalPauseEpoch: 0n,
  attesterEpoch: 1n,
  policyHash: `0x${"11".repeat(32)}`,
  sessionId: `0x${"22".repeat(32)}`,
  ledgerRoot: window.batchRoot,
  startBlock: 24_000_000n,
  endBlock: 24_000_010n,
  startBlockL2: window.startL2,
  endBlockL2: window.endL2,
  cashStart: 0n,
  cashEnd: window.sumNotionalWei,
  externalDeposits: 0n,
  externalWithdrawals: 0n,
  realizedProfit: window.sumNotionalWei,
  contribution,
  validAfter: 1_757_000_000n,
  deadline: 1_757_000_660n,
});

const SIGNATURE: Hex = `0x${"cd".repeat(65)}`;

// ── fakes that log into one shared event list ───────────────────────────────

interface RpcAnswers {
  readonly nonce?: Hex;
  readonly baseFeePerGas?: Hex | null;
  readonly priorityFee?: Hex | Error;
  readonly estimate?: Hex | Error;
  readonly send?: Error;
}

const GWEI_0_01: Hex = "0x989680"; // 10_000_000 wei: Robinhood Chain's usual base fee
const GWEI_0_1: Hex = "0x5f5e100"; // 100_000_000 wei
const ESTIMATE: Hex = "0x7e2d0"; // 516_816 gas: what a mainnet settle used

const loggingRpc = (events: string[], answers: RpcAnswers): RpcClient & { readonly calls: [string, unknown][] } => {
  const calls: [string, unknown][] = [];
  return {
    calls,
    async call<T>(method: string, params?: readonly unknown[]): Promise<T> {
      calls.push([method, params]);
      events.push(`rpc.${method}`);
      switch (method) {
        case "eth_getTransactionCount":
          return (answers.nonce ?? "0x2a") as T;
        case "eth_getBlockByNumber":
          return { baseFeePerGas: answers.baseFeePerGas === undefined ? GWEI_0_01 : answers.baseFeePerGas } as T;
        case "eth_maxPriorityFeePerGas": {
          const answer = answers.priorityFee ?? "0x0";
          if (answer instanceof Error) throw answer;
          return answer as T;
        }
        case "eth_estimateGas": {
          const answer = answers.estimate ?? ESTIMATE;
          if (answer instanceof Error) throw answer;
          return answer as T;
        }
        case "eth_sendRawTransaction": {
          if (answers.send) throw answers.send;
          const raw = (params?.[0] ?? "0x") as Hex;
          return keccak256(raw) as T;
        }
        default:
          throw new Error(`unexpected rpc method ${method}`);
      }
    },
  };
};

const throwingRpc: RpcClient = {
  async call(): Promise<never> {
    throw new Error("rpc must not be called");
  },
};

interface LedgerEvent {
  readonly windowId: number;
  readonly intent: PullIntent | null;
  readonly outcome: PullOutcome;
}

const loggingLedger = (events: string[]): Ledger & { readonly pulls: LedgerEvent[] } => {
  const pulls: LedgerEvent[] = [];
  const refuse = (name: string) => async (): Promise<never> => {
    throw new Error(`ledger.${name} must not be called by submitPull`);
  };
  return {
    pulls,
    async recordPull(windowId, intent, outcome) {
      events.push("ledger.recordPull");
      pulls.push({ windowId, intent, outcome });
    },
    upsertWallets: refuse("upsertWallets"),
    walletStates: refuse("walletStates"),
    recordFills: refuse("recordFills"),
    recordExclusions: refuse("recordExclusions"),
    recordRefusals: refuse("recordRefusals"),
    advanceCursor: refuse("advanceCursor"),
    unwindowedFills: refuse("unwindowedFills"),
    openWindow: refuse("openWindow"),
    markWindow: refuse("markWindow"),
    addOwed: refuse("addOwed"),
    addCollected: refuse("addCollected"),
    async windowsByStatus() { return []; },
    close: refuse("close"),
  };
};

const throwingLedger = (): Ledger => {
  const refuse = async (): Promise<never> => {
    throw new Error("ledger must not be called");
  };
  return {
    upsertWallets: refuse,
    walletStates: refuse,
    recordFills: refuse,
    recordExclusions: refuse,
    recordRefusals: refuse,
    advanceCursor: refuse,
    unwindowedFills: refuse,
    openWindow: refuse,
    markWindow: refuse,
    recordPull: refuse,
    addOwed: refuse,
    addCollected: refuse,
    async windowsByStatus() { return []; },
    close: refuse,
  };
};

const throwingSeat: SeatSigner = {
  async walletIdOf(): Promise<never> {
    throw new Error("seat.walletIdOf must not be called");
  },
  async signTransaction(): Promise<never> {
    throw new Error("seat.signTransaction must not be called");
  },
};

/** A seat backed by a throwaway local account: the signature is real, so keccak256(raw) is the real hash. */
const localSeat = (
  events: string[],
  options: { walletId?: string | null; mutate?: (tx: SeatTransaction) => SeatTransaction; signError?: Error } = {},
): SeatSigner & { readonly account: ReturnType<typeof privateKeyToAccount>; readonly signed: SeatTransaction[] } => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signed: SeatTransaction[] = [];
  return {
    account,
    signed,
    async walletIdOf() {
      events.push("seat.walletIdOf");
      return options.walletId === undefined ? "wallet-id-1" : options.walletId;
    },
    async signTransaction(_walletId, tx) {
      events.push("seat.signTransaction");
      if (options.signError) throw options.signError;
      const toSign = options.mutate ? options.mutate(tx) : tx;
      signed.push(toSign);
      return account.signTransaction({
        to: toSign.to,
        data: toSign.data,
        value: toSign.value,
        nonce: toSign.nonce,
        gas: toSign.gas,
        maxFeePerGas: toSign.maxFeePerGas,
        maxPriorityFeePerGas: toSign.maxPriorityFeePerGas,
        chainId: toSign.chainId,
        type: "eip1559",
      });
    },
  };
};

// ── privy.ts ────────────────────────────────────────────────────────────────

/** PRIVY_SIGNER_ID: the key quorum the website seats wallets with (WEB_WALLETS.md §1). */
const OURS = "quorum-app";

describe("seatOf — the pure seat decision", () => {
  const seated: PrivyWalletRecord = {
    id: "w1",
    address: "0xC455Bf7f16EBbC2B07Cb26D1dD46194977974E7d",
    chain_type: "ethereum",
    additional_signers: [{ signer_id: "quorum-app" }],
    archived_at: null,
  };

  it("returns the wallet id when OUR signer is present, matching the address case-insensitively", () => {
    expect(seatOf([seated], WALLET, OURS)).toBe("w1");
  });

  it("returns null when the user removed every signer (the seat is gone)", () => {
    expect(seatOf([{ ...seated, additional_signers: [] }], WALLET, OURS)).toBeNull();
    expect(seatOf([{ ...seated, additional_signers: null }], WALLET, OURS)).toBeNull();
    expect(seatOf([{ ...seated, additional_signers: undefined }], WALLET, OURS)).toBeNull();
  });

  it("returns null for an archived wallet, a different chain, or a different address", () => {
    expect(seatOf([{ ...seated, archived_at: 1_700_000_000_000 }], WALLET, OURS)).toBeNull();
    expect(seatOf([{ ...seated, chain_type: "solana" }], WALLET, OURS)).toBeNull();
    expect(seatOf([seated], VAULT, OURS)).toBeNull();
    expect(seatOf([], WALLET, OURS)).toBeNull();
  });

  it("a signer that is not ours is not a seat: another app on the same wallet does not answer for us", () => {
    const theirs: PrivyWalletRecord = { ...seated, additional_signers: [{ signer_id: "quorum-someone-else" }] };
    expect(seatOf([theirs], WALLET, OURS)).toBeNull();
    // A record whose signers carry no id at all is the same answer: not ours.
    expect(seatOf([{ ...seated, additional_signers: [{}] }], WALLET, OURS)).toBeNull();
    // And ours among several is still ours.
    const shared: PrivyWalletRecord = { ...seated, additional_signers: [{ signer_id: "quorum-someone-else" }, { signer_id: OURS }] };
    expect(seatOf([shared], WALLET, OURS)).toBe("w1");
  });

  it("picks the seated wallet when several records share the address", () => {
    const unseated: PrivyWalletRecord = { ...seated, id: "w0", additional_signers: [] };
    expect(seatOf([unseated, seated], WALLET, OURS)).toBe("w1");
  });
});

describe("seatSignerOver — the seat over a SeatApi", () => {
  const seatedRecord: PrivyWalletRecord = {
    id: "w1",
    address: WALLET,
    chain_type: "ethereum",
    additional_signers: [{ signer_id: "quorum-app" }],
  };

  it("reads the seat fresh on every call: a revocation between two calls is seen by the second", async () => {
    let records: readonly PrivyWalletRecord[] = [seatedRecord];
    let listCalls = 0;
    const api: SeatApi = {
      async walletsAt() {
        listCalls += 1;
        return records;
      },
      async signTransaction() {
        throw new Error("not used");
      },
    };
    const seat = seatSignerOver(api, { authorizationPrivateKey: "wallet-auth:k", signerId: OURS });

    expect(await seat.walletIdOf(WALLET)).toBe("w1");
    records = [{ ...seatedRecord, additional_signers: [] }];
    expect(await seat.walletIdOf(WALLET)).toBeNull();
    expect(listCalls).toBe(2);
  });

  it("passes the wallet id, the transaction and the authorization key through, and returns signed_transaction", async () => {
    const seen: unknown[] = [];
    const api: SeatApi = {
      async walletsAt() {
        return [];
      },
      async signTransaction(walletId, tx, key) {
        seen.push([walletId, tx, key]);
        return { encoding: "rlp", signed_transaction: "0x02f8" };
      },
    };
    const seat = seatSignerOver(api, { authorizationPrivateKey: "wallet-auth:k", signerId: "quorum-app" });
    const tx: SeatTransaction = { to: EXECUTOR, data: "0x", value: 1n, nonce: 0, gas: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, chainId: CHAIN_ID };
    expect(await seat.signTransaction("w1", tx)).toBe("0x02f8");
    expect(seen).toEqual([["w1", tx, "wallet-auth:k"]]);
  });

  it("refuses a response with no usable signed_transaction: a shape change is not a signature", async () => {
    const answers: unknown[] = [{}, { signed_transaction: "abc" }, null, { signed_transaction: 7 }];
    const api: SeatApi = {
      async walletsAt() {
        return [];
      },
      async signTransaction() {
        return answers.shift();
      },
    };
    const seat = seatSignerOver(api, { authorizationPrivateKey: "wallet-auth:k", signerId: OURS });
    const tx: SeatTransaction = { to: EXECUTOR, data: "0x", value: 0n, nonce: 0, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, chainId: CHAIN_ID };
    for (let i = 0; i < 4; i += 1) {
      await expect(seat.signTransaction("w1", tx)).rejects.toThrow(/no `signed_transaction`/);
    }
  });
});

describe("privySeatSigner — the real SDK adapter", () => {
  it("constructs without touching the network and exposes both seat methods", () => {
    const seat = privySeatSigner({ appId: "app", appSecret: "secret", authorizationPrivateKey: "wallet-auth:k", signerId: OURS });
    expect(typeof seat.walletIdOf).toBe("function");
    expect(typeof seat.signTransaction).toBe("function");
  });

  it("refuses to exist without PRIVY_SIGNER_ID: a seat it cannot identify is one it must not claim", () => {
    const base = { appId: "app", appSecret: "secret", authorizationPrivateKey: "wallet-auth:k" };
    expect(() => privySeatSigner(base)).toThrow(/PRIVY_SIGNER_ID/);
    expect(() => privySeatSigner({ ...base, signerId: "   " })).toThrow(/PRIVY_SIGNER_ID/);
    const api: SeatApi = {
      async walletsAt() {
        throw new Error("the seat was built");
      },
      async signTransaction() {
        throw new Error("the seat was built");
      },
    };
    expect(() => seatSignerOver(api, { authorizationPrivateKey: "wallet-auth:k" })).toThrow(/PRIVY_SIGNER_ID/);
    expect(requireSignerId(" quorum-app ")).toBe("quorum-app");
  });
});

// ── submit.ts: calldata, fees, estimate, floor ──────────────────────────────

describe("the settle calldata — one encoder, shared with attest/phase0", () => {
  const window = fixtureWindow();
  const attestation = attestationFor(window, window.owedWei);

  it("targets SettlementExecutor.settle(attestation, attesterSignature) from @nuvem/contracts-artifacts", () => {
    const settle = EXECUTOR_ABI.find((item): item is AbiFunction => item.type === "function" && item.name === "settle");
    expect(settle).toBeDefined();
    if (!settle) return;
    const data = encodeSettleCalldata(attestation, SIGNATURE);
    expect(data.slice(0, 10)).toBe(toFunctionSelector(settle));
  });

  it("round-trips: decoding the calldata yields the same 26 fields and the signature", () => {
    const data = encodeSettleCalldata(attestation, SIGNATURE);
    const decoded = decodeFunctionData({ abi: EXECUTOR_ABI, data });
    expect(decoded.functionName).toBe("settle");
    const [tuple, sig] = decoded.args as [Record<string, unknown>, Hex];
    expect(sig).toBe(SIGNATURE);
    for (const [name, value] of Object.entries(attestation)) {
      // viem hands back uint32/uint48 (attesterEpoch, validAfter, deadline) as number; widen before comparing.
      const raw = tuple[name];
      const got = typeof raw === "number" ? BigInt(raw) : typeof raw === "string" ? raw.toLowerCase() : raw;
      expect(got, name).toEqual(typeof value === "string" ? value.toLowerCase() : value);
    }
  });
});

describe("pendingNonce / feeQuote / estimatePullGas / gasFloorWei", () => {
  it("reserves the PENDING nonce, decoded from hex", async () => {
    const events: string[] = [];
    const rpc = loggingRpc(events, { nonce: "0x4a" });
    expect(await pendingNonce(rpc, WALLET)).toBe(74);
    expect(rpc.calls).toEqual([["eth_getTransactionCount", [WALLET, "pending"]]]);
  });

  it("prices maxFee = baseFee × 1.2 + priority from the latest block and the node's hint", async () => {
    const rpc = loggingRpc([], { baseFeePerGas: GWEI_0_1, priorityFee: "0x1" });
    expect(await feeQuote(rpc)).toEqual({ maxFeePerGas: 120_000_001n, maxPriorityFeePerGas: 1n });
    expect(rpc.calls[0]).toEqual(["eth_getBlockByNumber", ["latest", false]]);
  });

  it("falls back to a zero tip when the node has no eth_maxPriorityFeePerGas", async () => {
    const rpc = loggingRpc([], { baseFeePerGas: GWEI_0_1, priorityFee: new Error("method not found") });
    expect(await feeQuote(rpc)).toEqual({ maxFeePerGas: 120_000_000n, maxPriorityFeePerGas: 0n });
  });

  it("refuses to price a pull when the block carries no baseFeePerGas", async () => {
    const rpc = loggingRpc([], { baseFeePerGas: null });
    await expect(feeQuote(rpc)).rejects.toThrow(/baseFeePerGas/);
  });

  it("returns the estimate, or null when the node says the settle would revert", async () => {
    const call = { from: WALLET, to: EXECUTOR, value: 1n, data: "0x" as Hex };
    expect(await estimatePullGas(loggingRpc([], {}), call)).toBe(516_816n);
    expect(await estimatePullGas(loggingRpc([], { estimate: new Error("execution reverted: InvalidContribution") }), call)).toBeNull();
  });

  it("gas floor = GAS_FLOOR_MULTIPLIER × gasLimit × maxFeePerGas", () => {
    expect(GAS_FLOOR_MULTIPLIER).toBe(2n);
    expect(gasFloorWei(620_179n, 12_000_000n)).toBe(14_884_296_000_000n);
  });

  it("planPull pads the estimate by 1.2 and uses the fallback limit when the estimate reverts", async () => {
    const window = fixtureWindow();
    const attestation = attestationFor(window, window.owedWei);
    const ok = await planPull(loggingRpc([], {}), { from: WALLET, executor: EXECUTOR, attestation, signature: SIGNATURE, nonce: 7 });
    expect(ok.estimatedGas).toBe(516_816n);
    expect(ok.tx.gas).toBe(620_179n);
    expect(ok.tx).toMatchObject({ to: EXECUTOR, value: window.owedWei, nonce: 7, chainId: CHAIN_ID, maxFeePerGas: 12_000_000n, maxPriorityFeePerGas: 0n });
    expect(ok.tx.data).toBe(encodeSettleCalldata(attestation, SIGNATURE));

    const reverted = await planPull(loggingRpc([], { estimate: new Error("reverted") }), { from: WALLET, executor: EXECUTOR, attestation, signature: SIGNATURE, nonce: 7 });
    expect(reverted.estimatedGas).toBeNull();
    expect(reverted.tx.gas).toBe(FALLBACK_GAS_LIMIT);
    expect(reverted.gasFloorWei).toBe(gasFloorWei(FALLBACK_GAS_LIMIT, 12_000_000n));
  });
});

describe("assertSignedMatches — the raw bytes must be the transaction that was asked for", () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const wanted: SeatTransaction = { to: EXECUTOR, data: "0x1234", value: 5n, nonce: 3, gas: 100_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, chainId: CHAIN_ID };
  const sign = (tx: SeatTransaction) => account.signTransaction({ ...tx, type: "eip1559" });

  it("accepts a faithful signature", async () => {
    expect(() => assertSignedMatches(undefined as unknown as Hex, wanted)).toThrow();
    const raw = await sign(wanted);
    expect(() => assertSignedMatches(raw, wanted)).not.toThrow();
  });

  it("rejects a signature over a different to, value, calldata, nonce, chain or gas", async () => {
    const variants: Partial<SeatTransaction>[] = [
      { to: VAULT },
      { value: 6n },
      { data: "0x5678" },
      { nonce: 4 },
      { chainId: 1 },
      { gas: 99_999n },
    ];
    for (const variant of variants) {
      const raw = await sign({ ...wanted, ...variant });
      expect(() => assertSignedMatches(raw, wanted), JSON.stringify(variant, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).toThrow(/nothing was broadcast/);
    }
  });
});

// ── submit.ts: submitPull ───────────────────────────────────────────────────

describe("submitPull — dry run", () => {
  it("returns DRY_RUN as its first act: the seat, the rpc and the ledger are never touched", async () => {
    const window = fixtureWindow();
    const attestation = attestationFor(window, window.owedWei);
    const outcome = await submitPull(throwingRpc, "dry-run", EXECUTOR, window, attestation, SIGNATURE, window.owedWei, throwingSeat, throwingLedger(), 1);
    expect(outcome.kind).toBe("DRY_RUN");
    if (outcome.kind !== "DRY_RUN") return;
    expect(outcome.intent).toEqual({ window, attestation, signature: SIGNATURE, contributionWei: window.owedWei });
    expect(Object.keys(outcome.intent).sort()).toEqual(["attestation", "contributionWei", "signature", "window"]);
  });

  it("stays a dry run with a null seat too (no key is even needed)", async () => {
    const window = fixtureWindow();
    const outcome = await submitPull(throwingRpc, "dry-run", EXECUTOR, window, attestationFor(window, 1n), SIGNATURE, 1n, null, throwingLedger(), 1);
    expect(outcome.kind).toBe("DRY_RUN");
  });
});

describe("submitPull — live", () => {
  it("the window is the §1 truth table: four GMGN fills, Σ gross notional, owed at 20 bps", () => {
    const window = fixtureWindow();
    expect(window.fills).toHaveLength(4);
    expect(window.sumNotionalWei).toBe(44_158_156_147_283_936n);
    expect(window.owedWei).toBe(88_316_312_294_567n);
    // The two buys' notional is tx.value, straight from the recorded transaction.
    for (const truth of TRUTH.filter((t) => t.side === "buy")) {
      expect(hexToBigInt(recordedTx(truth.prefix).value)).toBe(truth.notional);
    }
  });

  it("SKIPPED SIGNER_UNAVAILABLE when live mode has no seat; nothing else is called", async () => {
    const window = fixtureWindow();
    const outcome = await submitPull(throwingRpc, "live", EXECUTOR, window, attestationFor(window, window.owedWei), SIGNATURE, window.owedWei, null, throwingLedger(), 1);
    expect(outcome).toMatchObject({ kind: "SKIPPED", reason: "SIGNER_UNAVAILABLE" });
  });

  it("SKIPPED SEAT_REVOKED when walletIdOf returns null: no nonce is reserved, nothing is signed or recorded", async () => {
    const events: string[] = [];
    const window = fixtureWindow();
    const rpc = loggingRpc(events, {});
    const seat = localSeat(events, { walletId: null });
    const ledger = loggingLedger(events);
    const outcome = await submitPull(rpc, "live", EXECUTOR, window, attestationFor(window, window.owedWei), SIGNATURE, window.owedWei, seat, ledger, 1);
    expect(outcome).toMatchObject({ kind: "SKIPPED", reason: "SEAT_REVOKED" });
    expect(events).toEqual(["seat.walletIdOf"]);
    expect(ledger.pulls).toEqual([]);
  });

  it("refuses an attestation whose account or contribution disagrees with the window, before anything is called", async () => {
    const window = fixtureWindow();
    const good = attestationFor(window, window.owedWei);
    await expect(
      submitPull(throwingRpc, "live", EXECUTOR, window, { ...good, account: VAULT }, SIGNATURE, window.owedWei, throwingSeat, throwingLedger(), 1),
    ).rejects.toThrow(/not the window's wallet/);
    await expect(
      submitPull(throwingRpc, "live", EXECUTOR, window, good, SIGNATURE, window.owedWei - 1n, throwingSeat, throwingLedger(), 1),
    ).rejects.toThrow(/contributionWei/);
  });

  it("SKIPPED BELOW_GAS_FLOOR when the contribution would not cover 2× the gas: the fixture window at 0.1 gwei", async () => {
    const events: string[] = [];
    const window = fixtureWindow();
    const attestation = attestationFor(window, window.owedWei);
    const rpc = loggingRpc(events, { baseFeePerGas: GWEI_0_1 });
    const seat = localSeat(events);
    const ledger = loggingLedger(events);
    const outcome = await submitPull(rpc, "live", EXECUTOR, window, attestation, SIGNATURE, window.owedWei, seat, ledger, 1);
    expect(outcome).toMatchObject({ kind: "SKIPPED", reason: "BELOW_GAS_FLOOR" });
    if (outcome.kind !== "SKIPPED") return;
    // 2 × 620_179 gas × 120_000_000 wei = 1.488e14 > owed 8.83e13
    expect(outcome.detail).toContain(`floor ${gasFloorWei(620_179n, 120_000_000n)}`);
    expect(events).toEqual(["seat.walletIdOf", "rpc.eth_getTransactionCount", "rpc.eth_getBlockByNumber", "rpc.eth_maxPriorityFeePerGas", "rpc.eth_estimateGas"]);
    expect(seat.signed).toEqual([]);
    expect(ledger.pulls).toEqual([]);
  });

  it("happy path: reserve nonce → estimate → sign → record INTENT → send; the hash is keccak256(raw) known before the send", async () => {
    const events: string[] = [];
    const window = fixtureWindow();
    const attestation = attestationFor(window, window.owedWei);
    const rpc = loggingRpc(events, { nonce: "0x2a" });
    const seat = localSeat(events);
    const ledger = loggingLedger(events);

    const outcome = await submitPull(rpc, "live", EXECUTOR, window, attestation, SIGNATURE, window.owedWei, seat, ledger, 42);

    expect(events).toEqual([
      "seat.walletIdOf",
      "rpc.eth_getTransactionCount",
      "rpc.eth_getBlockByNumber",
      "rpc.eth_maxPriorityFeePerGas",
      "rpc.eth_estimateGas",
      "seat.signTransaction",
      "ledger.recordPull",
      "rpc.eth_sendRawTransaction",
    ]);
    expect(events.indexOf("ledger.recordPull")).toBeLessThan(events.indexOf("rpc.eth_sendRawTransaction"));

    expect(outcome.kind).toBe("SENT");
    if (outcome.kind !== "SENT") return;
    const intent = outcome.intent;
    expect(intent.nonce).toBe(42);
    expect(intent.txHash).toBe(keccak256(intent.rawTx));
    expect(intent.window).toBe(window);
    expect(intent.attestation).toBe(attestation);
    expect(intent.signature).toBe(SIGNATURE);
    expect(intent.contributionWei).toBe(window.owedWei);

    // What was signed is exactly the plan: executor, contribution as value, settle calldata, pending nonce, chain 4663.
    expect(seat.signed).toHaveLength(1);
    expect(seat.signed[0]).toMatchObject({
      to: EXECUTOR,
      value: window.owedWei,
      data: encodeSettleCalldata(attestation, SIGNATURE),
      nonce: 42,
      gas: 620_179n,
      maxFeePerGas: 12_000_000n,
      maxPriorityFeePerGas: 0n,
      chainId: CHAIN_ID,
    });
    // eth_estimateGas ran the settle from the wallet with the contribution attached.
    const estimateCall = rpc.calls.find(([method]) => method === "eth_estimateGas");
    expect(estimateCall?.[1]).toEqual([{ from: WALLET, to: EXECUTOR, value: `0x${window.owedWei.toString(16)}`, data: encodeSettleCalldata(attestation, SIGNATURE) }]);

    // The INTENT record carries the same nonce and hash, under the window id, before the raw bytes went out.
    expect(ledger.pulls).toHaveLength(1);
    expect(ledger.pulls[0]).toEqual({ windowId: 42, intent, outcome: { kind: "SENT", intent } });
    const sendCall = rpc.calls.find(([method]) => method === "eth_sendRawTransaction");
    expect(sendCall?.[1]).toEqual([intent.rawTx]);
  });

  it("uses the fallback gas limit when the estimate reverts, and still sends when the floor is covered", async () => {
    const events: string[] = [];
    const window = fixtureWindow();
    const attestation = attestationFor(window, window.owedWei);
    const rpc = loggingRpc(events, { estimate: new Error("execution reverted") });
    const seat = localSeat(events);
    const outcome = await submitPull(rpc, "live", EXECUTOR, window, attestation, SIGNATURE, window.owedWei, seat, loggingLedger(events), 1);
    expect(outcome.kind).toBe("SENT");
    expect(seat.signed[0]?.gas).toBe(FALLBACK_GAS_LIMIT);
  });

  it("SKIPPED SIGNER_UNAVAILABLE when the seat refuses to sign; nothing recorded, nothing sent, no 64-hex in the detail", async () => {
    const events: string[] = [];
    const window = fixtureWindow();
    const attestation = attestationFor(window, window.owedWei);
    const leaked = `0x${"ef".repeat(32)}`;
    const rpc = loggingRpc(events, {});
    const seat = localSeat(events, { signError: new Error(`policy denied; key ${leaked}`) });
    const ledger = loggingLedger(events);
    const outcome = await submitPull(rpc, "live", EXECUTOR, window, attestation, SIGNATURE, window.owedWei, seat, ledger, 1);
    expect(outcome).toMatchObject({ kind: "SKIPPED", reason: "SIGNER_UNAVAILABLE" });
    if (outcome.kind !== "SKIPPED") return;
    expect(outcome.detail).toContain("policy denied");
    expect(outcome.detail).not.toContain(leaked);
    expect(outcome.detail).not.toContain("ef".repeat(32));
    expect(ledger.pulls).toEqual([]);
    expect(events).not.toContain("rpc.eth_sendRawTransaction");
  });

  it("throws before recording or sending when the seat signs a different transaction than requested", async () => {
    const events: string[] = [];
    const window = fixtureWindow();
    const attestation = attestationFor(window, window.owedWei);
    const rpc = loggingRpc(events, {});
    const seat = localSeat(events, { mutate: (tx) => ({ ...tx, to: VAULT }) });
    const ledger = loggingLedger(events);
    await expect(submitPull(rpc, "live", EXECUTOR, window, attestation, SIGNATURE, window.owedWei, seat, ledger, 1)).rejects.toThrow(/nothing was broadcast/);
    expect(ledger.pulls).toEqual([]);
    expect(events).not.toContain("ledger.recordPull");
    expect(events).not.toContain("rpc.eth_sendRawTransaction");
  });

  it("a failed send AFTER the intent is recorded surfaces as PullBroadcastError carrying the intent — never as 'not sent'", async () => {
    const events: string[] = [];
    const window = fixtureWindow();
    const attestation = attestationFor(window, window.owedWei);
    const rpc = loggingRpc(events, { send: new Error("timeout") });
    const seat = localSeat(events);
    const ledger = loggingLedger(events);
    let caught: unknown;
    try {
      await submitPull(rpc, "live", EXECUTOR, window, attestation, SIGNATURE, window.owedWei, seat, ledger, 9);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PullBroadcastError);
    if (!(caught instanceof PullBroadcastError)) return;
    expect(caught.message).toContain("after the intent was recorded");
    expect(ledger.pulls).toHaveLength(1);
    expect(ledger.pulls[0]?.intent).toEqual(caught.intent);
    expect(events.slice(-2)).toEqual(["ledger.recordPull", "rpc.eth_sendRawTransaction"]);
  });
});
