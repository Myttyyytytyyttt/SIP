// What has actually happened to this vault — read from the CHAIN.
//
// WHY NOT THE READ MODEL. There is one (nuvem_solana in Postgres, written by
// the supervisor), and it holds richer rows than this can derive — measured
// profit alongside the contribution, for instance. But it is an optional
// mirror: no DATABASE_URL, a schema never created, a keeper that has not run
// since a settlement, and it is silently empty. A savings product whose history
// screen is blank because a database is misconfigured tells the user their
// money did nothing. The chain cannot be blank, because the chain is where the
// money actually moved.
//
// So this is the FLOOR, not the ceiling: always available, derived from
// consensus data, and correct even on a deployment with no database at all. The
// read model enriches; it is never the only source.
//
// HOW EACH EVENT IS RECOGNISED. Anchor emits "Program log: Instruction: <Name>"
// for every handler, so the instruction name comes from the transaction's own
// logs rather than from decoding instruction data twice. The AMOUNTS come from
// pre/post balances — consensus metadata about exactly this transaction — never
// from the logs, which are free text a program could write anything into.

import { type SolanaRead, type SolanaStock, tryBase58Decode } from "./solana";
import { poolRpc, poolRpcBatch } from "./rpc-pool";

export type ActivityKind =
  /** The keeper moved a share of realised profit into the vault. */
  | "settled"
  /** The vault bought a stock. */
  | "invested"
  /** SOL became USDC on the way to a purchase. */
  | "converted"
  /** SOL was wrapped for the pipeline. Plumbing, shown for completeness. */
  | "wrapped"
  /** The owner took something out. */
  | "withdrew"
  /** The owner (or anyone) sent SOL straight to the vault. */
  | "deposited"
  /** The owner changed the basket or the savings rate. */
  | "configured"
  /** A token account was opened so the pipeline had somewhere to put things. */
  | "prepared"
  /** A vault transaction this reader does not classify. Never hidden. */
  | "other";

export interface ActivityEvent {
  readonly signature: string;
  readonly slot: number;
  /** Unix seconds, or null when the node did not report a block time. */
  readonly at: number | null;
  readonly kind: ActivityKind;
  /** The instruction names the transaction logged, for the curious. */
  readonly instructions: readonly string[];
  /** Lamport change of the vault account itself. */
  readonly solDelta: string;
  /** Token changes of vault-owned accounts, biggest first. */
  readonly tokenDeltas: readonly {
    readonly mint: string;
    readonly symbol: string | null;
    readonly rawDelta: string;
    readonly decimals: number;
  }[];
  readonly failed: boolean;
}

/**
 * The instruction name that decides an event's kind.
 *
 * ORDER MATTERS: an invest transaction logs Invest AND the venue's SwapV2 and
 * TransferChecked, so the vault's own instruction has to win. Anything not
 * listed falls through to a deposit test and then to "other" — which is
 * DELIBERATELY still shown. A history that hides what it cannot name is a
 * history a user cannot trust.
 */
const KIND_BY_INSTRUCTION: readonly (readonly [string, ActivityKind])[] = [
  ["Settle", "settled"],
  ["Invest", "invested"],
  ["Convert", "converted"],
  ["WrapSol", "wrapped"],
  ["WithdrawToken", "withdrew"],
  ["Withdraw", "withdrew"],
  ["SetInvestPolicy", "configured"],
  ["SetPolicy", "configured"],
  ["CreateVault", "configured"],
  ["LinkWallet", "configured"],
  ["UnlinkWallet", "configured"],
  // The Associated Token Program's own instructions, logged when the keeper (or
  // a withdrawal) opens an account for a mint. Plumbing, but nameable — and
  // naming it beats leaving a row the user cannot interpret.
  ["InitializeAccount3", "prepared"],
  ["InitializeImmutableOwner", "prepared"],
  ["GetAccountDataSize", "prepared"],
];

/**
 * Which kinds moved the user's money, as opposed to arranging the plumbing.
 * The UI leads with these; the rest stays available rather than hidden.
 */
export const MONEY_KINDS: readonly ActivityKind[] = ["settled", "invested", "withdrew", "deposited"];

interface RpcTransaction {
  readonly slot: number;
  readonly blockTime?: number | null;
  readonly meta: {
    readonly err: unknown;
    readonly logMessages?: readonly string[] | null;
    readonly preBalances: readonly number[];
    readonly postBalances: readonly number[];
    readonly preTokenBalances?: readonly TokenBalance[] | null;
    readonly postTokenBalances?: readonly TokenBalance[] | null;
    readonly loadedAddresses?: { readonly writable?: readonly string[]; readonly readonly?: readonly string[] } | null;
  } | null;
  readonly transaction: {
    readonly message: {
      readonly accountKeys?: readonly (string | { readonly pubkey: string })[];
      readonly staticAccountKeys?: readonly string[];
    };
  };
}

interface TokenBalance {
  readonly owner?: string;
  readonly mint: string;
  readonly uiTokenAmount: { readonly amount: string; readonly decimals: number };
}

async function rpc(urls: readonly string[], method: string, params: unknown[]): Promise<unknown> {
  return poolRpc(urls, method, params);
}

/**
 * Fetches many transactions in ONE HTTP request per 25, instead of one each.
 *
 * WHY IT EXISTS. Both readers below used to `await rpc(...)` inside a for loop
 * over the signature list, so a single activity request made up to 41 sequential
 * round trips and one page view — activity plus stats plus the portfolio — ran
 * to well over a hundred. That is enough to rate-limit a Solana RPC key on its
 * own, and it did: nuvem.fund answered "the vault could not be read" on every
 * request while the very same endpoint answered instantly from a laptop. A site
 * that DoSes its own RPC key looks exactly like a chain outage.
 *
 * ORDER IS NOT PROMISED in a JSON-RPC batch response, so results are matched by
 * `id` and returned as a map. A missing or errored member is `null`, the same
 * value a single fetch gives for an unknown signature, so callers that already
 * skip nulls need no new branch.
 */
async function getTransactions(
  urls: readonly string[],
  signatures: readonly string[],
): Promise<ReadonlyMap<string, RpcTransaction | null>> {
  const out = new Map<string, RpcTransaction | null>();
  const CHUNK = 25;
  for (let start = 0; start < signatures.length; start += CHUNK) {
    const chunk = signatures.slice(start, start + CHUNK);
    const members = await poolRpcBatch(
      urls,
      chunk.map((signature, index) => ({
        id: index,
        method: "getTransaction",
        params: [signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
      })),
    );
    for (const member of members) {
      const signature = typeof member.id === "number" ? chunk[member.id] : undefined;
      if (signature === undefined) continue;
      out.set(signature, (member.result ?? null) as RpcTransaction | null);
    }
    // A member the batch simply did not return is `null`, the same value a
    // single fetch gives for an unknown signature, so no caller needs a branch.
    for (const signature of chunk) if (!out.has(signature)) out.set(signature, null);
  }
  return out;
}

/**
 * The vault's activity, newest first.
 *
 * `limit` caps the SIGNATURES fetched, not the events returned — and the cap is
 * reported back, because a truncated history that does not say so is a history
 * that quietly claims a vault has done less than it has.
 */
export async function readSolanaActivity(
  config: { rpcUrls: readonly string[]; programId: string },
  vaultAddress: string,
  stocks: readonly SolanaStock[] = [],
  limit = 40,
): Promise<SolanaRead<{ readonly events: readonly ActivityEvent[]; readonly truncated: boolean }>> {
  const decoded = tryBase58Decode(vaultAddress);
  if (decoded === null || decoded.length !== 32) {
    return { ok: false, error: "not a base58 32-byte address" };
  }

  try {
    const signatures = (await rpc(config.rpcUrls, "getSignaturesForAddress", [
      vaultAddress,
      { limit },
    ])) as readonly { signature: string; slot: number; blockTime?: number | null; err: unknown }[];

    const fetched = await getTransactions(config.rpcUrls, signatures.map((entry) => entry.signature));

    const events: ActivityEvent[] = [];
    for (const entry of signatures) {
      const tx = fetched.get(entry.signature) ?? null;
      if (tx?.meta == null) continue;

      const instructions = (tx.meta.logMessages ?? [])
        .filter((line) => line.startsWith("Program log: Instruction: "))
        .map((line) => line.slice("Program log: Instruction: ".length));

      // The vault's own lamport delta, from consensus metadata.
      const staticKeys = (tx.transaction.message.accountKeys ?? tx.transaction.message.staticAccountKeys ?? []).map(
        (key) => (typeof key === "string" ? key : key.pubkey),
      );
      const keys = [
        ...staticKeys,
        ...(tx.meta.loadedAddresses?.writable ?? []),
        ...(tx.meta.loadedAddresses?.readonly ?? []),
      ];
      const index = keys.indexOf(vaultAddress);
      const solDelta =
        index >= 0 && index < tx.meta.preBalances.length
          ? BigInt(tx.meta.postBalances[index] ?? 0) - BigInt(tx.meta.preBalances[index] ?? 0)
          : 0n;

      // Token deltas for accounts the VAULT owns — a swap moves the pool's
      // accounts too, and those are not the user's position.
      const before = new Map<string, TokenBalance>();
      for (const balance of tx.meta.preTokenBalances ?? []) {
        if (balance.owner === vaultAddress) before.set(balance.mint, balance);
      }
      const after = new Map<string, TokenBalance>();
      for (const balance of tx.meta.postTokenBalances ?? []) {
        if (balance.owner === vaultAddress) after.set(balance.mint, balance);
      }
      const tokenDeltas: ActivityEvent["tokenDeltas"] = [...new Set([...before.keys(), ...after.keys()])]
        .map((mint) => {
          const pre = BigInt(before.get(mint)?.uiTokenAmount.amount ?? "0");
          const post = BigInt(after.get(mint)?.uiTokenAmount.amount ?? "0");
          const decimals = (after.get(mint) ?? before.get(mint))?.uiTokenAmount.decimals ?? 0;
          return { mint, symbol: stocks.find((s) => s.mint === mint)?.symbol ?? null, rawDelta: (post - pre).toString(), decimals };
        })
        .filter((delta) => delta.rawDelta !== "0")
        .sort((a, b) => (BigInt(b.rawDelta) > BigInt(a.rawDelta) ? 1 : -1));

      let kind: ActivityKind = "other";
      for (const [name, candidate] of KIND_BY_INSTRUCTION) {
        if (instructions.includes(name)) {
          kind = candidate;
          break;
        }
      }
      // A transaction that named none of our instructions but PAID the vault is
      // someone topping it up — the tester's own manual deposits look exactly
      // like this, and calling them "other" would be unhelpful and slightly
      // wrong.
      if (kind === "other" && solDelta > 0n) kind = "deposited";

      events.push({
        signature: entry.signature,
        slot: entry.slot,
        at: entry.blockTime ?? null,
        kind,
        instructions,
        solDelta: solDelta.toString(),
        tokenDeltas,
        failed: entry.err !== null,
      });
    }

    return { ok: true, value: { events, truncated: signatures.length >= limit } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** What one trading wallet has been up to, measured — never estimated. */
export interface SolanaWalletStats {
  /** Unix seconds of the newest transaction, or null when it never moved. */
  readonly lastUsedAt: number | null;
  /** Transactions inspected for the figures below. */
  readonly txCount: number;
  /** True when the history is longer than the window inspected. */
  readonly truncated: boolean;
  /** Σ |wallet lamport delta| across inspected successful txs — activity, not PnL. */
  readonly volumeLamports: string;
  /** Σ of the VAULT's positive lamport delta in Settle txs among those inspected. */
  readonly settledToVaultLamports: string;
  /** Settle transactions seen in the window. The LINK's nonce is the lifetime total. */
  readonly settleCount: number;
}

/**
 * Per-wallet stats from the wallet's own recent transactions.
 *
 * EVERY FIGURE IS A MEASUREMENT over the inspected window, and `truncated`
 * says when that window is not the whole story — "volume" here is lamports
 * MOVED (in plus out, absolute), which is activity, deliberately not PnL.
 * "Settled to vault" is attributed the only way that cannot lie: the vault's
 * own balance delta in transactions that ran the Settle instruction and
 * involved this wallet.
 */
export async function readSolanaWalletStats(
  config: { rpcUrls: readonly string[] },
  wallet: string,
  vaultAddress: string,
  limit = 25,
): Promise<SolanaRead<SolanaWalletStats>> {
  for (const address of [wallet, vaultAddress]) {
    const decoded = tryBase58Decode(address);
    if (decoded === null || decoded.length !== 32) {
      return { ok: false, error: "not a base58 32-byte address" };
    }
  }

  try {
    const signatures = (await rpc(config.rpcUrls, "getSignaturesForAddress", [
      wallet,
      { limit },
    ])) as readonly { signature: string; slot: number; blockTime?: number | null; err: unknown }[];

    let volume = 0n;
    let settled = 0n;
    let settleCount = 0;
    let inspected = 0;

    // Failed transactions moved nothing, so they are dropped BEFORE the fetch
    // rather than after — a batch should not carry what it will discard.
    const wanted = signatures.filter((entry) => entry.err === null);
    const fetched = await getTransactions(config.rpcUrls, wanted.map((entry) => entry.signature));

    for (const entry of wanted) {
      const tx = fetched.get(entry.signature) ?? null;
      if (tx?.meta == null) continue;
      inspected += 1;

      const staticKeys = (tx.transaction.message.accountKeys ?? tx.transaction.message.staticAccountKeys ?? []).map(
        (key) => (typeof key === "string" ? key : key.pubkey),
      );
      const keys = [
        ...staticKeys,
        ...(tx.meta.loadedAddresses?.writable ?? []),
        ...(tx.meta.loadedAddresses?.readonly ?? []),
      ];

      const deltaAt = (address: string): bigint => {
        const index = keys.indexOf(address);
        return index >= 0 && index < tx.meta!.preBalances.length
          ? BigInt(tx.meta!.postBalances[index] ?? 0) - BigInt(tx.meta!.preBalances[index] ?? 0)
          : 0n;
      };

      const walletDelta = deltaAt(wallet);
      volume += walletDelta < 0n ? -walletDelta : walletDelta;

      const instructions = (tx.meta.logMessages ?? [])
        .filter((line) => line.startsWith("Program log: Instruction: "))
        .map((line) => line.slice("Program log: Instruction: ".length));
      if (instructions.includes("Settle")) {
        const vaultDelta = deltaAt(vaultAddress);
        if (vaultDelta > 0n) {
          settled += vaultDelta;
          settleCount += 1;
        }
      }
    }

    return {
      ok: true,
      value: {
        lastUsedAt: signatures[0]?.blockTime ?? null,
        txCount: inspected,
        truncated: signatures.length >= limit,
        volumeLamports: volume.toString(),
        settledToVaultLamports: settled.toString(),
        settleCount,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
