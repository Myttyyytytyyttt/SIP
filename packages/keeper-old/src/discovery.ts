// Who is this keeper responsible for? Ask the chain, not a database.
//
// `VaultFactory` emits `TradingAccountLinked` on every link and
// `TradingAccountUnlinked` on every unlink, for the WHOLE system
// (VaultFactory.sol:242, :254). So the complete, current set of (trading
// account, vault) pairs is derivable from one contract's logs — there is no
// user table to keep in sync, and nothing to migrate when a keeper is rebuilt
// from scratch.
//
// The logs are a HISTORY, not a state: an account can be linked, unlinked and
// linked again. Replaying them in order gives the latest intent, but the
// authority is `activeVaultOf`, which is read back for every candidate. A log
// this scan missed — a range cap, a reorg, an RPC that silently truncated —
// then shows up as a candidate whose on-chain state disagrees, and it is
// dropped rather than settled against a stale vault.

import { getAddress, parseAbi, type Address, type PublicClient } from "viem";

const FACTORY_EVENTS = parseAbi([
  "event TradingAccountLinked(address indexed tradingAccount, address indexed vault, bytes32 indexed vaultId)",
  "event TradingAccountUnlinked(address indexed tradingAccount, address indexed vault, bytes32 indexed vaultId)",
]);

const FACTORY_ABI = parseAbi(["function activeVaultOf(address) view returns (address)"]);

const ZERO = "0x0000000000000000000000000000000000000000";

export interface ManagedAccount {
  readonly account: Address;
  readonly vault: Address;
}

export interface DiscoveryResult {
  readonly accounts: readonly ManagedAccount[];
  /** Candidates seen in logs whose on-chain link no longer agrees. */
  readonly stale: readonly Address[];
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  /**
   * Every address this scan has ever seen named, for the caller to hand back on
   * the next call as `knownCandidates`.
   *
   * Carrying it is what makes an incremental scan equivalent to a full one — see
   * the note on `knownCandidates`. A caller that drops it is still correct, it
   * just pays for the whole history again.
   */
  readonly candidates: ReadonlySet<string>;
  /**
   * How many `eth_getLogs` calls the scan actually made.
   *
   * COUNTED, NOT DERIVED. The caller used to recompute it from the range, which
   * drifts at the boundaries — an empty range (the head moved backwards) runs the
   * loop zero times but the arithmetic says one. It is the number on the bill, so
   * it comes from the thing that made the calls.
   */
  readonly chunks: number;
}

export interface DiscoveryInput {
  readonly client: PublicClient;
  readonly factory: Address;
  /** Block the factory was deployed at. Scanning from 0 is a silent timeout. */
  readonly fromBlock: bigint;
  readonly toBlock?: bigint;
  /**
   * Largest span in one eth_getLogs call. Providers cap this and the cap is not
   * discoverable, so the scan is chunked rather than optimistic: a provider that
   * truncates a too-wide range returns FEWER accounts, which would look like
   * users leaving rather than like a failed read.
   */
  readonly maxSpan?: bigint;
  /**
   * Addresses earlier scans already saw, so this call only has to read the blocks
   * since the last one.
   *
   * WHY THIS IS SAFE, AND IT RESTS ON ONE PROPERTY: the candidate set only ever
   * GROWS. Both LINK and UNLINK add to it and nothing removes (see the loop
   * below), because deciding which is current is `activeVaultOf`'s job. A set
   * that never shrinks can be built incrementally and be byte-identical to one
   * built from the whole history — the union of the deltas IS the full scan.
   *
   * WHAT IT DOES NOT WEAKEN. Every candidate, old or new, is still confirmed
   * against `activeVaultOf` on every call, so an account unlinked in a range this
   * scan never looked at is still dropped. The authority is unchanged; only the
   * reading of history is cheaper.
   *
   * WHY IT MATTERS. Without it a caller sweeping every 60s re-reads the factory
   * from its deployment block forever: measured at 152 `eth_getLogs` per sweep
   * against the current factory — 218,880 a day — climbing by another 86 per
   * sweep every day, with no users at all. With it, a sweep reads the ~600 blocks
   * that are actually new: one call.
   */
  readonly knownCandidates?: ReadonlySet<string>;
}

/**
 * Where the next discovery scan starts, given where the last one finished.
 *
 * IT MUST NEVER RETURN A BLOCK ABOVE WHAT WAS ALREADY SCANNED. A gap here is the
 * worst shape of bug this module can have: the missed range holds a
 * `TradingAccountLinked` nobody ever reads again, so a real user is simply never
 * settled for, and every sweep afterwards reports a healthy, smaller `linked`
 * count. That is why this is a named function with its own tests rather than an
 * expression inside the sweep — it is four lines and it is load-bearing.
 *
 * `rescan` is overlap, not paranoia: it re-reads the tail so a link landing in a
 * block the watermark stepped over is still picked up.
 */
export function nextScanFrom(options: {
  /** The factory's deployment block. Never scan below it; there is nothing there. */
  readonly deployedAt: bigint;
  /** Head of the last successful scan, or null before the first one. */
  readonly scannedTo: bigint | null;
  readonly rescan: bigint;
}): bigint {
  if (options.scannedTo === null) return options.deployedAt;
  const back = options.scannedTo - options.rescan;
  return back < options.deployedAt ? options.deployedAt : back;
}

export async function discoverManagedAccounts(input: DiscoveryInput): Promise<DiscoveryResult> {
  const toBlock = input.toBlock ?? (await input.client.getBlockNumber());
  const maxSpan = input.maxSpan ?? 10_000n;

  // THE ENDPOINT MUST ACTUALLY HAVE `toBlock`, and this is checked before the
  // scan rather than assumed.
  //
  // `eth_getLogs` has no coverage receipt: a geth-family node whose head is below
  // the requested `toBlock` CLAMPS it and returns the shorter list with no error
  // and no indication it read less than asked. A caller that then records
  // `toBlock` as scanned has stepped over blocks nobody read — and because the
  // candidate set is carried forward, nothing re-reads them. A user who linked in
  // that window is never discovered, never settled for, and every sweep
  // afterwards reports a healthy, smaller count.
  //
  // It is reachable whenever the head and the logs can come from different nodes:
  // a fallback transport (viem's is per-request and stateless, so it restarts at
  // the primary for every call), or any URL that fronts a pool. One block read
  // costs one call per sweep and turns a silent short read into a refusal.
  const covered = await input.client
    .getBlock({ blockNumber: toBlock, includeTransactions: false })
    .catch(() => null);
  if (covered === null) {
    throw new Error(
      `The RPC endpoint does not have block ${toBlock}, so an eth_getLogs range ending there would ` +
        "be silently clamped to its own head and return fewer accounts than exist. Refusing to " +
        "report a scan that did not happen — the caller must not advance a watermark past this.",
    );
  }

  const candidates = new Set<string>(input.knownCandidates ?? []);
  let chunks = 0;
  for (let start = input.fromBlock; start <= toBlock; start += maxSpan) {
    chunks += 1;
    const end = start + maxSpan - 1n > toBlock ? toBlock : start + maxSpan - 1n;
    const logs = await input.client.getLogs({
      address: input.factory,
      events: FACTORY_EVENTS,
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs) {
      const account = log.args.tradingAccount;
      // Both LINK and UNLINK add a candidate. Resolving which is current is the
      // job of activeVaultOf below; treating an unlink as "forget it" here would
      // lose an account that was later re-linked in a range this loop already
      // passed.
      if (account) candidates.add(getAddress(account));
    }
  }

  const accounts: ManagedAccount[] = [];
  const stale: Address[] = [];
  for (const candidate of candidates) {
    const vault = (await input.client.readContract({
      address: input.factory,
      abi: FACTORY_ABI,
      functionName: "activeVaultOf",
      args: [candidate as Address],
    })) as Address;
    if (vault === ZERO) {
      stale.push(candidate as Address);
      continue;
    }
    accounts.push({ account: candidate as Address, vault: getAddress(vault) });
  }

  accounts.sort((a, b) => a.account.localeCompare(b.account));
  return { accounts, stale, fromBlock: input.fromBlock, toBlock, candidates, chunks };
}

/**
 * Which of these accounts actually did anything in the window.
 *
 * The deep per-account scan costs roughly one RPC call per block, so running it
 * for every managed account every tick makes cost linear in USERS rather than in
 * activity — the thing that stops this scaling. One `eth_getLogs` filtered on
 * all of their addresses at once is a single call that answers "who moved a
 * token", and only those need the expensive pass.
 *
 * It is a FILTER, never an authority: a wallet whose only activity was a native
 * transfer with no log emits nothing here. Callers must treat a miss as "no
 * evidence", which is why this returns a subset to prioritise and not a
 * permission to skip the rest forever.
 */
export async function accountsWithLogActivity(input: {
  readonly client: PublicClient;
  readonly accounts: readonly ManagedAccount[];
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
}): Promise<Set<Address>> {
  if (input.accounts.length === 0) return new Set();

  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const padded = input.accounts.map(
    (managed) => `0x${managed.account.slice(2).toLowerCase().padStart(64, "0")}` as const,
  );

  const active = new Set<Address>();
  const byTopic = new Map(input.accounts.map((m) => [m.account.toLowerCase(), m.account] as const));

  // Sender OR recipient: a sell moves the token out, a buy moves it in, and
  // either one means the wallet was trading.
  for (const position of [1, 2] as const) {
    const topics: (string | string[] | null)[] = [TRANSFER_TOPIC, null, null];
    topics[position] = padded as unknown as string[];
    const logs = await input.client.request({
      method: "eth_getLogs",
      params: [
        {
          fromBlock: `0x${input.fromBlock.toString(16)}`,
          toBlock: `0x${input.toBlock.toString(16)}`,
          topics,
        },
      ],
    } as never);

    for (const log of logs as { topics: string[] }[]) {
      const topic = log.topics[position];
      if (!topic) continue;
      const address = `0x${topic.slice(26)}`.toLowerCase();
      const known = byTopic.get(address);
      if (known) active.add(known);
    }
  }

  return active;
}
