// What a busy wallet costs the sweep, and the walk cache, which keeps what a walk
// read between sweeps.
//
// MEASURED OVER THE FAKE LEDGER ON 2026-10-08, before the cache existed. A span
// that did not settle had its whole window (the anchor and the oldest prefix above
// the frontier) fetched again on every turn: a losing wallet that only trades, up
// to 101 transactions a turn while it rested at NO_PROFIT (99 trades, its last
// settle and the anchor); a stranger's 299 dust transfers, 300; and a link that
// had settled once fetched its own settle and anchor again. A backlog of 1,200
// cost 2 signature pages and 301 getTransaction on its first turn, one at a time:
// 6-12 s of a 60 s sweep for one wallet, extrapolated from the 21-40 ms a call
// production's triage measured that day.
//
// THE RULE: when both read the whole window, a cached walk measures exactly what
// an uncached one measures. (A cached walk does not ask the RPC for what it holds,
// so where the RPC would answer null for such a transaction, it measures from the
// finalized read it kept and an uncached walk is INCOMPLETE.) Most tests here also
// pin what a walk fetches: what the cache does not hold.

import { Keypair, PublicKey, type Finality } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { tradeNotional } from "../src/measure-volume.js";
import { MAX_SIGNATURES, WalkCache, measureSince, type TxFacts, type WindowMeasurement } from "../src/measure-window.js";
import { MODE_PROFIT } from "../src/program-scripts.js";
import { decideFromMeasurement, defaultVolumeBase } from "../src/settle-decision.js";
import { walkSweepReport } from "../src/sweep-cost.js";
import { FakeLedger, type LedgerEntry } from "./fake-ledger.js";

const SYSTEM = "11111111111111111111111111111111";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const ED25519 = "Ed25519SigVerify111111111111111111111111111";
const FLOW = [SYSTEM];
const TRADE = [JUPITER, SYSTEM];
const SETTLE = [ED25519, SIP_PROGRAM_ID, SYSTEM];

const wallet = Keypair.generate().publicKey;
const stranger = Keypair.generate().publicKey;
const settleProgram = new PublicKey(SIP_PROGRAM_ID);
const ctx = (from: bigint) => ({ from, finalizedSlot: 10n ** 12n, mode: MODE_PROFIT, volumeBase: defaultVolumeBase, carry: null });

/** A wallet's history, appended to as the chain executes it: one transaction a slot, balances chained. */
class History {
  readonly entries: LedgerEntry[] = [];
  #balance = 10_000_000_000;
  #slot = 1_000;
  constructor(readonly owner: PublicKey = wallet) {}
  add(programs: readonly string[], delta: number, over: Partial<Pick<LedgerEntry, "signers" | "err">> = {}): LedgerEntry {
    this.#slot += 1;
    const entry = { signature: `tx-${this.#slot}`, slot: this.#slot, pre: this.#balance, post: this.#balance + delta, programs, ...over };
    this.entries.push(entry);
    this.#balance += delta;
    return entry;
  }
  get slot(): bigint {
    return BigInt(this.#slot);
  }
  /** The ledger as one sweep reads it: a fresh one, so its recorded calls are that sweep's alone. */
  ledger(unreadable: readonly string[] = []): FakeLedger {
    return new FakeLedger(this.owner, this.entries, new Set(unreadable));
  }
}

/** Every figure of a measurement except how many transactions it fetched. */
const figures = ({ fetched: _fetched, ...rest }: WindowMeasurement) => rest;

describe("the walk cache", () => {
  it("measures a losing wallet's growing span exactly as an uncached walk does, sweep after sweep, fetching only what is new", async () => {
    const history = new History();
    history.add(FLOW, 0);
    let from = history.slot;
    const cache = new WalkCache();
    let seen = new Set<string>();
    for (let sweep = 1; sweep <= 25; sweep++) {
      // Five losing trades a sweep, one of them failed, and a stranger's dust transfer.
      for (let i = 0; i < 4; i++) history.add(TRADE, -1_000);
      history.add(TRADE, -5_000, { err: { InstructionError: [0, "Custom"] } as never });
      history.add(FLOW, 0, { signers: [stranger] });

      const plain = history.ledger();
      const uncached = await measureSince(plain, wallet, from, settleProgram);
      const cachedLedger = history.ledger();
      const cached = await measureSince(cachedLedger, wallet, from, settleProgram, undefined, { cache });

      expect(figures(cached), `sweep ${sweep}`).toEqual(figures(uncached));
      const fetched = cachedLedger.transactionCalls.map((call) => call.signature);
      expect(fetched.filter((signature) => seen.has(signature)), `sweep ${sweep} fetched again`).toEqual([]);
      expect(cached.fetched).toBe(fetched.length);
      // The uncached walk fetches the anchor and every transaction above the frontier, every sweep.
      expect(uncached.fetched).toBe(plain.transactionCalls.length);
      seen = new Set([...seen, ...fetched]);

      const decision = await decideFromMeasurement(cached, ctx(from));
      expect(decision, `sweep ${sweep}`).toEqual(await decideFromMeasurement(uncached, ctx(from)));
      if (decision.kind === "settle") {
        // The zero settle the wallet's 100th signed transaction brings, and the settle itself above the frontier.
        expect(decision.baseLamports).toBe(0n);
        from = decision.endSlot;
        history.add(SETTLE, -5_000);
      }
    }
    // The span settled at least once over those 25 sweeps, and the walk went on from its end.
    expect(from).toBeGreaterThan(1_001n);
  });

  it("fetches a stranger's 299 dust transfers once, not every sweep, and rests the span at NO_PROFIT the same", async () => {
    const history = new History();
    history.add(FLOW, 0);
    const from = history.slot;
    for (let i = 0; i < 299; i++) history.add(FLOW, 0, { signers: [stranger] });
    const cache = new WalkCache();

    const first = history.ledger();
    const once = await measureSince(first, wallet, from, settleProgram, undefined, { cache });
    expect(first.transactionCalls).toHaveLength(MAX_SIGNATURES);
    expect(await decideFromMeasurement(once, ctx(from))).toMatchObject({ kind: "stop", outcome: "NO_PROFIT" });

    for (let sweep = 2; sweep <= 4; sweep++) {
      const again = history.ledger();
      const measured = await measureSince(again, wallet, from, settleProgram, undefined, { cache });
      // The signatures are still walked — that is how the frontier is reached — and not one transaction is fetched.
      expect(again.signatureCalls).toHaveLength(1);
      expect(again.transactionCalls).toEqual([]);
      expect(figures(measured)).toEqual(figures(once));
    }
    expect(cache.counters).toEqual({ hits: 3 * MAX_SIGNATURES, fetched: MAX_SIGNATURES });
  });

  it("fetches a link's own last settle once: a settled link that went quiet fetches no transaction again", async () => {
    const history = new History();
    history.add(FLOW, 0);
    const from = history.slot;
    history.add(SETTLE, -5_000);
    const cache = new WalkCache();
    const first = history.ledger();
    expect(await decideFromMeasurement(await measureSince(first, wallet, from, settleProgram, undefined, { cache }), ctx(from))).toMatchObject({
      kind: "stop",
      outcome: "IDLE",
    });
    expect(first.transactionCalls).toHaveLength(2);
    const again = history.ledger();
    await measureSince(again, wallet, from, settleProgram, undefined, { cache });
    expect(again.transactionCalls).toEqual([]);
  });

  it("never keeps a transaction the RPC would not return: it is asked again, and the span is INCOMPLETE until it is read", async () => {
    const history = new History();
    history.add(FLOW, 0);
    const from = history.slot;
    for (let i = 0; i < 10; i++) history.add(TRADE, 2_000);
    const missing = history.entries[5]!.signature;
    const cache = new WalkCache();

    const throttled = await measureSince(history.ledger([missing]), wallet, from, settleProgram, undefined, { cache });
    expect(throttled.unfetchable).toBe(1);
    expect(await decideFromMeasurement(throttled, ctx(from))).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
    const stillThrottled = history.ledger([missing]);
    await measureSince(stillThrottled, wallet, from, settleProgram, undefined, { cache });
    expect(stillThrottled.transactionCalls.map((call) => call.signature)).toEqual([missing]);

    const recovered = history.ledger();
    const measured = await measureSince(recovered, wallet, from, settleProgram, undefined, { cache });
    expect(recovered.transactionCalls.map((call) => call.signature)).toEqual([missing]);
    expect(figures(measured)).toEqual(figures(await measureSince(history.ledger(), wallet, from, settleProgram)));
    expect(await decideFromMeasurement(measured, ctx(from))).toEqual({ kind: "settle", baseLamports: 20_000n, endSlot: history.slot });
  });

  it("keeps only the anchor and the prefix: the first walk that reaches the frontier a backlog's settle moved drops the settled prefix, all but its last transaction, which it keeps as its anchor", async () => {
    const history = new History();
    history.add(FLOW, 0);
    let from = history.slot;
    for (let i = 0; i < 1_200; i++) history.add(TRADE, i % 2 === 0 ? 30_000 : -20_000);
    const cache = new WalkCache();
    const uncachedCost: number[] = [];
    const cachedCost: number[] = [];
    for (let sweep = 1; sweep <= 4; sweep++) {
      const plain = history.ledger();
      const uncached = await measureSince(plain, wallet, from, settleProgram);
      const ledger = history.ledger();
      const measured = await measureSince(ledger, wallet, from, settleProgram, undefined, { cache });
      expect(figures(measured)).toEqual(figures(uncached));
      uncachedCost.push(plain.signatureCalls.length + plain.transactionCalls.length);
      cachedCost.push(ledger.signatureCalls.length + ledger.transactionCalls.length);
      // The anchor and the oldest MAX_SIGNATURES above the frontier, and nothing below it.
      expect(cache.size).toBe(MAX_SIGNATURES + 1);
      const decision = await decideFromMeasurement(measured, ctx(from));
      expect(decision).toMatchObject({ kind: "settle", baseLamports: 1_500_000n });
      if (decision.kind !== "settle") throw new Error("unreachable");
      from = decision.endSlot;
    }
    // A backlog is new work every sweep: 2 pages then 1, and the anchor plus 300 transactions, until the
    // last prefix; after the first sweep the anchor is the previous prefix's last transaction, already kept.
    expect(uncachedCost).toEqual([303, 302, 302, 302]);
    expect(cachedCost).toEqual([303, 301, 301, 301]);
  });

  it("drops the wallets kept longest ago past its cap, and keeps no wallet's reads larger than the whole cache", () => {
    const facts = (count: number, prefix: string) =>
      new Map<string, TxFacts>(
        Array.from({ length: count }, (_, i) => [
          `${prefix}-${i}`,
          { slot: i, blockTime: null, named: null, failed: false, walletFee: 0n, signedByWallet: false } satisfies TxFacts,
        ]),
      );
    const cache = new WalkCache(10);
    cache.keep("a", facts(5, "a"));
    cache.keep("b", facts(4, "b"));
    expect(cache.size).toBe(9);
    cache.keep("a", facts(5, "a"));
    // b was walked longest ago now, so c pushes it out.
    cache.keep("c", facts(3, "c"));
    expect(cache.size).toBe(8);
    expect(cache.get("b", "b-0")).toBeUndefined();
    expect(cache.get("a", "a-4")).toBeDefined();
    expect(cache.get("c", "c-2")).toBeDefined();
    // A walk replaces what its wallet kept: what it no longer used is gone.
    cache.keep("a", facts(2, "a2"));
    expect(cache.get("a", "a-0")).toBeUndefined();
    expect(cache.size).toBe(5);
    // Eleven would evict everything else and then itself: not kept, and the rest stay.
    cache.keep("d", facts(11, "d"));
    expect(cache.get("d", "d-0")).toBeUndefined();
    expect(cache.size).toBe(5);
    expect(() => new WalkCache(0)).toThrow(/at least one transaction/);
  });

  it("reads a volume walk's window again when the cache holds no answer from its probe, probes it once, and never probes the anchor", async () => {
    const history = new History();
    history.add(FLOW, 0);
    const from = history.slot;
    for (let i = 0; i < 6; i++) history.add(TRADE, i % 2 === 0 ? -1_000_000 : 1_100_000);
    const cache = new WalkCache();
    await measureSince(history.ledger(), wallet, from, settleProgram, undefined, { cache });

    const probed: string[] = [];
    const probe: typeof tradeNotional = (tx, owner, settleProgramId) => {
      probed.push(tx.transaction.signatures[0]!);
      return tradeNotional(tx, owner, settleProgramId);
    };
    const volume = history.ledger();
    const first = await measureSince(volume, wallet, from, settleProgram, probe, { cache });
    const window = history.entries.slice(1).map((entry) => entry.signature);
    // The anchor was kept by the profit walk and needs no answer; the window had none from this probe.
    expect(volume.transactionCalls.map((call) => call.signature)).toEqual(window);
    expect(probed).toEqual(window);
    expect(first.volumeTrades).toEqual((await measureSince(history.ledger(), wallet, from, settleProgram, tradeNotional)).volumeTrades);

    const again = history.ledger();
    const second = await measureSince(again, wallet, from, settleProgram, probe, { cache });
    expect(again.transactionCalls).toEqual([]);
    expect(probed).toEqual(window);
    expect(second.volumeTrades).toEqual(first.volumeTrades);
  });
});

describe("what the walk cache does not trust", () => {
  it("keeps no answer that does not name the wallet: the anchor is unfetchable, and asked again next sweep", async () => {
    const history = new History();
    const anchor = history.add(FLOW, 0);
    const from = history.slot;
    for (let i = 0; i < 3; i++) history.add(TRADE, 2_000);
    // A node that answers the anchor's signature with somebody else's transaction.
    const other = new FakeLedger(stranger, [{ ...anchor }]);
    const honest = history.ledger();
    const lying = {
      signatures: honest.signatures.bind(honest),
      transaction: (signature: string, commitment: Finality) =>
        signature === anchor.signature ? other.transaction(signature, commitment) : honest.transaction(signature, commitment),
    };
    const cache = new WalkCache();
    const wrong = await measureSince(lying, wallet, from, settleProgram, undefined, { cache });
    expect(wrong.unfetchable).toBe(1);
    expect(await decideFromMeasurement(wrong, ctx(from))).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });

    const again = history.ledger();
    const right = await measureSince(again, wallet, from, settleProgram, undefined, { cache });
    expect(again.transactionCalls.map((call) => call.signature)).toEqual([anchor.signature]);
    expect(await decideFromMeasurement(right, ctx(from))).toEqual({ kind: "settle", baseLamports: 6_000n, endSlot: history.slot });
  });

  it("keeps nothing from a walk that found a balance-chain break where no read failed, so the next turn fetches the window again", async () => {
    const history = new History();
    history.add(FLOW, 0);
    const from = history.slot;
    for (let i = 0; i < 4; i++) history.add(TRADE, 2_000);
    // A hole: the third transaction starts from a balance the second did not leave.
    const broken = history.entries.map((entry, i) => (i === 3 ? { ...entry, pre: entry.pre + 7, post: entry.post + 7 } : entry));
    const cache = new WalkCache();
    const first = new FakeLedger(wallet, broken);
    expect(await measureSince(first, wallet, from, settleProgram, undefined, { cache })).toMatchObject({ chainBreaks: 2 });
    expect(cache.size).toBe(0);
    const second = new FakeLedger(wallet, broken);
    await measureSince(second, wallet, from, settleProgram, undefined, { cache });
    expect(second.transactionCalls).toHaveLength(5);
  });
});

describe("what the walk cache holds", () => {
  it("lands exactly at its cap without dropping anything, and drops the oldest wallet one transaction past it", () => {
    const facts = (count: number, prefix: string) =>
      new Map<string, TxFacts>(
        Array.from({ length: count }, (_, i) => [
          `${prefix}-${i}`,
          { slot: i, blockTime: null, named: null, failed: false, walletFee: 0n, signedByWallet: false } satisfies TxFacts,
        ]),
      );
    const cache = new WalkCache(10);
    cache.keep("a", facts(6, "a"));
    cache.keep("b", facts(4, "b"));
    expect(cache.size).toBe(10);
    expect(cache.get("a", "a-5")).toBeDefined();
    cache.keep("c", facts(1, "c"));
    expect(cache.get("a", "a-0")).toBeUndefined();
    expect(cache.size).toBe(5);
  });

  it("forgets the wallets the sweep no longer discovers, and nothing else", async () => {
    const cache = new WalkCache();
    const kept = new History(Keypair.generate().publicKey);
    const gone = new History(Keypair.generate().publicKey);
    for (const history of [kept, gone]) {
      history.add(FLOW, 0);
      for (let i = 0; i < 5; i++) history.add(TRADE, 1_000);
      await measureSince(history.ledger(), history.owner, 1_001n, settleProgram, undefined, { cache });
    }
    expect(cache.size).toBe(12);
    cache.prune(new Set([kept.owner.toBase58()]));
    expect(cache.size).toBe(6);
    const again = kept.ledger();
    await measureSince(again, kept.owner, 1_001n, settleProgram, undefined, { cache });
    expect(again.transactionCalls).toEqual([]);
    const gonePrune = gone.ledger();
    await measureSince(gonePrune, gone.owner, 1_001n, settleProgram, undefined, { cache });
    expect(gonePrune.transactionCalls).toHaveLength(6);
  });

  it("carries the fee the wallet paid, so a cached walk's traded volume is the uncached one's, fee taken out", async () => {
    // The fake ledger charges a 5 000-lamport fee to the wallet, its fee payer; a
    // buy of 1 000 000 that moved the wallet by 1 005 000 traded 1 000 000.
    const history = new History();
    history.add(FLOW, 0);
    const from = history.slot;
    history.add(TRADE, -1_005_000);
    const cache = new WalkCache();
    const uncached = await measureSince(history.ledger(), wallet, from, settleProgram, undefined, { cache });
    const cached = await measureSince(history.ledger(), wallet, from, settleProgram, undefined, { cache });
    expect(cached.fetched).toBe(0);
    expect(uncached.tradedLamports).toBe(1_000_000n);
    expect(cached.tradedLamports).toBe(1_000_000n);
  });

  it("reports one sweep's reads as the difference of the cache's totals, and what it holds at the end", async () => {
    const history = new History();
    history.add(FLOW, 0);
    const from = history.slot;
    for (let i = 0; i < 4; i++) history.add(TRADE, -1_000);
    const cache = new WalkCache();
    await measureSince(history.ledger(), wallet, from, settleProgram, undefined, { cache });
    const atStart = cache.counters;
    history.add(TRADE, -1_000);
    await measureSince(history.ledger(), wallet, from, settleProgram, undefined, { cache });
    // The second sweep fetched the new trade and served the anchor and four trades from the cache.
    expect(walkSweepReport(atStart, cache.counters, cache.size)).toEqual({ fetched: 1, cacheHits: 5, cacheEntries: 6 });
  });
});
