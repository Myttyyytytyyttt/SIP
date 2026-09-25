// The chain the ceiling bench sweeps: every read answered, every write refused.
//
// NOTHING HERE RUNS IN PRODUCTION. src/bench/ exists for
// scripts/ceiling-bench.mts and its tests, and no file the keeper boots imports
// it.
//
// IT ANSWERS THE WIRE, NOT THE KEEPER. The stub is a Solana JSON-RPC endpoint:
// the bench serves it over HTTP on the loopback and points SIP_SOLANA_RPC_URLS
// at it, so @solana/web3.js's Connection, Anchor's coder, src/discovery.ts,
// src/accounts.ts, src/settle-tick.ts and src/invest-tick.ts all run EXACTLY the
// code they run against Helius. A stub one layer higher — a fake reader handed
// to the sweep — would have measured the bench's own loop, which is the mistake
// docs/TESTING_TRAPS.md opens with.
//
// THE WRITE PATH IS NOT MEASURED, AND THE BENCH SAYS SO. The keeper runs dry —
// no SIP_SOLANA_BROADCAST, so it reads no signing secret and reaches no send —
// and if anything ever did reach one, sendTransaction here answers a JSON-RPC
// error naming that fact rather than a fabricated signature. What the bench
// measures is the READ path and the sweep's own loop overhead: the six round
// trips an idle user costs, the sequential getTransaction walk a hot one costs,
// and what the pass through all of them adds up to.
//
// UNMODELLED METHODS ARE REPORTED, NEVER GUESSED. A method this stub does not
// know is answered with an error and recorded, so the run's summary says what
// the keeper asked for that the bench had no answer to. A stub that invented a
// plausible reply would move the measurement without telling anyone.

import { PublicKey, SYSVAR_CLOCK_PUBKEY, SYSVAR_EPOCH_SCHEDULE_PUBKEY } from "@solana/web3.js";
import { configAddress } from "../accounts.js";
import { PYTH_RECEIVER_PROGRAM, PYTH_SOL_USD_FEED, PYTH_SOL_USD_FEED_ID_HEX, PYTH_USDC_USD_FEED, PYTH_USDC_USD_FEED_ID_HEX } from "../pyth.js";
import {
  BENCH_FEE_LAMPORTS,
  BENCH_VENUE_PROGRAM,
  base58,
  benchKey,
  buildHistory,
  clockBytes,
  epochScheduleBytes,
  investmentPolicyBytes,
  priceUpdateBytes,
  protocolConfigBytes,
  rentExempt,
  tradingLinkBytes,
  vaultBytes,
  VAULT_SPACE,
  type BenchLink,
  type BenchTx,
} from "./fleet.js";

/** What sendTransaction answers, and what the report repeats: the bench does not measure writes. */
export const WRITE_PATH_REFUSAL =
  "the ceiling bench's stubbed chain accepts no transaction: it measures the READ path and the sweep loop only, " +
  "and the write path (sign, send, confirm) is EXCLUDED from every number it reports";

/** The loader a deployed program's account is owned by; the sweep reads `executable` off it. */
const BPF_UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** Above every synthetic transaction's slot, so a window is finalized and its deadline has room. */
const CURRENT_SLOT = 400_100_000;
/** 2026-09-22 00:00 UTC. */
const CHAIN_UNIX_SECONDS = 1_790_035_200n;
const CHAIN_EPOCH = 930n;
/** SOL at $102.59321149 and USDC at $0.99987040, expo -8, as the live feeds quote. */
const SOL_PRICE = 10_259_321_149n;
const USDC_PRICE = 99_987_040n;

const BLOCKHASH = base58(Buffer.alloc(32, 9));

interface AccountRecord {
  readonly data: Buffer;
  readonly owner: PublicKey;
  readonly lamports: number;
  readonly executable: boolean;
}

export interface RpcAnswer {
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface BenchChainOptions {
  readonly programId: PublicKey;
  readonly crank: PublicKey;
  /**
   * PROFIT is 0 and VOLUME is 1 (state.rs). PROFIT by default, and it has to be:
   * this keeper cannot measure a VOLUME notional yet (defaultVolumeBase rests
   * every span with a successful trade at UNSUPPORTED_MODE), so a VOLUME fleet
   * would walk its windows and then stop before the fee quote, the balance read
   * and the reserve check — measuring four round trips fewer than a real
   * settling turn costs.
   */
  readonly skimMode?: number;
}

/**
 * A Solana JSON-RPC endpoint over a synthetic fleet.
 *
 * SYNCHRONOUS AND PURE OF TIME. Every latency the bench injects is added by its
 * HTTP layer, per call, from a distribution — not here — so this class can be
 * tested for the SHAPES it answers without waiting for any of them.
 */
export class BenchChain {
  /** How many times each method has been called since the last `startSweep()`. */
  private methodCalls = new Map<string, number>();
  /** Every method this stub had no answer for, ever, in this run. */
  readonly unmodelled = new Set<string>();
  private accounts = new Map<string, AccountRecord>();
  private walletByKey = new Map<string, BenchLink>();
  private histories = new Map<string, readonly BenchTx[]>();
  private transactions = new Map<string, { readonly link: BenchLink; readonly tx: BenchTx }>();
  private links: readonly BenchLink[] = [];
  private readonly options: BenchChainOptions;

  constructor(options: BenchChainOptions) {
    this.options = options;
    this.accounts.set(options.programId.toBase58(), {
      data: Buffer.alloc(36),
      owner: BPF_UPGRADEABLE_LOADER,
      lamports: rentExempt(36),
      executable: true,
    });
    this.accounts.set(configAddress(options.programId).toBase58(), {
      data: protocolConfigBytes(benchKey("authority"), options.crank),
      owner: options.programId,
      lamports: rentExempt(203),
      executable: false,
    });
    this.accounts.set(SYSVAR_CLOCK_PUBKEY.toBase58(), {
      data: clockBytes(CHAIN_UNIX_SECONDS, BigInt(CURRENT_SLOT), CHAIN_EPOCH),
      owner: new PublicKey("Sysvar1111111111111111111111111111111111111"),
      lamports: 1,
      executable: false,
    });
    this.accounts.set(SYSVAR_EPOCH_SCHEDULE_PUBKEY.toBase58(), {
      data: epochScheduleBytes(),
      owner: new PublicKey("Sysvar1111111111111111111111111111111111111"),
      lamports: 1,
      executable: false,
    });
    for (const [feed, hex, price] of [
      [PYTH_SOL_USD_FEED, PYTH_SOL_USD_FEED_ID_HEX, SOL_PRICE],
      [PYTH_USDC_USD_FEED, PYTH_USDC_USD_FEED_ID_HEX, USDC_PRICE],
    ] as const) {
      this.accounts.set(feed.toBase58(), {
        // A second before the Clock above: a reading from the future rests the hop.
        data: priceUpdateBytes(hex, price, CHAIN_UNIX_SECONDS - 1n),
        owner: PYTH_RECEIVER_PROGRAM,
        lamports: rentExempt(134),
        executable: false,
      });
    }
  }

  /**
   * The fleet the NEXT getProgramAccounts returns.
   *
   * REPLACED WHOLE, between cells. scripts/ceiling-bench.mts boots ONE keeper
   * process PER CELL and reads that process's first sweep: a couple of seconds
   * of tsx startup per row, bought for a table in which every row is exactly one
   * sweep over exactly one fleet.
   */
  setFleet(links: readonly BenchLink[]): void {
    this.links = links;
    this.walletByKey = new Map(links.map((link) => [link.wallet.toBase58(), link]));
    this.histories.clear();
    this.transactions.clear();
    for (const link of links) {
      this.accounts.set(link.linkAddress.toBase58(), {
        data: tradingLinkBytes(link),
        owner: this.options.programId,
        lamports: rentExempt(129),
        executable: false,
      });
      this.accounts.set(link.vault.toBase58(), {
        data: vaultBytes({ owner: benchKey(`owner:${link.index}`), skimMode: this.options.skimMode ?? 0, skimBps: 2_000, volumeBps: 200 }),
        owner: this.options.programId,
        // EXACTLY THE RENT FLOOR, so the vault has no free lamports to wrap and
        // the invest turn rests at the balances instead of reaching a venue.
        lamports: rentExempt(VAULT_SPACE),
        executable: false,
      });
      this.accounts.set(link.policy.toBase58(), {
        data: investmentPolicyBytes(link.vault),
        owner: this.options.programId,
        lamports: rentExempt(970),
        executable: false,
      });
    }
  }

  /** Zero the per-sweep call counters and hand back the previous sweep's. */
  takeCalls(): ReadonlyMap<string, number> {
    const taken = this.methodCalls;
    this.methodCalls = new Map();
    return taken;
  }

  /** How many calls this stub has answered since the last `takeCalls()`. */
  get callsThisSweep(): number {
    let total = 0;
    for (const count of this.methodCalls.values()) total += count;
    return total;
  }

  private history(link: BenchLink): readonly BenchTx[] {
    const key = link.wallet.toBase58();
    const cached = this.histories.get(key);
    if (cached !== undefined) return cached;
    const built = buildHistory(link);
    this.histories.set(key, built);
    for (const tx of built) this.transactions.set(tx.signature, { link, tx });
    return built;
  }

  private accountJson(address: string): unknown {
    const record = this.accounts.get(address);
    if (record === undefined) return null;
    return {
      data: [record.data.toString("base64"), "base64"],
      executable: record.executable,
      lamports: record.lamports,
      owner: record.owner.toBase58(),
      rentEpoch: 0,
      space: record.data.length,
    };
  }

  private withContext(value: unknown): unknown {
    return { context: { apiVersion: "2.0.0", slot: CURRENT_SLOT }, value };
  }

  /**
   * One transaction as getTransaction answers it, as a LEGACY message.
   *
   * LEGACY AND NOT v0, because the walk reads both and legacy is the shape with
   * no lookup tables to fabricate. The wallet is static key 0 — fee payer and
   * sole signer, exactly as it is for its own trades — so isFeePayer and
   * isSignedByWallet in src/measure-window.ts run for real over these bytes.
   */
  private transactionJson(link: BenchLink, tx: BenchTx): unknown {
    return {
      slot: tx.slot,
      blockTime: Number(CHAIN_UNIX_SECONDS),
      version: "legacy",
      transaction: {
        signatures: [tx.signature],
        message: {
          accountKeys: [link.wallet.toBase58(), BENCH_VENUE_PROGRAM.toBase58()],
          header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
          instructions: [{ programIdIndex: 1, accounts: [0], data: base58(Buffer.from([9, 9, 9, 9])), stackHeight: null }],
          recentBlockhash: BLOCKHASH,
        },
      },
      meta: {
        err: null,
        fee: BENCH_FEE_LAMPORTS,
        preBalances: [tx.pre, 1],
        postBalances: [tx.post, 1],
        innerInstructions: [],
        logMessages: [],
        preTokenBalances: [],
        postTokenBalances: [],
        rewards: [],
        status: { Ok: null },
      },
    };
  }

  /** One JSON-RPC call. `params` is the array the client sent. */
  handle(method: string, params: readonly unknown[]): RpcAnswer {
    this.methodCalls.set(method, (this.methodCalls.get(method) ?? 0) + 1);
    switch (method) {
      case "getHealth":
        return { result: "ok" };
      case "getVersion":
        return { result: { "solana-core": "2.0.0", "feature-set": 0 } };
      case "getSlot":
        return { result: CURRENT_SLOT };
      case "getEpochInfo":
        return {
          result: { epoch: Number(CHAIN_EPOCH), slotIndex: 1, slotsInEpoch: 432_000, absoluteSlot: CURRENT_SLOT, blockHeight: CURRENT_SLOT },
        };
      case "getLatestBlockhash":
        return { result: this.withContext({ blockhash: BLOCKHASH, lastValidBlockHeight: CURRENT_SLOT }) };
      case "getFeeForMessage":
        return { result: this.withContext(BENCH_FEE_LAMPORTS) };
      case "getMinimumBalanceForRentExemption":
        return { result: rentExempt(typeof params[0] === "number" ? params[0] : 0) };
      case "getAccountInfo":
        return { result: this.withContext(this.accountJson(String(params[0]))) };
      case "getMultipleAccounts":
        return {
          result: this.withContext((Array.isArray(params[0]) ? (params[0] as unknown[]) : []).map((address) => this.accountJson(String(address)))),
        };
      case "getBalance": {
        const address = String(params[0]);
        const record = this.accounts.get(address);
        if (record !== undefined) return { result: this.withContext(record.lamports) };
        // A wallet or the crank: neither holds an account this stub models, and
        // both need a balance. The crank's is well above the low-crank warning,
        // so the bench does not spend its run alerting about a synthetic wallet.
        return { result: this.withContext(address === this.options.crank.toBase58() ? 5_000_000_000 : 2_000_000_000) };
      }
      case "getProgramAccounts": {
        return {
          result: this.links.map((link) => ({ pubkey: link.linkAddress.toBase58(), account: this.accountJson(link.linkAddress.toBase58()) })),
        };
      }
      case "getSignaturesForAddress": {
        const link = this.walletByKey.get(String(params[0]));
        if (link === undefined) return { result: [] };
        const options = (typeof params[1] === "object" && params[1] !== null ? params[1] : {}) as { limit?: number; before?: string };
        const newestFirst = [...this.history(link)].reverse();
        let start = 0;
        if (typeof options.before === "string") {
          const at = newestFirst.findIndex((tx) => tx.signature === options.before);
          start = at < 0 ? newestFirst.length : at + 1;
        }
        const limit = typeof options.limit === "number" ? options.limit : 1_000;
        return {
          result: newestFirst.slice(start, start + limit).map((tx) => ({
            signature: tx.signature,
            slot: tx.slot,
            err: null,
            memo: null,
            blockTime: Number(CHAIN_UNIX_SECONDS),
            confirmationStatus: "finalized",
          })),
        };
      }
      case "getTransaction": {
        const found = this.transactions.get(String(params[0]));
        return { result: found === undefined ? null : this.transactionJson(found.link, found.tx) };
      }
      case "getTokenAccountBalance":
        // AN ABSENT TOKEN ACCOUNT IS AN ERROR ON THE REAL WIRE, and balanceOf
        // (src/invest-tick.ts) catches exactly that and reads it as zero. The
        // round trip is spent either way, which is the part the bench counts.
        return { error: { code: -32602, message: "Invalid param: could not find account" } };
      case "sendTransaction":
      case "simulateTransaction":
      case "getSignatureStatuses":
        return { error: { code: -32003, message: WRITE_PATH_REFUSAL } };
      default:
        this.unmodelled.add(method);
        return {
          error: {
            code: -32601,
            message: `the ceiling bench's stubbed chain has no answer for ${method}; it is recorded and reported, never guessed at`,
          },
        };
    }
  }
}
