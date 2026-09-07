import { describe, expect, it } from "vitest";
import type { Address, PublicClient } from "viem";

import { accountsWithLogActivity, discoverManagedAccounts, nextScanFrom } from "../src/discovery.js";

const FACTORY = "0x2a6a5d51677aA52674DF1380a5743fBf601ca9b0" as Address;
const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const C = "0x3333333333333333333333333333333333333333" as Address;
const VAULT_A = "0xaAaa1111111111111111111111111111111111Aa" as Address;
const VAULT_B = "0xBbBb2222222222222222222222222222222222bB" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * A stub whose logs live at BLOCK NUMBERS, so an incremental scan sees only what
 * its range covers.
 *
 * The plain `stubClient` below returns the same logs for every range, which is
 * fine for testing chunking and cannot test a watermark at all: it makes any
 * range look like the whole history. Every incremental assertion needs this one.
 */
function stubChain(options: {
  linkedAt: { block: bigint; tradingAccount: Address }[];
  activeVaultOf: Record<string, string>;
  /** The endpoint's own head. Below a requested toBlock, it has clamped. */
  head?: bigint;
}) {
  const calls = { getLogs: 0, readContract: 0, getBlock: 0, ranges: [] as [bigint, bigint][] };
  const head = options.head ?? 1_000n;
  const client = {
    async getBlockNumber() {
      return head;
    },
    // A node only has blocks up to its own head. viem throws for a missing one.
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      calls.getBlock += 1;
      if (blockNumber > head) throw new Error(`Block at number "${blockNumber}" could not be found.`);
      return { number: blockNumber };
    },
    async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
      calls.getLogs += 1;
      calls.ranges.push([fromBlock, toBlock]);
      return options.linkedAt
        .filter((l) => l.block >= fromBlock && l.block <= toBlock)
        .map((l) => ({ args: { tradingAccount: l.tradingAccount } }));
    },
    async readContract({ args }: { args: readonly unknown[] }) {
      calls.readContract += 1;
      return options.activeVaultOf[String(args[0])] ?? ZERO;
    },
  } as unknown as PublicClient;
  return { client, calls };
}

/** A PublicClient stub that records what was asked of it. */
function stubClient(options: {
  logs: { tradingAccount: Address }[];
  activeVaultOf: Record<string, string>;
  head?: bigint;
  rawLogs?: { topics: string[] }[];
}) {
  const calls = { getLogs: 0, readContract: 0, request: 0, ranges: [] as [bigint, bigint][] };
  const client = {
    async getBlockNumber() {
      return options.head ?? 1_000n;
    },
    async getBlock({ blockNumber }: { blockNumber: bigint }) {
      if (blockNumber > (options.head ?? 1_000n)) throw new Error("not found");
      return { number: blockNumber };
    },
    async getLogs({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) {
      calls.getLogs += 1;
      calls.ranges.push([fromBlock, toBlock]);
      return options.logs.map((log) => ({ args: log }));
    },
    async readContract({ args }: { args: readonly unknown[] }) {
      calls.readContract += 1;
      const account = String(args[0]);
      return options.activeVaultOf[account] ?? ZERO;
    },
    async request() {
      calls.request += 1;
      return options.rawLogs ?? [];
    },
  } as unknown as PublicClient;
  return { client, calls };
}

describe("discovering who the keeper is responsible for", () => {
  it("finds every linked account and the vault it currently belongs to", async () => {
    const { client } = stubClient({
      logs: [{ tradingAccount: A }, { tradingAccount: B }],
      activeVaultOf: { [A]: VAULT_A, [B]: VAULT_B },
    });

    const result = await discoverManagedAccounts({ client, factory: FACTORY, fromBlock: 0n, toBlock: 100n });

    expect(result.accounts).toEqual([
      { account: A, vault: VAULT_A },
      { account: B, vault: VAULT_B },
    ]);
    expect(result.stale).toEqual([]);
  });

  /**
   * THE ONE THAT MATTERS. The logs are history; `activeVaultOf` is truth. An
   * account that was linked and later unlinked still appears in the log scan,
   * and settling against the vault it USED to belong to would be a settlement
   * into a stranger's savings.
   */
  it("drops an account the chain no longer links, however it appeared in the logs", async () => {
    const { client } = stubClient({
      logs: [{ tradingAccount: A }, { tradingAccount: C }],
      activeVaultOf: { [A]: VAULT_A }, // C was unlinked
    });

    const result = await discoverManagedAccounts({ client, factory: FACTORY, fromBlock: 0n, toBlock: 100n });

    expect(result.accounts).toEqual([{ account: A, vault: VAULT_A }]);
    expect(result.stale).toEqual([C]);
  });

  it("re-links an account that was unlinked and linked again", async () => {
    // Both events name the same account; only the current state decides.
    const { client } = stubClient({
      logs: [{ tradingAccount: A }, { tradingAccount: A }],
      activeVaultOf: { [A]: VAULT_B },
    });

    const result = await discoverManagedAccounts({ client, factory: FACTORY, fromBlock: 0n, toBlock: 100n });

    expect(result.accounts).toEqual([{ account: A, vault: VAULT_B }]);
  });

  /**
   * Providers cap eth_getLogs ranges and the cap is not discoverable. A single
   * over-wide call would come back truncated, and truncation here reads as
   * "these users no longer exist" rather than as an error.
   */
  it("chunks the scan so a provider range cap cannot silently hide users", async () => {
    const { client, calls } = stubClient({ logs: [], activeVaultOf: {}, head: 25_000n });

    await discoverManagedAccounts({
      client,
      factory: FACTORY,
      fromBlock: 0n,
      toBlock: 25_000n,
      maxSpan: 10_000n,
    });

    expect(calls.getLogs).toBe(3);
    expect(calls.ranges).toEqual([
      [0n, 9_999n],
      [10_000n, 19_999n],
      [20_000n, 25_000n],
    ]);
  });

  it("covers the final block of the range, not one short of it", async () => {
    const { client, calls } = stubClient({ logs: [], activeVaultOf: {} });
    await discoverManagedAccounts({ client, factory: FACTORY, fromBlock: 100n, toBlock: 100n });
    expect(calls.ranges).toEqual([[100n, 100n]]);
  });
});

// Reading the history once instead of every sixty seconds.
//
// The supervisor used to pass the factory's deployment block on every sweep, so
// it re-read the whole chain forever: 152 `eth_getLogs` a sweep, 218,880 a day,
// growing, with no users. These tests exist to prove the cheap version answers
// IDENTICALLY, because the failure they guard against does not look like a
// failure — a sweep that silently finds fewer accounts reads as users leaving.
describe("scanning only what is new", () => {
  const linkedAt = [
    { block: 100n, tradingAccount: A },
    { block: 900n, tradingAccount: B },
  ];
  const activeVaultOf = { [A]: VAULT_A, [B]: VAULT_B };

  /**
   * THE ONE THAT MATTERS. Two sweeps over disjoint halves, carrying the candidate
   * set, must equal one sweep over the whole range. If this ever fails, an
   * incremental sweep is losing accounts.
   */
  it("gives the same answer as re-reading the whole history", async () => {
    const full = await discoverManagedAccounts({
      client: stubChain({ linkedAt, activeVaultOf }).client,
      factory: FACTORY,
      fromBlock: 0n,
      toBlock: 1_000n,
    });

    const { client } = stubChain({ linkedAt, activeVaultOf });
    const first = await discoverManagedAccounts({ client, factory: FACTORY, fromBlock: 0n, toBlock: 500n });
    const second = await discoverManagedAccounts({
      client,
      factory: FACTORY,
      fromBlock: 501n,
      toBlock: 1_000n,
      knownCandidates: first.candidates,
    });

    expect(second.accounts).toEqual(full.accounts);
    expect(second.accounts).toEqual([
      { account: A, vault: VAULT_A },
      { account: B, vault: VAULT_B },
    ]);
  });

  /**
   * A LINK IN A RANGE THIS SCAN NEVER LOOKED AT still produces an account. This
   * is the property the whole optimisation rests on: the set is carried, so old
   * history does not have to be re-read to keep an old user.
   */
  it("keeps an account whose only log is far behind the scanned range", async () => {
    const { client, calls } = stubChain({ linkedAt, activeVaultOf });
    const result = await discoverManagedAccounts({
      client,
      factory: FACTORY,
      fromBlock: 995n,
      toBlock: 1_000n,
      knownCandidates: new Set([A, B]),
    });

    expect(result.accounts).toEqual([
      { account: A, vault: VAULT_A },
      { account: B, vault: VAULT_B },
    ]);
    // One call, for six blocks — not 100 for the history.
    expect(calls.getLogs).toBe(1);
    expect(calls.ranges).toEqual([[995n, 1_000n]]);
  });

  /**
   * THE AUTHORITY IS UNCHANGED. Carrying a candidate must not carry a stale
   * LINK: an account unlinked in a range nobody re-read is still dropped,
   * because `activeVaultOf` is asked afresh for every candidate every time.
   * Settling against a vault someone used to own is the failure this prevents.
   */
  it("still drops a carried account the chain no longer links", async () => {
    const { client, calls } = stubChain({ linkedAt, activeVaultOf: { [A]: VAULT_A } });
    const result = await discoverManagedAccounts({
      client,
      factory: FACTORY,
      fromBlock: 995n,
      toBlock: 1_000n,
      knownCandidates: new Set([A, B]),
    });

    expect(result.accounts).toEqual([{ account: A, vault: VAULT_A }]);
    expect(result.stale).toEqual([B]);
    // Both carried candidates were re-confirmed, not just the freshly seen one.
    expect(calls.readContract).toBe(2);
  });

  it("returns the union of what it carried and what it just read", async () => {
    const { client } = stubChain({ linkedAt, activeVaultOf });
    const result = await discoverManagedAccounts({
      client,
      factory: FACTORY,
      fromBlock: 800n,
      toBlock: 1_000n,
      knownCandidates: new Set([A]),
    });
    expect([...result.candidates].sort()).toEqual([A, B].sort());
  });

  it("carries nothing when given nothing, so the old behaviour is untouched", async () => {
    const { client } = stubChain({ linkedAt, activeVaultOf });
    const result = await discoverManagedAccounts({ client, factory: FACTORY, fromBlock: 0n, toBlock: 1_000n });
    expect([...result.candidates].sort()).toEqual([A, B].sort());
  });
});

// Refusing a scan the endpoint cannot actually answer.
//
// THIS IS THE ONE THAT LOSES USERS. `eth_getLogs` has no coverage receipt: a
// geth-family node whose head is below the requested `toBlock` clamps it and
// returns the shorter list with NO error. Combined with a watermark, that short
// read becomes permanent — nothing re-reads the range, so a user who linked in it
// is never discovered, never settled for, and every sweep afterwards reports a
// healthy smaller count.
//
// It became reachable the moment the head and the logs could come from different
// nodes: viem's `fallback` is per-request and stateless, so `eth_blockNumber` can
// be answered by a primary at its cost cap while the expensive `eth_getLogs` falls
// through to a public endpoint thousands of blocks behind.
describe("refusing to scan past what the endpoint has", () => {
  const linkedAt = [{ block: 100n, tradingAccount: A }];
  const activeVaultOf = { [A]: VAULT_A };

  /** The live shape: another node's head, handed to a lagging endpoint. */
  it("throws rather than reporting a clamped read as complete", async () => {
    const { client } = stubChain({ linkedAt, activeVaultOf, head: 1_000n });
    await expect(
      discoverManagedAccounts({ client, factory: FACTORY, fromBlock: 0n, toBlock: 6_000n }),
    ).rejects.toThrow(/does not have block 6000/);
  });

  /**
   * IT MUST THROW, NOT RETURN EMPTY. A resolved call is what lets the caller
   * advance its watermark; only a throw leaves it where it was.
   */
  it("refuses before reading any logs, so nothing looks like a successful scan", async () => {
    const { client, calls } = stubChain({ linkedAt, activeVaultOf, head: 1_000n });
    await expect(
      discoverManagedAccounts({ client, factory: FACTORY, fromBlock: 0n, toBlock: 6_000n }),
    ).rejects.toThrow();
    expect(calls.getLogs).toBe(0);
  });

  it("says which block is missing and why it matters", async () => {
    const { client } = stubChain({ linkedAt, activeVaultOf, head: 1_000n });
    const error = await discoverManagedAccounts({
      client,
      factory: FACTORY,
      fromBlock: 0n,
      toBlock: 6_000n,
    }).catch((e: Error) => e);
    expect(String(error)).toContain("6000");
    expect(String(error)).toContain("clamped");
    expect(String(error)).toContain("watermark");
  });

  it("accepts a range the endpoint does have", async () => {
    const { client } = stubChain({ linkedAt, activeVaultOf, head: 1_000n });
    const result = await discoverManagedAccounts({ client, factory: FACTORY, fromBlock: 0n, toBlock: 1_000n });
    expect(result.accounts).toEqual([{ account: A, vault: VAULT_A }]);
  });

  /** Omitting toBlock reads the head through the SAME client, so it always fits. */
  it("is satisfied by its own head read when no toBlock is given", async () => {
    const { client } = stubChain({ linkedAt, activeVaultOf, head: 1_000n });
    const result = await discoverManagedAccounts({ client, factory: FACTORY, fromBlock: 0n });
    expect(result.toBlock).toBe(1_000n);
    expect(result.accounts).toEqual([{ account: A, vault: VAULT_A }]);
  });
});

describe("counting the calls it made", () => {
  const linkedAt = [{ block: 100n, tradingAccount: A }];
  const activeVaultOf = { [A]: VAULT_A };

  it("reports the number of eth_getLogs calls, counted not derived", async () => {
    const { client, calls } = stubChain({ linkedAt, activeVaultOf, head: 25_000n });
    const result = await discoverManagedAccounts({
      client,
      factory: FACTORY,
      fromBlock: 0n,
      toBlock: 25_000n,
      maxSpan: 10_000n,
    });
    expect(result.chunks).toBe(3);
    expect(result.chunks).toBe(calls.getLogs);
  });

  /**
   * THE BOUNDARY THE DERIVED VERSION GOT WRONG. An empty range — the head moved
   * backwards, so scanFrom is above toBlock — runs the loop zero times, but
   * `(toBlock - scanFrom) / maxSpan + 1` says one.
   */
  it("reports zero for a range that read nothing", async () => {
    const { client, calls } = stubChain({ linkedAt, activeVaultOf, head: 1_000n });
    const result = await discoverManagedAccounts({ client, factory: FACTORY, fromBlock: 900n, toBlock: 800n });
    expect(result.chunks).toBe(0);
    expect(calls.getLogs).toBe(0);
  });

  it("counts one for a single-block range", async () => {
    const { client } = stubChain({ linkedAt, activeVaultOf, head: 1_000n });
    const result = await discoverManagedAccounts({ client, factory: FACTORY, fromBlock: 500n, toBlock: 500n });
    expect(result.chunks).toBe(1);
  });

  it("counts one when the span is exactly maxSpan", async () => {
    const { client } = stubChain({ linkedAt, activeVaultOf, head: 20_000n });
    const result = await discoverManagedAccounts({
      client,
      factory: FACTORY,
      fromBlock: 0n,
      toBlock: 9_999n,
      maxSpan: 10_000n,
    });
    expect(result.chunks).toBe(1);
  });
});

// Where the next scan starts.
//
// Four lines of arithmetic, and the only way it can be wrong is the expensive
// way: a block nobody ever reads again holds a link, that user is never settled
// for, and every sweep afterwards reports a healthy smaller count. Cheapness is
// not what is being tested here — never skipping is.
describe("advancing the discovery watermark", () => {
  const DEPLOYED = 37_531_900n;
  const RESCAN = 2_000n;

  it("starts at the factory's deployment block when nothing has been scanned", () => {
    expect(nextScanFrom({ deployedAt: DEPLOYED, scannedTo: null, rescan: RESCAN })).toBe(DEPLOYED);
  });

  /** THE INVARIANT. Always at or below what was scanned, so there is never a gap. */
  it("never starts above what was already scanned, at any distance", () => {
    for (const scannedTo of [DEPLOYED, DEPLOYED + 1n, DEPLOYED + 1_999n, DEPLOYED + 2_000n, DEPLOYED + 10n ** 7n]) {
      const next = nextScanFrom({ deployedAt: DEPLOYED, scannedTo, rescan: RESCAN });
      expect(next, `scannedTo ${scannedTo}`).toBeLessThanOrEqual(scannedTo);
      expect(next, `scannedTo ${scannedTo}`).toBeGreaterThanOrEqual(DEPLOYED);
    }
  });

  it("re-reads exactly the overlap once there is room for it", () => {
    const scannedTo = DEPLOYED + 500_000n;
    expect(nextScanFrom({ deployedAt: DEPLOYED, scannedTo, rescan: RESCAN })).toBe(scannedTo - RESCAN);
  });

  /**
   * Below the deployment block there is nothing to find, and a negative
   * fromBlock is an RPC error rather than an empty result.
   */
  it("clamps to the deployment block rather than reaching below it", () => {
    expect(nextScanFrom({ deployedAt: DEPLOYED, scannedTo: DEPLOYED + 5n, rescan: RESCAN })).toBe(DEPLOYED);
    expect(nextScanFrom({ deployedAt: 0n, scannedTo: 10n, rescan: RESCAN })).toBe(0n);
  });

  /** Zero overlap is legal and means "resume exactly", which is still no gap. */
  it("accepts a zero overlap without stepping over anything", () => {
    const scannedTo = DEPLOYED + 500n;
    expect(nextScanFrom({ deployedAt: DEPLOYED, scannedTo, rescan: 0n })).toBe(scannedTo);
  });
});

describe("the activity prefilter", () => {
  const managed = [
    { account: A, vault: VAULT_A },
    { account: B, vault: VAULT_B },
  ];

  it("returns only the accounts a Transfer log actually names", async () => {
    const topicFor = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
    const { client } = stubClient({
      logs: [],
      activeVaultOf: {},
      rawLogs: [{ topics: ["0xddf2", topicFor(B), topicFor(C)] }],
    });

    const active = await accountsWithLogActivity({ client, accounts: managed, fromBlock: 0n, toBlock: 10n });

    // B matched as sender; C is not managed and must not appear.
    expect([...active]).toEqual([B]);
  });

  it("costs nothing when there is nobody to filter", async () => {
    const { client, calls } = stubClient({ logs: [], activeVaultOf: {} });
    const active = await accountsWithLogActivity({ client, accounts: [], fromBlock: 0n, toBlock: 10n });
    expect(active.size).toBe(0);
    expect(calls.request).toBe(0);
  });

  /**
   * The filter is an optimisation, not an authority: a wallet whose only
   * activity was a native transfer emits no Transfer log at all. Anything built
   * on this must treat an absence as "no evidence", never as "nothing happened".
   */
  it("says nothing about a wallet that moved only native ETH", async () => {
    const { client } = stubClient({ logs: [], activeVaultOf: {}, rawLogs: [] });
    const active = await accountsWithLogActivity({ client, accounts: managed, fromBlock: 0n, toBlock: 10n });
    expect(active.size).toBe(0);
  });
});
