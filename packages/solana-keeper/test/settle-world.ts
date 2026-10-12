// One wallet's chain, small enough to read and real enough for runSettleTick:
// the tests of the `rest-skip` cut (test/rest-book.test.ts) and of the
// loss-carry store (test/carry-store*.test.ts) both turn the real settle tick
// over it, dry and live.
//
// IT GROWS AS THE CHAIN DOES. A ledger, oldest first, that trades, a stranger's
// transfers and our own settles append to; a confirmed tip the probe reads and a
// finalized slot the walk reads up to; and the link as discovery would read it
// this sweep, whose frontier and nonce move only when the test says a settle
// landed. The walk's reads go through the FakeLedger, which refuses any
// commitment but finalized, so a read made at the wrong one fails the test.
//
// A LIVE SEND IS RECORDED, CONFIRMED AND GIVEN A RECEIPT, and nothing more: the
// test decides whether it landed (land()), as the chain would, and the gate's
// fresh read of the link's nonce (readSettlementNonce) answers the world's link.
// No network and no real key: the wallet is a Keypair.generate(), as on localnet.

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, VersionedTransaction, type Connection, type Finality } from "@solana/web3.js";
import type { VaultState } from "../src/accounts.js";
import type { ManagedLink } from "../src/discovery.js";
import { accountDiscriminator, idl } from "../src/idl.js";
import { WalkCache } from "../src/measure-window.js";
import { MODE_PROFIT, MODE_VOLUME } from "../src/program-scripts.js";
import type { RestBook } from "../src/rest-book.js";
import type { CarryBook } from "../src/settle-decision.js";
import { runSettleTick, type SettleDeps, type SettleResult } from "../src/settle-tick.js";
import { FakeLedger, type LedgerEntry } from "./fake-ledger.js";

export const programId = new PublicKey(idl.address);
export const SYSTEM = "11111111111111111111111111111111";
export const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
export const ED25519 = "Ed25519SigVerify111111111111111111111111111";
/** Our own settle, as the walk classifies it: every program non-trading or sip-vault, sip-vault among them. */
export const OWN_SETTLE = [ED25519, programId.toBase58(), SYSTEM];
export const EPOCH = 300_000_000;
/** What the node prices every settle at. */
export const SETTLE_FEE = 10_000;
export const RENT0 = 890_880;
const BLOCKHASH = Keypair.generate().publicKey.toBase58();

export const vaultOf = (skimMode: number): VaultState => ({
  owner: Keypair.generate().publicKey,
  paused: false,
  skimMode,
  skimBps: 2_000,
  volumeBps: 200,
  policyNonce: 1n,
  maxContribution: 10_000_000_000n,
  walletReserve: 50_000_000n,
});

/** A small deterministic PRNG (mulberry32), so a failing history can be replayed from its seed. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export class SettleWorld {
  readonly walletKey = Keypair.generate();
  readonly wallet = this.walletKey.publicKey;
  readonly stranger = Keypair.generate().publicKey;
  readonly entries: LedgerEntry[] = [];
  link: ManagedLink;
  /** Every appended entry is confirmed at once; the probe reads them all. */
  finalized: number;
  /** Every live send, in order. */
  readonly sent: VersionedTransaction[] = [];
  /** What the next receipt says the vault received. */
  receiptVaultDelta = 0;
  #balance = 5_000_000_000;
  #slot: number;
  #n = 0;

  constructor({ settlementNonce = 0n }: { readonly settlementNonce?: bigint } = {}) {
    this.link = {
      linkAddress: PublicKey.findProgramAddressSync([Buffer.from("link"), this.wallet.toBuffer()], programId)[0],
      wallet: this.wallet,
      vault: Keypair.generate().publicKey,
      epoch: BigInt(EPOCH),
      settlementNonce,
      frontierSlot: 0n,
    };
    this.#slot = EPOCH;
    // THE LINK'S OWN TRANSACTION, at its epoch: the anchor a first walk stops at.
    this.#push([SYSTEM], -2_000_000, {}, true);
    this.finalized = EPOCH;
  }

  /** The newest slot anything landed in, or the chain moved to: the confirmed tip. */
  get tip(): number {
    return this.#slot;
  }

  get balance(): number {
    return this.#balance;
  }

  #push(programs: readonly string[], delta: number, over: Partial<Pick<LedgerEntry, "signers">> = {}, sameSlot = false): LedgerEntry {
    if (!sameSlot) this.#slot += 1;
    this.#n += 1;
    const entry: LedgerEntry = { signature: `tx-${this.#n}`, slot: this.#slot, pre: this.#balance, post: this.#balance + delta, programs, ...over };
    this.entries.push(entry);
    this.#balance += delta;
    return entry;
  }

  trade(delta: number, sameSlot = false): LedgerEntry {
    return this.#push([JUPITER, SYSTEM], delta, {}, sameSlot);
  }

  /** A stranger's zero-lamport transfer: it names the wallet, and the wallet signs nothing. */
  transfer(sameSlot = false): LedgerEntry {
    return this.#push([SYSTEM], 0, { signers: [this.stranger] }, sameSlot);
  }

  /** Our own settle, landing above the confirmed tip: the wallet pays `paid` to its vault and the fee. */
  ownSettle(paid: number): LedgerEntry {
    return this.#push(OWN_SETTLE, -paid - SETTLE_FEE);
  }

  /** Empty slots: the chain moves on and nothing lands for this wallet. */
  advance(slots: number): void {
    this.#slot += slots;
  }

  /**
   * A settle that closed the window up to `endSlot` LANDED: the link moves to the
   * next nonce and that frontier, and the settle itself lands above the tip.
   */
  land(endSlot: bigint, paid: number): LedgerEntry {
    this.link = { ...this.link, frontierSlot: endSlot, settlementNonce: this.link.settlementNonce + 1n };
    return this.ownSettle(paid);
  }

  /**
   * A settle of everything finalized above the frontier lands (a dry-run world's
   * stand-in for a real one): false when nothing finalized was above it.
   */
  settleLands(paid: number): boolean {
    const from = this.link.frontierSlot === 0n ? this.link.epoch : this.link.frontierSlot;
    const end = [...this.entries].reverse().find((entry) => entry.slot <= this.finalized)?.slot;
    if (end === undefined || BigInt(end) <= from) return false;
    this.land(BigInt(end), paid);
    return true;
  }

  /** The wallet relinks: a new link at a new epoch, its own transaction there, nonce and frontier from zero. */
  relink(): void {
    const entry = this.#push([SYSTEM], -2_000_000);
    this.link = { ...this.link, epoch: BigInt(entry.slot), settlementNonce: 0n, frontierSlot: 0n };
  }

  finalizeTo(slot: number): void {
    this.finalized = Math.max(this.finalized, Math.min(slot, this.tip));
  }

  /**
   * A losing backlog the next settle can only cut: the wallet's own 0.5 SOL loss
   * on Jupiter, then MAX_SIGNATURES transfers a stranger sent, all finalized. The
   * oldest prefix of 300 is the loss and 299 transfers: a PROFIT zero settle that
   * carries 500 000 000 lamports and 1 wallet-signed transaction into the window
   * above its end, which is returned.
   */
  losingBacklog(): bigint {
    this.trade(-500_000_000);
    let prefixEnd = 0;
    for (let i = 0; i < 300; i++) {
      const transfer = this.transfer();
      if (i === 298) prefixEnd = transfer.slot;
    }
    this.finalizeTo(this.tip);
    return BigInt(prefixEnd);
  }

  /** state.rs TradingLink, as the chain holds the world's link now. */
  linkBytes(): Buffer {
    const buf = Buffer.alloc(129);
    accountDiscriminator("TradingLink").copy(buf, 0);
    this.link.wallet.toBuffer().copy(buf, 8);
    this.link.vault.toBuffer().copy(buf, 40);
    buf.writeBigUInt64LE(this.link.epoch, 72);
    buf.writeBigUInt64LE(this.link.settlementNonce, 80);
    buf.writeBigUInt64LE(this.link.frontierSlot, 88);
    buf.writeUInt8(254, 96);
    return buf;
  }

  /** The receipt of the last transaction sent, moving the vault by receiptVaultDelta. */
  #receipt(): unknown {
    const tx = this.sent.at(-1)!;
    const keys = tx.message.staticAccountKeys;
    const pre = keys.map(() => 1_000_000_000);
    const post = keys.map((key, i) => (key.equals(this.link.vault) ? pre[i]! + this.receiptVaultDelta : pre[i]!));
    return {
      slot: this.tip,
      blockTime: null,
      transaction: { message: tx.message, signatures: [`settle-${this.sent.length}`] },
      meta: { err: null, fee: SETTLE_FEE, preBalances: pre, postBalances: post, innerInstructions: [], loadedAddresses: { writable: [], readonly: [] }, logMessages: [] },
    };
  }

  /** A Connection over this world as it stands, recording every call into `calls`. */
  connection(calls: string[]): Connection {
    const finalizedLedger = () => new FakeLedger(this.wallet, this.entries.filter((entry) => entry.slot <= this.finalized));
    const served: Record<string, (...args: unknown[]) => unknown> = {
      getSignaturesForAddress: async (address, options, commitment) => {
        if (commitment === "confirmed") {
          const { limit } = options as { limit: number };
          return [...this.entries]
            .reverse()
            .slice(0, limit)
            .map(({ signature, slot }) => ({ signature, slot, err: null, memo: null }));
        }
        return finalizedLedger().signatures(address as PublicKey, options as { limit: number }, commitment as Finality);
      },
      getTransaction: async (signature, config) => {
        const commitment = (config as { commitment: Finality }).commitment;
        return commitment === "finalized" ? finalizedLedger().transaction(signature as string, commitment) : this.#receipt();
      },
      getSlot: async (commitment) => (commitment === "finalized" ? this.finalized : this.tip),
      getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 }),
      getFeeForMessage: async () => ({ context: { slot: this.tip }, value: SETTLE_FEE }),
      getBalance: async () => this.#balance,
      getMinimumBalanceForRentExemption: async () => RENT0,
      sendRawTransaction: async (bytes) => {
        this.sent.push(VersionedTransaction.deserialize(bytes as Uint8Array));
        return `settle-${this.sent.length}`;
      },
      getSignatureStatuses: async () => ({
        context: { slot: this.tip },
        value: [{ slot: this.tip, confirmations: 1, err: null, confirmationStatus: "confirmed" }],
      }),
      getAccountInfoAndContext: async (address) => ({
        context: { slot: this.tip },
        value: (address as PublicKey).equals(this.link.linkAddress)
          ? { data: this.linkBytes(), executable: false, lamports: 1_000_000, owner: programId, rentEpoch: 0 }
          : null,
      }),
    };
    return new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop !== "string" || prop === "then") return undefined;
          return (...args: unknown[]) => {
            calls.push(prop);
            const handler = served[prop];
            if (handler === undefined) throw new Error(`unexpected RPC call: ${prop}`);
            return handler(...args);
          };
        },
      },
    ) as unknown as Connection;
  }
}

/** What a WorldKeeper's turn may add to the deps it builds: `link` turns a link as an earlier read saw it. */
export type TurnOptions = Partial<Pick<SettleDeps, "carryStore" | "live" | "link">>;

/**
 * One keeper's view of one world: its own connection, call log, walk cache and
 * carry book, the way bin/keeper.mts keeps them from sweep to sweep. A restart is
 * a new WorldKeeper over the same world.
 */
export class WorldKeeper {
  readonly calls: string[] = [];
  readonly walkCache = new WalkCache();
  readonly carries: CarryBook;
  readonly attester = Keypair.generate();
  readonly #connection: Connection;
  readonly #program: anchor.Program;

  constructor(
    readonly world: SettleWorld,
    /** `carries`: one process's book, shared by the links it turns; a new one when absent. */
    readonly options: { readonly restBook?: RestBook; readonly mode?: number; readonly carries?: CarryBook } = {},
  ) {
    this.carries = options.carries ?? new Map();
    this.#connection = world.connection(this.calls);
    const refuse = async (): Promise<never> => {
      throw new Error("the world's keeper signs through its own keys only");
    };
    this.#program = new anchor.Program(
      idl,
      new anchor.AnchorProvider(this.#connection, { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse }, { commitment: "confirmed" }),
    );
  }

  get mode(): number {
    return this.options.mode ?? MODE_PROFIT;
  }

  /** One settle turn over the world as it stands — dry unless `live` — and the calls it made. */
  async turn(over: TurnOptions = {}): Promise<{ readonly result: SettleResult; readonly calls: readonly string[] }> {
    const before = this.calls.length;
    const live = over.live ?? false;
    const result = await runSettleTick({
      connection: this.#connection,
      program: this.#program,
      link: over.link ?? this.world.link,
      vault: vaultOf(this.mode),
      attester: live ? this.attester : null,
      walletSigner: live ? this.world.walletKey : null,
      live,
      protocolPaused: false,
      settles: [MODE_PROFIT, MODE_VOLUME],
      carries: this.carries,
      walkCache: this.walkCache,
      ...(this.options.restBook === undefined ? {} : { restBook: this.options.restBook }),
      ...(over.carryStore === undefined ? {} : { carryStore: over.carryStore }),
    });
    return { result, calls: this.calls.slice(before) };
  }
}
