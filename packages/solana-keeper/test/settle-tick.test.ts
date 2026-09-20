// One settle turn over a stub chain, live and dry: the reserve checked against the
// node's own fee before anything is signed, a refusal classified by the program's
// name, a settle that landed never reported FAILED, and a loss carried past a
// backlog's zero settle: recorded before the send, netted by the window above, and
// never left under a state another window's settle leaves.
//
// The chain is a Proxy Connection like accounts.test.ts's: it serves only the
// methods a test gives it, throws on any other, and records every call. The
// Program is a real anchor.Program over it, so the settle_v2 instruction is the
// IDL's own; the wallet signs with a Keypair.generate(), as on localnet, and the
// Privy route is a submitter that throws what a test tells it to, or records what
// it is handed. No network, and no real key.

import { createHash } from "node:crypto";
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Ed25519Program,
  Keypair,
  MessageV1,
  PublicKey,
  SendTransactionError,
  SolanaJSONRPCError,
  SolanaJSONRPCErrorCode,
  VersionedTransaction,
  type Finality,
  type Message,
  type Transaction,
  type TransactionError,
} from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VaultState } from "../src/accounts.js";
import type { ManagedLink } from "../src/discovery.js";
import { accountDiscriminator, idl } from "../src/idl.js";
import { assertSettleShape, type SolanaWalletSubmitter } from "../src/privy-signer.js";
import { MAX_SUPPORTED_TRANSACTION_VERSION } from "../src/measure-window.js";
import { attestationMessage } from "../src/program-scripts.js";
import { attestationInputs, type CarryBook, type LossCarry } from "../src/settle-decision.js";
import { CONFIRM_POLL_MS, CONFIRM_TIMEOUT_MS, runSettleTick, type SettleDeps, type SettleResult } from "../src/settle-tick.js";
import { FakeLedger, chained } from "./fake-ledger.js";

const programId = new PublicKey(idl.address);
const EPOCH = 300_000_000;
const SYSTEM = "11111111111111111111111111111111";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const BLOCKHASH = Keypair.generate().publicKey.toBase58();
const SIGNATURE = "settle-signature";

const wallet = Keypair.generate();
const attester = Keypair.generate();
const link: ManagedLink = {
  linkAddress: PublicKey.findProgramAddressSync([Buffer.from("link"), wallet.publicKey.toBuffer()], programId)[0],
  wallet: wallet.publicKey,
  vault: Keypair.generate().publicKey,
  epoch: BigInt(EPOCH),
  settlementNonce: 4n,
  frontierSlot: 0n,
};
const vault: VaultState = {
  owner: Keypair.generate().publicKey,
  paused: false,
  skimMode: 0,
  skimBps: 2_000,
  volumeBps: 200,
  policyNonce: 1n,
  maxContribution: 10_000_000_000n,
  walletReserve: 50_000_000n,
};

// One trade of 1 SOL above the link's own transaction: 200 000 000 lamports at 2 000 bps.
const PAID = 200_000_000;
const FEE = 10_000;
const RENT0 = 890_880;
/** Exactly what this settle needs: the fee, the payment, the rent floor and the reserve. */
const EXACT = FEE + PAID + RENT0 + Number(vault.walletReserve);

/** state.rs TradingLink: 129 bytes, with the nonce the chain holds after the turn. */
function linkBytes(settlementNonce: bigint): Buffer {
  const buf = Buffer.alloc(129);
  accountDiscriminator("TradingLink").copy(buf, 0);
  link.wallet.toBuffer().copy(buf, 8);
  link.vault.toBuffer().copy(buf, 40);
  buf.writeBigUInt64LE(link.epoch, 72);
  buf.writeBigUInt64LE(settlementNonce, 80);
  buf.writeBigUInt64LE(settlementNonce === link.settlementNonce ? link.frontierSlot : BigInt(EPOCH + 5), 88);
  buf.writeUInt8(254, 96);
  return buf;
}

type Handler = (...args: unknown[]) => unknown;

const confirmed = (err: TransactionError | null = null) => async () => ({
  context: { slot: EPOCH + 150 },
  value: [{ slot: EPOCH + 150, confirmations: 1, err, confirmationStatus: "confirmed" }],
});

function chain(extra: Readonly<Record<string, Handler>> = {}) {
  const calls: string[] = [];
  const callArgs: unknown[][] = [];
  const sent: VersionedTransaction[] = [];
  const ledger = new FakeLedger(
    link.wallet,
    chained(2_000_000_000, [
      { signature: "link-0", slot: EPOCH, programs: [SYSTEM], delta: -2_000_000 },
      { signature: "trade-5", slot: EPOCH + 5, programs: [JUPITER], delta: 1_000_000_000 },
    ]),
  );
  /** The receipt of the last transaction sent, moving the vault by `vaultDelta`. */
  const receipt = (vaultDelta: number) => {
    const tx = sent.at(-1)!;
    const keys = tx.message.staticAccountKeys;
    const pre = keys.map(() => 1_000_000_000);
    const post = keys.map((key, i) => (key.equals(link.vault) ? pre[i]! + vaultDelta : pre[i]!));
    return {
      slot: EPOCH + 150,
      blockTime: null,
      transaction: { message: tx.message, signatures: [SIGNATURE] },
      meta: { err: null, fee: FEE, preBalances: pre, postBalances: post, innerInstructions: [], loadedAddresses: { writable: [], readonly: [] }, logMessages: [] },
    };
  };
  const served: Record<string, Handler> = {
    getSignaturesForAddress: async (address, options, commitment) =>
      commitment === "confirmed"
        ? [{ signature: "trade-5", slot: EPOCH + 5, err: null, memo: null }]
        : ledger.signatures(address as PublicKey, options as { limit: number }, commitment as Finality),
    getTransaction: async (signature, config) => {
      const commitment = (config as { commitment: Finality }).commitment;
      return commitment === "finalized" ? ledger.transaction(signature as string, commitment) : receipt(PAID);
    },
    getSlot: async (commitment) => (commitment === "finalized" ? EPOCH + 100 : EPOCH + 140),
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 }),
    getFeeForMessage: async () => ({ context: { slot: EPOCH + 140 }, value: FEE }),
    getBalance: async () => EXACT,
    getMinimumBalanceForRentExemption: async () => RENT0,
    sendRawTransaction: async (bytes) => {
      sent.push(VersionedTransaction.deserialize(bytes as Uint8Array));
      return SIGNATURE;
    },
    getSignatureStatuses: confirmed(),
    getAccountInfoAndContext: async () => ({ context: { slot: 1 }, value: null }),
    ...extra,
  };
  const connection = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        return (...args: unknown[]) => {
          calls.push(prop);
          callArgs.push(args);
          const handler = served[prop];
          if (handler === undefined) throw new Error(`unexpected RPC call: ${prop}`);
          return handler(...args);
        };
      },
    },
  ) as unknown as Connection;
  const refuse = async (): Promise<never> => {
    throw new Error("the stub chain signs nothing");
  };
  const program = new anchor.Program(
    idl,
    new anchor.AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse }, { commitment: "confirmed" }),
  );
  const deps = (over: Partial<SettleDeps> = {}): SettleDeps => ({
    connection,
    program,
    link,
    vault,
    attester,
    walletSigner: wallet,
    live: true,
    protocolPaused: false,
    carries: new Map(),
    ...over,
  });
  return { connection, program, calls, callArgs, sent, deps, receipt };
}

/** The link as the chain holds it after the turn: `nonce`. */
const linkRead = (nonce: bigint): Handler => async (address) => ({
  context: { slot: 1 },
  value: (address as PublicKey).equals(link.linkAddress)
    ? { data: linkBytes(nonce), executable: false, lamports: 1_000_000, owner: programId, rentEpoch: 0 }
    : null,
});

/** A Privy route whose submit throws `error`. */
const throwingSubmitter = (error: unknown): SolanaWalletSubmitter => ({
  address: link.wallet,
  submit: async () => {
    throw error;
  },
});

/**
 * Runs a turn under fake timers: before each poll interval passes, every pending
 * promise is let settle, so the turn's own awaits run as they would and only its
 * waits between status polls are skipped.
 */
async function underFakeTimers(turn: () => Promise<SettleResult>): Promise<SettleResult> {
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  try {
    let result: SettleResult | undefined;
    const pending = turn().then((answer) => {
      result = answer;
    });
    for (let tick = 0; result === undefined && tick < 1_000; tick++) {
      await new Promise((resolve) => setImmediate(resolve));
      vi.advanceTimersByTime(CONFIRM_POLL_MS);
    }
    await pending;
    return result!;
  } finally {
    vi.useRealTimers();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the wallet reserve, before anything is signed", () => {
  it("rests one lamport short at BELOW_RESERVE, in a dry run and live, having signed and sent nothing", async () => {
    for (const live of [false, true]) {
      const c = chain({ getBalance: async () => EXACT - 1 });
      const result = await runSettleTick(c.deps(live ? {} : { live: false, attester: null, walletSigner: null }));
      expect(result, `live ${live}`).toMatchObject({ outcome: "BELOW_RESERVE", baseLamports: 1_000_000_000n, feeLamports: BigInt(FEE), expectedLamports: BigInt(PAID) });
      expect(result.detail).toContain("1 lamports short");
      expect(result.detail).toContain("WalletBelowReserve");
      expect(c.calls).not.toContain("sendRawTransaction");
      expect(c.calls.slice(-4)).toEqual(["getLatestBlockhash", "getFeeForMessage", "getBalance", "getMinimumBalanceForRentExemption"]);
    }
  });

  it("rests a backlog's positive prefix the wallet cannot pay at BELOW_RESERVE, never settling past it with a zero base, and reads nothing above the prefix", async () => {
    // 301 winning trades above the link: the oldest 300 are the window, 300 000 000
    // lamports of profit, 60 000 000 paid at 2 000 bps. One lamport short of that
    // payment is still far more than a zero settle needs, so a turn that fell back
    // to a zero base here would settle past a profit it never charged.
    const backlog = new FakeLedger(
      link.wallet,
      chained(2_000_000_000, [
        { signature: "link-0", slot: EPOCH, programs: [SYSTEM], delta: -2_000_000 },
        ...Array.from({ length: 301 }, (_, i) => ({ signature: `trade-${i + 1}`, slot: EPOCH + 1 + i, programs: [JUPITER], delta: 1_000_000 })),
      ]),
    );
    const needed = FEE + 60_000_000 + RENT0 + Number(vault.walletReserve);
    for (const [live, balance, outcome] of [
      [false, needed - 1, "BELOW_RESERVE"],
      [true, needed - 1, "BELOW_RESERVE"],
      [false, needed, "SETTLED"],
    ] as const) {
      const c = chain({
        getSignaturesForAddress: async (address, options, commitment) =>
          commitment === "confirmed"
            ? [{ signature: "trade-301", slot: EPOCH + 301, err: null, memo: null }]
            : backlog.signatures(address as PublicKey, options as { limit: number }, commitment as Finality),
        getTransaction: async (signature, config) => backlog.transaction(signature as string, (config as { commitment: Finality }).commitment),
        getSlot: async (commitment) => (commitment === "finalized" ? EPOCH + 400 : EPOCH + 440),
        getBalance: async () => balance,
      });
      const result = await runSettleTick(c.deps(live ? {} : { live: false, attester: null, walletSigner: null }));
      const named = `live ${live}, balance ${balance}`;
      expect(result, named).toMatchObject({ outcome, baseLamports: 300_000_000n, expectedLamports: 60_000_000n });
      expect(c.calls, named).not.toContain("sendRawTransaction");
      const read = c.calls.flatMap((name, i) => (name === "getTransaction" ? [c.callArgs[i]![0]] : []));
      expect(read, "the anchor and the 300 oldest trades, and nothing above them").toHaveLength(301);
      expect(read).not.toContain("trade-301");
      if (outcome === "BELOW_RESERVE") {
        expect(result.detail).toContain("1 lamports short");
        expect(result.detail).toContain("WalletBelowReserve");
      } else {
        expect(result.detail).toContain("DRY RUN — would settle 60000000 lamports");
        expect(result.detail).toContain(
          `over slots ${EPOCH}..${EPOCH + 300}; backlog: settling the oldest 300 of 301 signatures above slot ${EPOCH}, ` +
            `up to slot ${EPOCH + 300}; the rest continues next sweep`,
        );
      }
    }
  });

  it("prices the fee on the settle's own message, with the attester's key in the Ed25519 instruction when live", async () => {
    for (const live of [false, true]) {
      const c = chain({ getBalance: async () => EXACT - 1 });
      await runSettleTick(c.deps(live ? {} : { live: false, attester: null, walletSigner: null }));
      const [message, commitment] = c.callArgs[c.calls.indexOf("getFeeForMessage")] as [Message, string];
      expect(commitment).toBe("confirmed");
      expect(message.recentBlockhash).toBe(BLOCKHASH);
      expect(message.header.numRequiredSignatures).toBe(1);
      expect(message.staticAccountKeys[0]!.equals(link.wallet), "the wallet pays").toBe(true);
      const [verify, settle] = message.compiledInstructions;
      expect(message.staticAccountKeys[verify!.programIdIndex]!.equals(Ed25519Program.programId)).toBe(true);
      expect(message.staticAccountKeys[settle!.programIdIndex]!.equals(programId)).toBe(true);
      // 16-byte offsets, 32-byte key, 64-byte signature, 171-byte attestation.
      expect(verify!.data.length).toBe(283);
      const key = Buffer.from(verify!.data.subarray(16, 48));
      expect(key.equals(live ? attester.publicKey.toBuffer() : Buffer.alloc(32))).toBe(true);
    }
  });

  it("asks for rent_exempt(0) once per connection", async () => {
    const c = chain({ getBalance: async () => EXACT - 1 });
    await runSettleTick(c.deps());
    await runSettleTick(c.deps());
    expect(c.calls.filter((name) => name === "getMinimumBalanceForRentExemption")).toHaveLength(1);
  });

  it("is RETRY when the node cannot price the fee, before any balance read or signature", async () => {
    const c = chain({ getFeeForMessage: async () => ({ context: { slot: 1 }, value: null }) });
    const result = await runSettleTick(c.deps());
    expect(result.outcome).toBe("RETRY");
    expect(c.calls).not.toContain("getBalance");
    expect(c.calls).not.toContain("sendRawTransaction");
  });
});

describe("a live settle", () => {
  it("at the exact boundary is sent once, with the blockhash its fee was priced at, and reports what the vault received against what settle_v2 computes", async () => {
    const c = chain();
    const result = await runSettleTick(c.deps());
    expect(result).toMatchObject({
      outcome: "SETTLED",
      settledLamports: BigInt(PAID),
      expectedLamports: BigInt(PAID),
      feeLamports: BigInt(FEE),
      signature: SIGNATURE,
      nonce: 4n,
      endSlot: BigInt(EPOCH + 5),
    });
    expect(result.detail).toBe(`settled ${PAID} lamports from 1000000000 measured over 1 txs (${PAID} expected at 2000 bps)`);
    expect(c.calls.filter((name) => name === "sendRawTransaction")).toHaveLength(1);
    expect(c.calls).not.toContain("confirmTransaction");
    expect(c.callArgs[c.calls.indexOf("getSignatureStatuses")]).toEqual([[SIGNATURE], { searchTransactionHistory: true }]);

    const [tx] = c.sent;
    expect(tx!.message.recentBlockhash).toBe(BLOCKHASH);
    const [verify] = tx!.message.compiledInstructions;
    expect(tx!.message.staticAccountKeys[verify!.programIdIndex]!.equals(Ed25519Program.programId)).toBe(true);
    const inputs = attestationInputs({ programId, link, vault, from: BigInt(EPOCH), endSlot: BigInt(EPOCH + 5), baseLamports: 1_000_000_000n, currentSlot: BigInt(EPOCH + 140) });
    expect(Buffer.from(verify!.data.subarray(16, 48)).equals(attester.publicKey.toBuffer())).toBe(true);
    expect(Buffer.from(verify!.data.subarray(112)).equals(attestationMessage(inputs))).toBe(true);
    // The priced message is the sent one but for the signature bytes.
    const [priced] = c.callArgs[c.calls.indexOf("getFeeForMessage")] as [Message];
    expect(priced.staticAccountKeys.map(String)).toEqual(tx!.message.staticAccountKeys.map(String));
    const [pricedVerify, pricedSettle] = priced.compiledInstructions;
    expect(Buffer.from(pricedVerify!.data.subarray(0, 48)).equals(Buffer.from(verify!.data.subarray(0, 48)))).toBe(true);
    expect(Buffer.from(pricedVerify!.data.subarray(112)).equals(Buffer.from(verify!.data.subarray(112)))).toBe(true);
    expect(Buffer.from(pricedSettle!.data).equals(Buffer.from(tx!.message.compiledInstructions[1]!.data))).toBe(true);
  });

  it("through the Privy route is submitted once, as the pair its fee was priced for, under an idempotency key new for each attempt", async () => {
    const keys: string[] = [];
    for (const confirmedSlot of [EPOCH + 140, EPOCH + 141]) {
      const c = chain({ getSlot: async (commitment) => (commitment === "finalized" ? EPOCH + 100 : confirmedSlot) });
      const handed: { readonly transaction: Transaction; readonly idempotencyKey: string }[] = [];
      const privy: SolanaWalletSubmitter = {
        address: link.wallet,
        submit: async (transaction, { idempotencyKey }) => {
          handed.push({ transaction, idempotencyKey });
          // What Privy would broadcast, so the stub chain's receipt has a message to read.
          c.sent.push(VersionedTransaction.deserialize(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })));
          return SIGNATURE;
        },
      };
      const result = await runSettleTick(c.deps({ walletSigner: privy }));
      const named = `confirmed slot ${confirmedSlot}`;
      expect(result, named).toMatchObject({ outcome: "SETTLED", settledLamports: BigInt(PAID), signature: SIGNATURE, nonce: 4n });
      expect(c.calls, named).not.toContain("sendRawTransaction");
      expect(handed, named).toHaveLength(1);
      const { transaction, idempotencyKey } = handed[0]!;
      expect(() => assertSettleShape(transaction, programId, link.wallet)).not.toThrow();
      expect(transaction.recentBlockhash).toBe(BLOCKHASH);
      // sha256 of the link, the nonce this attestation consumes, and its deadline: the confirmed slot plus 150.
      const deadline = BigInt(confirmedSlot) + 150n;
      expect(idempotencyKey, named).toBe(createHash("sha256").update(`${link.linkAddress.toBase58()}:4:${deadline}`).digest("hex"));
      keys.push(idempotencyKey);
    }
    expect(new Set(keys).size).toBe(2);
  });

  it("warns in its detail when the vault moved another amount than settle_v2 computes", async () => {
    const c = chain();
    const tick = c.deps();
    const receiptOf = c.connection.getTransaction.bind(c.connection);
    const result = await runSettleTick({
      ...tick,
      connection: new Proxy(c.connection, {
        get(target, prop) {
          if (prop !== "getTransaction") return (target as unknown as Record<string | symbol, unknown>)[prop];
          return async (signature: string, config: { commitment: Finality }) => {
            const answer = await receiptOf(signature, config as never);
            if (config.commitment === "finalized" || answer === null || answer.meta === null) return answer;
            const index = answer.transaction.message.staticAccountKeys.findIndex((key) => key.equals(link.vault));
            answer.meta.postBalances[index] = answer.meta.postBalances[index]! - 1;
            return answer;
          };
        },
      }) as Connection,
    });
    expect(result).toMatchObject({ outcome: "SETTLED", settledLamports: BigInt(PAID - 1), expectedLamports: BigInt(PAID) });
    expect(result.detail).toContain(`WARNING: the vault moved ${PAID - 1} lamports, not the ${PAID}`);
  });

  // ── the receipt, when the node serves it as a versioned transaction ────────
  //
  // This read used to carry maxSupportedTransactionVersion: 0, which is not
  // "give me what you can" — a transaction above it is refused with JSON-RPC
  // -32015, and web3.js throws. Our own settle is a legacy message, so this path
  // was not the one losing money; the walk was. It is pinned here because both
  // reads now go through one helper, and a test that only covers the walk lets
  // the next read added here get the contract wrong again.

  /**
   * The chain's connection with its CONFIRMED receipt served as a version
   * `version` transaction, honouring the contract the way agave does: a read
   * asking for less is refused rather than degraded. The finalized reads the
   * walk makes are passed straight through.
   */
  function versionedReceipt(c: ReturnType<typeof chain>, version: number) {
    const asked: number[] = [];
    const receiptOf = c.connection.getTransaction.bind(c.connection);
    const connection = new Proxy(c.connection, {
      get(target, prop) {
        if (prop !== "getTransaction") return (target as unknown as Record<string | symbol, unknown>)[prop];
        return async (signature: string, config: { maxSupportedTransactionVersion: number; commitment: Finality }) => {
          if (config.commitment === "finalized") return receiptOf(signature, config as never);
          asked.push(config.maxSupportedTransactionVersion);
          if (version > config.maxSupportedTransactionVersion) {
            throw new SolanaJSONRPCError(
              {
                code: SolanaJSONRPCErrorCode.JSON_RPC_SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION,
                message:
                  `Transaction version (${version}) is not supported by the requesting client. Please try the request again ` +
                  `with the following configuration parameter: "maxSupportedTransactionVersion": ${version}`,
              },
              "failed to get transaction",
            );
          }
          const answer = (await receiptOf(signature, config as never))!;
          const legacy = answer.transaction.message as Message;
          // The same keys and the same balances, in a version 1 message: what
          // the turn reads out of a receipt is the vault's pre/post, and it must
          // read them through whichever message version the node hands back.
          const message = new MessageV1({
            header: legacy.header,
            staticAccountKeys: legacy.staticAccountKeys,
            recentBlockhash: legacy.recentBlockhash,
            compiledInstructions: [],
            transactionConfig: { computeUnitLimit: 200_000, heapSize: null, loadedAccountsDataSizeLimit: null, priorityFee: 5_000 },
          });
          return { ...answer, version, transaction: { ...answer.transaction, message } };
        };
      },
    }) as Connection;
    return { connection, asked };
  }

  it("reads a version 1 receipt and reports what the vault really moved", async () => {
    const c = chain();
    const node = versionedReceipt(c, 1);
    const result = await runSettleTick(c.deps({ connection: node.connection }));
    expect(result).toMatchObject({ outcome: "SETTLED", settledLamports: BigInt(PAID), expectedLamports: BigInt(PAID), signature: SIGNATURE });
    expect(result.detail).toContain(`settled ${PAID} lamports from 1000000000 measured over 1 txs`);
    expect(result.detail).not.toContain("receipt not read in time");
    expect(node.asked).toEqual([MAX_SUPPORTED_TRANSACTION_VERSION]);
  });

  it("never turns a landed settle into a failure over a receipt even this client cannot decode", async () => {
    const c = chain();
    const node = versionedReceipt(c, 2);
    const result = await runSettleTick(c.deps({ connection: node.connection }));
    // The settle LANDED. Its amount is unknown and said to be unknown; the
    // outcome is the chain's, not the reader's.
    expect(result).toMatchObject({ outcome: "SETTLED", expectedLamports: BigInt(PAID), signature: SIGNATURE });
    expect(result.settledLamports).toBeUndefined();
    expect(result.detail).toContain("the vault delta is on chain, its receipt not read in time");
    expect(node.asked).toEqual([MAX_SUPPORTED_TRANSACTION_VERSION]);
  });
});

describe("a send that threw, or never confirmed", () => {
  it("is SETTLED once the re-read link shows its nonce moved, whatever the send threw, and never FAILED", async () => {
    for (const error of [Object.assign(new Error("504 Gateway Timeout"), { status: 504 }), Object.assign(new Error("403 denied"), { status: 403 })]) {
      const c = chain({ getAccountInfoAndContext: linkRead(link.settlementNonce + 1n) });
      const result = await runSettleTick(c.deps({ walletSigner: throwingSubmitter(error) }));
      expect(result, error.message).toMatchObject({ outcome: "SETTLED", nonce: 4n, endSlot: BigInt(EPOCH + 5), expectedLamports: BigInt(PAID) });
      expect(result.detail.startsWith("landed; receipt not read")).toBe(true);
      expect(c.calls).toContain("getAccountInfoAndContext");
      expect(c.calls).not.toContain("getSignatureStatuses");
    }
  });

  it("is RETRY for a 504 and FAILED for a 403 when the link shows nothing landed", async () => {
    for (const [status, want] of [
      [504, "RETRY"],
      [403, "FAILED"],
    ] as const) {
      const c = chain({ getAccountInfoAndContext: linkRead(link.settlementNonce) });
      const result = await runSettleTick(c.deps({ walletSigner: throwingSubmitter(Object.assign(new Error(`${status} from Privy`), { status })) }));
      expect(result, String(status)).toMatchObject({ outcome: want, feeLamports: BigInt(FEE) });
      expect(result.detail).toContain(`${status} from Privy`);
      expect(c.calls).toContain("getAccountInfoAndContext");
    }
  });

  it("is classified by the program's name when the preflight refused it, with no link read for a resting refusal", async () => {
    const reserveCode = idl.errors!.find((error) => error.name === "WalletBelowReserve")!.code;
    const c = chain({
      sendRawTransaction: async () => {
        throw new SendTransactionError({
          action: "simulate",
          signature: "",
          transactionMessage: `Transaction simulation failed: Error processing Instruction 1: custom program error: 0x${reserveCode.toString(16)}`,
          logs: [],
        });
      },
    });
    const result = await runSettleTick(c.deps());
    expect(result.outcome).toBe("BELOW_RESERVE");
    expect(result.detail).toContain("WalletBelowReserve");
    expect(c.calls).not.toContain("getAccountInfoAndContext");
  });

  it("is read back from the link once no confirmed status arrives within the timeout: SETTLED when it landed, RETRY when not", async () => {
    for (const [nonce, want] of [
      [link.settlementNonce + 1n, "SETTLED"],
      [link.settlementNonce, "RETRY"],
    ] as const) {
      const c = chain({
        getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [null] }),
        getAccountInfoAndContext: linkRead(nonce),
      });
      const result = await underFakeTimers(() => runSettleTick(c.deps()));
      expect(result, want).toMatchObject({ outcome: want, signature: SIGNATURE });
      expect(result.detail).toContain(`was not confirmed within ${CONFIRM_TIMEOUT_MS / 1_000} s`);
      expect(c.calls.filter((name) => name === "getSignatureStatuses").length).toBeGreaterThan(CONFIRM_TIMEOUT_MS / CONFIRM_POLL_MS - 5);
      expect(c.calls.filter((name) => name === "sendRawTransaction")).toHaveLength(1);
    }
  });

  it("asks again after a status request that throws, and takes neither an error nor a success before it is confirmed", async () => {
    // An error at processed can belong to a fork that is dropped, and this one is.
    const code = idl.errors!.find((error) => error.name === "WrongAttester")!.code;
    let polls = 0;
    const c = chain({
      getSignatureStatuses: async () => {
        polls += 1;
        if (polls === 1) throw new Error("every Solana endpoint refused (endpoint 1/1 HTTP 503)");
        if (polls === 2) {
          return { context: { slot: 1 }, value: [{ slot: EPOCH + 150, confirmations: 0, err: { InstructionError: [1, { Custom: code }] }, confirmationStatus: "processed" }] };
        }
        if (polls === 3) return { context: { slot: 1 }, value: [{ slot: EPOCH + 151, confirmations: 0, err: null, confirmationStatus: "processed" }] };
        return { context: { slot: 1 }, value: [{ slot: EPOCH + 151, confirmations: 1, err: null, confirmationStatus: "confirmed" }] };
      },
    });
    const result = await underFakeTimers(() => runSettleTick(c.deps()));
    expect(result).toMatchObject({ outcome: "SETTLED", settledLamports: BigInt(PAID), signature: SIGNATURE });
    expect(polls).toBe(4);
    expect(c.calls).not.toContain("getAccountInfoAndContext");
  });
});

describe("a settle that landed with an on-chain error", () => {
  it("is classified by the program's name from its confirmed status, with no link read and no receipt", async () => {
    for (const [name, want] of [
      ["AttestationExpired", "RETRY"],
      ["VaultPaused", "PAUSED"],
      ["WalletBelowReserve", "BELOW_RESERVE"],
      ["WrongAttester", "FAILED"],
    ] as const) {
      const code = idl.errors!.find((error) => error.name === name)!.code;
      const c = chain({ getSignatureStatuses: confirmed({ InstructionError: [1, { Custom: code }] }) });
      const result = await runSettleTick(c.deps());
      expect(result, name).toMatchObject({ outcome: want, signature: SIGNATURE });
      expect(result.detail).toContain(`the settle landed and reverted: settle_v2 refused it with ${name}`);
      const afterStatus = c.calls.slice(c.calls.indexOf("getSignatureStatuses"));
      expect(afterStatus).not.toContain("getAccountInfoAndContext");
      expect(afterStatus).not.toContain("getTransaction");
    }
  });

  it("is classified from the receipt's own meta.err when the status said it landed", async () => {
    const code = idl.errors!.find((error) => error.name === "AttestationMismatch")!.code;
    const c = chain();
    const receiptOf = c.connection.getTransaction.bind(c.connection);
    const result = await runSettleTick(
      c.deps({
        connection: new Proxy(c.connection, {
          get(target, prop) {
            if (prop !== "getTransaction") return (target as unknown as Record<string | symbol, unknown>)[prop];
            return async (signature: string, config: { commitment: Finality }) => {
              const answer = await receiptOf(signature, config as never);
              if (config.commitment === "finalized" || answer === null || answer.meta === null) return answer;
              return { ...answer, meta: { ...answer.meta, err: { InstructionError: [1, { Custom: code }] } } };
            };
          },
        }) as Connection,
      }),
    );
    expect(result).toMatchObject({ outcome: "RETRY", signature: SIGNATURE });
    expect(result.detail).toContain("the settle's receipt shows it reverted: settle_v2 refused it with AttestationMismatch");
  });
});

describe("a loss carried past a backlog's zero settle", () => {
  const stranger = Keypair.generate().publicKey;
  const address = link.linkAddress.toBase58();
  /** The carry book's key for a link state of this link's epoch. */
  const stateKey = (settlementNonce: bigint, frontierSlot: number | bigint) => `${EPOCH}:${settlementNonce}:${frontierSlot}`;
  /** Where the losing prefix ends: the loss and 299 of the stranger's transfers. */
  const PREFIX_END = EPOCH + 300;
  /** The link's own transaction, the wallet's 0.5 SOL loss on Jupiter, then 300 zero-lamport transfers a stranger sent. */
  const losingBacklog = new FakeLedger(
    link.wallet,
    chained(2_000_000_000, [
      { signature: "link-0", slot: EPOCH, programs: [SYSTEM], delta: -2_000_000 },
      { signature: "loss-1", slot: EPOCH + 1, programs: [JUPITER], delta: -500_000_000 },
      ...Array.from({ length: 300 }, (_, i) => ({ signature: `transfer-${i + 2}`, slot: EPOCH + 2 + i, programs: [SYSTEM], delta: 0, signers: [stranger] })),
    ]),
  );
  const lossCarried = { lossLamports: 500_000_000n, walletSignedTxCount: 1 };

  /** The stub chain over the losing backlog's finalized history, whose confirmed receipt of the settle moves the vault by nothing, as a zero base does. */
  function backlogChain(extra: Readonly<Record<string, Handler>> = {}) {
    let built: ReturnType<typeof chain> | undefined;
    built = chain({
      getSignaturesForAddress: async (address, options, commitment) =>
        commitment === "confirmed"
          ? [{ signature: "transfer-301", slot: EPOCH + 301, err: null, memo: null }]
          : losingBacklog.signatures(address as PublicKey, options as { limit: number }, commitment as Finality),
      getTransaction: async (signature, config) => {
        const commitment = (config as { commitment: Finality }).commitment;
        return commitment === "finalized" ? losingBacklog.transaction(signature as string, commitment) : built!.receipt(0);
      },
      getSlot: async (commitment) => (commitment === "finalized" ? EPOCH + 400 : EPOCH + 440),
      ...extra,
    });
    return built;
  }

  /** The stub chain's connection with one method wrapped: `wrap` is handed the chain's own and returns what the turn calls instead. */
  const wrapping = (connection: Connection, name: string, wrap: (served: Handler) => Handler): Connection =>
    new Proxy(connection, {
      get(target, prop) {
        const served = (target as unknown as Record<string | symbol, unknown>)[prop];
        return prop === name ? wrap(served as Handler) : served;
      },
    }) as Connection;

  /** The message the sent settle's Ed25519 instruction verifies: the attestation the settle key signed. */
  const attested = (c: ReturnType<typeof chain>) => Buffer.from(c.sent.at(-1)!.message.compiledInstructions[0]!.data.subarray(112));

  it("records a losing prefix's carry before its zero settle is sent, attests a zero base, and says what it carries; a dry run only says it would", async () => {
    const carries: CarryBook = new Map();
    const c = backlogChain();
    let atSend: LossCarry | undefined;
    const result = await runSettleTick({
      ...c.deps({ carries }),
      connection: wrapping(c.connection, "sendRawTransaction", (served) => async (...args) => {
        atSend = carries.get(address)?.get(stateKey(5n, PREFIX_END));
        return served(...args);
      }),
    });
    expect(result, result.detail).toMatchObject({
      outcome: "SETTLED",
      baseLamports: 0n,
      expectedLamports: 0n,
      settledLamports: 0n,
      nonce: 4n,
      endSlot: BigInt(PREFIX_END),
      carry: lossCarried,
    });
    expect(result.detail).toBe(
      `settled 0 lamports from 0 measured over 300 txs (0 expected at 2000 bps); ` +
        `backlog: settling the oldest 300 of 301 signatures above slot ${EPOCH}, up to slot ${PREFIX_END}; the rest continues next sweep; ` +
        `carrying 500000000 lamports of losses and 1 wallet-signed transactions into the window from slot ${PREFIX_END}`,
    );
    expect(atSend, "the carry is in the book before the settle leaves").toEqual(lossCarried);
    expect([...(carries.get(address)?.entries() ?? [])]).toEqual([[stateKey(5n, PREFIX_END), lossCarried]]);
    expect(c.calls.filter((name) => name === "sendRawTransaction")).toHaveLength(1);
    const inputs = attestationInputs({ programId, link, vault, from: BigInt(EPOCH), endSlot: BigInt(PREFIX_END), baseLamports: 0n, currentSlot: BigInt(EPOCH + 440) });
    expect(attested(c).equals(attestationMessage(inputs)), "the sent settle_v2 attests base 0").toBe(true);

    const dry = backlogChain();
    const dryBook: CarryBook = new Map();
    const preview = await runSettleTick(dry.deps({ live: false, attester: null, walletSigner: null, carries: dryBook }));
    expect(preview, preview.detail).toMatchObject({ outcome: "SETTLED", baseLamports: 0n, carry: lossCarried });
    expect(preview.detail).toBe(
      `DRY RUN — would settle 0 lamports in PROFIT at 2000 bps and advance the frontier from ${EPOCH} to ${PREFIX_END} over 300 txs; ` +
        `backlog: settling the oldest 300 of 301 signatures above slot ${EPOCH}, up to slot ${PREFIX_END}; the rest continues next sweep; ` +
        `would carry 500000000 lamports of losses and 1 wallet-signed transactions into the window from slot ${PREFIX_END}`,
    );
    expect(dryBook.size, "a dry run records nothing").toBe(0);
    expect(dry.calls).not.toContain("sendRawTransaction");
  });

  it("nets a carried loss against the next window's profit: the base, the attestation, the payment and the reserve are all the net's, and a wallet short of the net's reserve sends nothing", async () => {
    const carry = { lossLamports: 600_000_000n, walletSignedTxCount: 1 };
    const paid = 80_000_000;
    const exact = FEE + paid + RENT0 + Number(vault.walletReserve);
    for (const [balance, outcome] of [
      [exact, "SETTLED"],
      [exact - 1, "BELOW_RESERVE"],
    ] as const) {
      const named = `balance ${balance}`;
      const carries: CarryBook = new Map([[address, new Map([[stateKey(4n, 0n), carry]])]]);
      const c = chain({ getBalance: async () => balance });
      const result = await runSettleTick({
        ...c.deps({ carries }),
        connection: wrapping(c.connection, "getTransaction", (served) => async (signature, config) =>
          (config as { commitment: Finality }).commitment === "finalized" ? served(signature, config) : c.receipt(paid),
        ),
      });
      expect(result, named).toMatchObject({ outcome, baseLamports: 400_000_000n, expectedLamports: BigInt(paid) });
      expect(result.carry, named).toBeUndefined();
      if (outcome === "SETTLED") {
        expect(result, named).toMatchObject({ settledLamports: BigInt(paid), nonce: 4n, endSlot: BigInt(EPOCH + 5) });
        expect(result.detail).toBe(`settled ${paid} lamports from 400000000 measured over 1 txs (${paid} expected at 2000 bps); net of 600000000 lamports carried`);
        const inputs = attestationInputs({ programId, link, vault, from: BigInt(EPOCH), endSlot: BigInt(EPOCH + 5), baseLamports: 400_000_000n, currentSlot: BigInt(EPOCH + 140) });
        expect(attested(c).equals(attestationMessage(inputs)), "the attested base is the net").toBe(true);
      } else {
        expect(result.detail).toContain("1 lamports short");
        expect(c.calls, named).not.toContain("sendRawTransaction");
      }
      // The carry that brought the link here stays until a later state prunes it, sent or not.
      expect([...(carries.get(address)?.entries() ?? [])], named).toEqual([[stateKey(4n, 0n), carry]]);
    }
  });

  it("keeps the carry of a settle whose send threw and landed: SETTLED from the re-read link, and the book holds the state it left", async () => {
    const carries: CarryBook = new Map();
    const c = backlogChain({ getAccountInfoAndContext: linkRead(link.settlementNonce + 1n) });
    const result = await runSettleTick(
      c.deps({ carries, walletSigner: throwingSubmitter(Object.assign(new Error("504 Gateway Timeout"), { status: 504 })) }),
    );
    expect(result, result.detail).toMatchObject({ outcome: "SETTLED", nonce: 4n, endSlot: BigInt(PREFIX_END), carry: lossCarried });
    expect(result.detail.startsWith("landed; receipt not read")).toBe(true);
    expect(result.detail).toContain(`carrying 500000000 lamports of losses and 1 wallet-signed transactions into the window from slot ${PREFIX_END}`);
    expect([...(carries.get(address)?.entries() ?? [])]).toEqual([[stateKey(5n, PREFIX_END), lossCarried]]);
  });

  it("deletes a stale carry under the state a winning settle leaves, so a loss another window would have carried never nets against the next one", async () => {
    const stale = { lossLamports: 9n, walletSignedTxCount: 1 };
    const carries: CarryBook = new Map([[address, new Map([[stateKey(5n, EPOCH + 5), stale]])]]);
    const c = chain();
    const result = await runSettleTick(c.deps({ carries }));
    expect(result, result.detail).toMatchObject({ outcome: "SETTLED", baseLamports: 1_000_000_000n, settledLamports: BigInt(PAID), endSlot: BigInt(EPOCH + 5) });
    expect(result.carry).toBeUndefined();
    expect(result.detail).toBe(`settled ${PAID} lamports from 1000000000 measured over 1 txs (${PAID} expected at 2000 bps)`);
    expect(carries.get(address)?.has(stateKey(5n, EPOCH + 5)) ?? false, "the stale entry is deleted").toBe(false);
    expect(carries.size).toBe(0);
  });
});
