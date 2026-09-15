// The measurement decides how much of a user's money moves. Ported from Nuvem's
// keeper/test/measure-window.test.mts (node:test) to vitest, with sip-vault's
// program id as the settle marker. The one bug that mattered — a failed
// transaction wedging a wallet forever — survived a full mainnet drill because
// scripted drills do not fail. These are the cases that drill could never
// produce, and, since the walk reads finalized history and must prove it reached
// the frontier, the walk itself, run over a fake ledger that refuses any other
// commitment and any `until`. A backlog past the read limit is read and settled
// one complete prefix at a time, oldest first, and that drain is walked here too.

import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import {
  MAX_SIGNATURES,
  MAX_SIGNATURE_PAGES,
  SIGNATURE_PAGE_LIMIT,
  isExternalFlowTx,
  measureSince,
  oldestCompletePrefix,
} from "../src/measure-window.js";
import { tightenMinOut } from "../src/min-out.js";
import { MODE_PROFIT } from "../src/program-scripts.js";
import { decideFromMeasurement, defaultVolumeBase } from "../src/settle-decision.js";
import { FakeLedger, chained, type LedgerEntry } from "./fake-ledger.js";

const SIP = SIP_PROGRAM_ID;
const SYSTEM = "11111111111111111111111111111111";
const ED25519 = "Ed25519SigVerify111111111111111111111111111";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const RAYDIUM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

describe("classification", () => {
  it("a real settle counts as external flow, so it does not depress the next window", () => {
    // A settle_v2 transaction: {Ed25519, sip-vault, System}.
    expect(isExternalFlowTx([ED25519, SIP, SYSTEM], SIP)).toBe(true);
  });

  it("a plain deposit is external flow", () => {
    expect(isExternalFlowTx([SYSTEM], SIP)).toBe(true);
    expect(isExternalFlowTx([SYSTEM, COMPUTE], SIP)).toBe(true);
  });

  it("a clean trade is trading", () => {
    expect(isExternalFlowTx([JUPITER, SYSTEM], SIP)).toBe(false);
  });

  it("LAUNDERING: a trade bundled with our own instruction stays trading", () => {
    // The whole reason this predicate is exclusivity-based rather than
    // presence-based. The trading wallet is exported to Axiom, so its owner signs
    // its transactions and could append a 1-lamport wrap_sol to every winning
    // trade — erasing the win from the skim if presence were enough.
    expect(isExternalFlowTx([SIP, JUPITER, SYSTEM], SIP)).toBe(false);
    expect(isExternalFlowTx([SIP, RAYDIUM], SIP)).toBe(false);
  });

  it("without a settle program id, only the pure set is flow", () => {
    expect(isExternalFlowTx([SYSTEM], undefined)).toBe(true);
    expect(isExternalFlowTx([SIP, SYSTEM], undefined)).toBe(false);
  });

  it("PublicKey round-trips the program id used as the settle marker", () => {
    expect(new PublicKey(SIP).toBase58()).toBe(SIP);
  });
});

// ── the wedge ───────────────────────────────────────────────────────────────
//
// The SHAPE of the fix, pinned in the source: what must never regress is the
// decision to include failed signatures. The walk below also runs one.

describe("the wedge", () => {
  it("failed transactions are not filtered out of the walk", () => {
    const source = readFileSync(new URL("../src/measure-window.ts", import.meta.url), "utf8");
    // The exact line that caused a permanent wedge: skipping failures left the
    // fee they charged outside the balance chain, so the next real transaction
    // registered a break and settle refused forever.
    expect(
      /if\s*\(\s*info\.err\s*!==\s*null\s*\)\s*continue/.test(source),
      "failed signatures must be WALKED — skipping them breaks the balance chain and wedges the wallet",
    ).toBe(false);
  });
});

// ── the oldest complete prefix ──────────────────────────────────────────────
//
// What one settlement of a backlog measures. The frontier moves to the prefix's
// last slot, and no walk reads a slot at or below the frontier again, so the
// prefix must hold every signature in that slot.

describe("the oldest complete prefix", () => {
  /** `count` signatures newest first, as getSignaturesForAddress serves them; `slotOf(i)` is the slot of the i-th oldest. */
  const newestFirst = (count: number, slotOf: (i: number) => number) =>
    Array.from({ length: count }, (_, i) => ({ signature: `s-${i}`, slot: slotOf(i) })).reverse();

  it("takes the oldest 300 of 301 signatures, one per slot, and ends at the 300th-oldest slot", () => {
    expect(MAX_SIGNATURES).toBe(300);
    const { prefix, endSlot, prefixCut } = oldestCompletePrefix(newestFirst(301, (i) => 1_000 + i));
    expect(prefix).toHaveLength(300);
    expect(prefix[0]).toEqual({ signature: "s-0", slot: 1_000 });
    expect(prefix.at(-1)).toEqual({ signature: "s-299", slot: 1_299 });
    expect(endSlot).toBe(1_299);
    expect(prefixCut).toBe(true);
  });

  it("extends to every signature in its last slot: when signatures 299, 300 and 301 share one, 302 are in", () => {
    const { prefix, endSlot, prefixCut } = oldestCompletePrefix(newestFirst(310, (i) => (i >= 299 && i <= 301 ? 1_299 : 1_000 + i)));
    expect(prefix).toHaveLength(302);
    expect(prefix.slice(-3).map((info) => info.signature)).toEqual(["s-299", "s-300", "s-301"]);
    expect(endSlot).toBe(1_299);
    expect(prefixCut).toBe(true);
  });

  it("takes a span of 250 whole, and leaves nothing for a later settlement", () => {
    const { prefix, endSlot, prefixCut } = oldestCompletePrefix(newestFirst(250, (i) => 1_000 + i));
    expect(prefix).toHaveLength(250);
    expect(endSlot).toBe(1_249);
    expect(prefixCut).toBe(false);
  });

  it("takes all 400 when the first slot alone holds 400, whether or not more follow", () => {
    const cut = oldestCompletePrefix(newestFirst(450, (i) => (i < 400 ? 7 : 8 + i)));
    expect(cut.prefix).toHaveLength(400);
    expect(cut).toMatchObject({ endSlot: 7, prefixCut: true });
    const whole = oldestCompletePrefix(newestFirst(400, () => 7));
    expect(whole.prefix).toHaveLength(400);
    expect(whole).toMatchObject({ endSlot: 7, prefixCut: false });
  });

  it("decides by slot, not by position: a signature served out of order is in when its slot is, and nothing newer than the last slot is", () => {
    const oldestFirst = [
      ...Array.from({ length: 300 }, (_, i) => ({ signature: `s-${i}`, slot: 1_000 + i })),
      { signature: "s-302", slot: 1_302 },
      { signature: "s-late", slot: 1_100 },
      { signature: "s-303", slot: 1_303 },
    ];
    const { prefix, endSlot, prefixCut } = oldestCompletePrefix([...oldestFirst].reverse());
    const signatures = prefix.map((info) => info.signature);
    expect(endSlot).toBe(1_299);
    expect(signatures).toHaveLength(301);
    expect(signatures).toContain("s-late");
    for (const newer of ["s-302", "s-303"]) expect(signatures).not.toContain(newer);
    expect(prefixCut).toBe(true);
  });

  it("returns nothing for an empty span, refuses a limit that is not a positive integer, and leaves the walk's list as it was", () => {
    expect(oldestCompletePrefix([])).toEqual({ prefix: [], endSlot: null, prefixCut: false });
    for (const limit of [0, -1, 1.5]) expect(() => oldestCompletePrefix(newestFirst(3, (i) => i), limit)).toThrow(/positive integer/);
    const served = newestFirst(5, (i) => 10 + i);
    const before = [...served];
    expect(oldestCompletePrefix(served, 2)).toMatchObject({ endSlot: 11, prefixCut: true });
    expect(served).toEqual(before);
  });
});

// ── the walk ────────────────────────────────────────────────────────────────

const wallet = Keypair.generate().publicKey;
const settleProgram = new PublicKey(SIP);
const FLOW = [SYSTEM];
const TRADE = [JUPITER, SYSTEM];
const SETTLE = [ED25519, SIP, SYSTEM];
/** A PROFIT span's context, as settle-tick.ts builds it. */
const ctx = (from: bigint, finalizedSlot: bigint) => ({ from, finalizedSlot, mode: MODE_PROFIT, volumeBase: defaultVolumeBase });
const at500 = ctx(500n, 10_000n);
const finalized = (signature: string) => ({ signature, commitment: "finalized" });

/** `count` transactions, one per slot from `firstSlot`, each moving the wallet by `delta`, chained from `balance`. */
function perSlot(firstSlot: number, count: number, over: { programs?: readonly string[]; balance?: number; delta?: number } = {}): LedgerEntry[] {
  const { programs = FLOW, balance = 1_000_000, delta = 0 } = over;
  return chained(
    balance,
    Array.from({ length: count }, (_, i) => ({ signature: `sig-${firstSlot + i}`, slot: firstSlot + i, programs, delta })),
  );
}

describe("the walk, over a finalized ledger", () => {
  it("reaches the frontier at the first signature in its slot, and reads the window and that anchor, all at finalized", async () => {
    const ledger = new FakeLedger(
      wallet,
      chained(1_000_000, [
        { signature: "anchor-500", slot: 500, programs: FLOW, delta: 1_000_000 },
        { signature: "trade-505", slot: 505, programs: TRADE, delta: 400_000 },
        { signature: "trade-510", slot: 510, programs: TRADE, delta: -150_000 },
      ]),
    );
    const measured = await measureSince(ledger, wallet, 500n, settleProgram);
    expect(measured).toMatchObject({
      frontierReached: true,
      pagesExhausted: false,
      signaturesAbove: 2,
      txCount: 2,
      chainBreaks: 0,
      unfetchable: 0,
      firstSlot: 505n,
      lastSlot: 510n,
      profitLamports: 250_000n,
    });
    expect(ledger.signatureCalls).toEqual([{ limit: SIGNATURE_PAGE_LIMIT, commitment: "finalized" }]);
    expect(ledger.transactionCalls).toEqual([finalized("anchor-500"), finalized("trade-505"), finalized("trade-510")]);
    expect(await decideFromMeasurement(measured, at500)).toEqual({ kind: "settle", baseLamports: 250_000n, endSlot: 510n });
  });

  it("does not reach a frontier its history ends above, on a short page or an empty one, and reads no transaction", async () => {
    const short = new FakeLedger(wallet, perSlot(505, 2, { programs: TRADE, delta: 1 }));
    const shortWalk = await measureSince(short, wallet, 500n, settleProgram);
    expect(shortWalk).toMatchObject({ frontierReached: false, pagesExhausted: false, signaturesAbove: 2, txCount: 0 });
    expect(short.signatureCalls).toHaveLength(1);
    expect(short.transactionCalls).toEqual([]);
    expect(await decideFromMeasurement(shortWalk, at500)).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
    expect(await decideFromMeasurement(shortWalk, ctx(500n, 499n))).toMatchObject({ kind: "stop", outcome: "PENDING_FINALITY" });

    // One full page above the frontier and nothing at or below it: the second
    // page comes back empty, which the old walk took for arriving.
    const full = new FakeLedger(wallet, perSlot(501, SIGNATURE_PAGE_LIMIT));
    expect(await measureSince(full, wallet, 500n, settleProgram)).toMatchObject({
      frontierReached: false,
      pagesExhausted: false,
      signaturesAbove: SIGNATURE_PAGE_LIMIT,
    });
    expect(full.signatureCalls.map((call) => call.before)).toEqual([undefined, "sig-501"]);
    expect(full.transactionCalls).toEqual([]);
  });

  it("reaches a frontier whose signature opens the second page, however full the first one was, and reads only the oldest prefix above it", async () => {
    // The old walk declared itself truncated after its last full page even when
    // the frontier signature was the very next one.
    const ledger = new FakeLedger(wallet, [
      { signature: "anchor-100", slot: 100, pre: 1_000_000, post: 1_000_000, programs: FLOW },
      ...perSlot(101, SIGNATURE_PAGE_LIMIT),
    ]);
    const measured = await measureSince(ledger, wallet, 100n, settleProgram);
    expect(measured).toMatchObject({ frontierReached: true, pagesExhausted: false, signaturesAbove: SIGNATURE_PAGE_LIMIT });
    expect(ledger.signatureCalls.map((call) => call.before)).toEqual([undefined, "sig-101"]);
    // A thousand flat transfers: the anchor and the oldest 300 are read, and not one above them.
    expect(measured).toMatchObject({ prefixCut: true, txCount: MAX_SIGNATURES, firstSlot: 101n, lastSlot: 400n, chainBreaks: 0 });
    expect(ledger.transactionCalls).toHaveLength(MAX_SIGNATURES + 1);
    expect(ledger.transactionCalls.at(0)).toEqual(finalized("anchor-100"));
    expect(ledger.transactionCalls.at(-1)).toEqual(finalized("sig-400"));
    // A flat prefix settles a zero base at once: resting would leave the same prefix there every sweep.
    expect(await decideFromMeasurement(measured, ctx(100n, 10_000n))).toMatchObject({ kind: "settle", baseLamports: 0n, endSlot: 400n });
  });

  it("reads exactly MAX_SIGNATURES above the frontier and settles them whole; one more cuts the window to the oldest 300 and leaves the newest unread", async () => {
    const anchor: LedgerEntry = { signature: "anchor-500", slot: 500, pre: 1_000_000, post: 1_000_000, programs: FLOW };
    const atLimit = new FakeLedger(wallet, [anchor, ...perSlot(501, MAX_SIGNATURES, { programs: TRADE, delta: 1 })]);
    const measured = await measureSince(atLimit, wallet, 500n, settleProgram);
    expect(measured).toMatchObject({ frontierReached: true, signaturesAbove: MAX_SIGNATURES, txCount: MAX_SIGNATURES, chainBreaks: 0, prefixCut: false });
    expect(atLimit.transactionCalls).toHaveLength(MAX_SIGNATURES + 1);
    expect(await decideFromMeasurement(measured, at500)).toEqual({ kind: "settle", baseLamports: BigInt(MAX_SIGNATURES), endSlot: 800n });

    // THE 301-TRANSACTION SPAN that was INCOMPLETE every sweep, over a consistent chain.
    const overLimit = new FakeLedger(wallet, [anchor, ...perSlot(501, MAX_SIGNATURES + 1, { programs: TRADE, delta: 1 })]);
    const over = await measureSince(overLimit, wallet, 500n, settleProgram);
    expect(over).toMatchObject({
      frontierReached: true,
      signaturesAbove: MAX_SIGNATURES + 1,
      txCount: MAX_SIGNATURES,
      chainBreaks: 0,
      unfetchable: 0,
      prefixCut: true,
      lastSlot: 800n,
    });
    expect(overLimit.transactionCalls).toHaveLength(MAX_SIGNATURES + 1);
    expect(overLimit.transactionCalls.map((call) => call.signature)).not.toContain("sig-801");
    const decision = await decideFromMeasurement(over, at500);
    expect(decision).toMatchObject({ kind: "settle", baseLamports: BigInt(MAX_SIGNATURES), endSlot: 800n });
    if (decision.kind === "settle") {
      expect(decision.backlog).toBe("backlog: settling the oldest 300 of 301 signatures above slot 500, up to slot 800; the rest continues next sweep");
    }
  });

  it("settles a 301-transaction span in two windows, oldest first, whose bases add up to the one window's profit", async () => {
    // Trades that win and lose, and a deposit every tenth transaction, so the profit is not a count.
    const anchor: LedgerEntry = { signature: "anchor-500", slot: 500, pre: 1_000_000, post: 1_000_000, programs: FLOW };
    const span = chained(
      1_000_000,
      Array.from({ length: MAX_SIGNATURES + 1 }, (_, i) =>
        i % 10 === 9
          ? { signature: `tx-${501 + i}`, slot: 501 + i, programs: FLOW, delta: 250_000 }
          : { signature: `tx-${501 + i}`, slot: 501 + i, programs: TRADE, delta: i % 3 === 1 ? -40_000 : 35_000 },
      ),
    );
    const oneWindowProfit = span.filter((entry) => entry.programs === TRADE).reduce((sum, entry) => sum + BigInt(entry.post - entry.pre), 0n);
    const ledger = new FakeLedger(wallet, [anchor, ...span]);

    const first = await measureSince(ledger, wallet, 500n, settleProgram);
    expect(first).toMatchObject({ prefixCut: true, chainBreaks: 0, txCount: MAX_SIGNATURES, firstSlot: 501n, lastSlot: 800n });
    const decision1 = await decideFromMeasurement(first, at500);
    expect(decision1).toMatchObject({ kind: "settle", endSlot: 800n });
    if (decision1.kind !== "settle") return;

    // settle_v2 moves the frontier to the window's end, and the next sweep measures from there.
    const s1 = decision1.endSlot;
    ledger.transactionCalls.splice(0);
    const second = await measureSince(ledger, wallet, s1, settleProgram);
    expect(second).toMatchObject({ prefixCut: false, chainBreaks: 0, signaturesAbove: 1, txCount: 1, firstSlot: 801n, lastSlot: 801n });
    // Its chain starts where the first window's ended: the anchor is that window's last transaction.
    expect(ledger.transactionCalls).toEqual([finalized("tx-800"), finalized("tx-801")]);
    const decision2 = await decideFromMeasurement(second, ctx(s1, 10_000n));
    expect(decision2).toEqual({ kind: "settle", baseLamports: 35_000n, endSlot: 801n });
    if (decision2.kind !== "settle") return;

    expect(decision1.baseLamports > 0n && decision2.baseLamports > 0n, "both windows are positive").toBe(true);
    expect(decision1.baseLamports + decision2.baseLamports).toBe(oneWindowProfit);
  });

  it("never splits the prefix's last slot: every signature in it is read, however far past the limit, and nothing newer", async () => {
    const anchor: LedgerEntry = { signature: "anchor-500", slot: 500, pre: 1_000_000, post: 1_000_000, programs: FLOW };
    // The 300th, 301st and 302nd oldest share slot 800, and three more follow it.
    const span = chained(
      1_000_000,
      Array.from({ length: 305 }, (_, i) => ({ signature: `tx-${i}`, slot: i < 299 ? 501 + i : i <= 301 ? 800 : 499 + i, programs: TRADE, delta: 1 })),
    );
    const ledger = new FakeLedger(wallet, [anchor, ...span]);
    const measured = await measureSince(ledger, wallet, 500n, settleProgram);
    expect(measured).toMatchObject({ prefixCut: true, signaturesAbove: 305, txCount: 302, lastSlot: 800n, chainBreaks: 0, profitLamports: 302n });
    const read = ledger.transactionCalls.map((call) => call.signature);
    expect(read).toHaveLength(303);
    expect(read.slice(-3)).toEqual(["tx-299", "tx-300", "tx-301"]);
    for (const unread of ["tx-302", "tx-303", "tx-304"]) expect(read).not.toContain(unread);
    expect(await decideFromMeasurement(measured, at500)).toMatchObject({ kind: "settle", baseLamports: 302n, endSlot: 800n });
  });

  it("stops after MAX_SIGNATURE_PAGES full pages, one page short of the frontier, and reads nothing: a prefix starts only at a frontier the walk saw", async () => {
    const ledger = new FakeLedger(wallet, [
      { signature: "anchor-100", slot: 100, pre: 1_000_000, post: 1_000_000, programs: FLOW },
      ...perSlot(101, MAX_SIGNATURE_PAGES * SIGNATURE_PAGE_LIMIT),
    ]);
    const measured = await measureSince(ledger, wallet, 100n, settleProgram);
    expect(measured).toMatchObject({
      frontierReached: false,
      pagesExhausted: true,
      signaturesAbove: MAX_SIGNATURE_PAGES * SIGNATURE_PAGE_LIMIT,
      prefixCut: false,
      txCount: 0,
    });
    expect(ledger.signatureCalls).toHaveLength(MAX_SIGNATURE_PAGES);
    expect(ledger.transactionCalls).toEqual([]);
    // INCOMPLETE even over a start finality has not reached: pages decide first.
    const decision = await decideFromMeasurement(measured, ctx(100n, 50n));
    expect(decision).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
    if (decision.kind === "stop") expect(decision.detail).not.toMatch(/catch(es|ing)?[ -]up/i);
  });

  it("excludes every signature in the frontier's own slot and anchors on the newest of them", async () => {
    const ledger = new FakeLedger(wallet, [
      { signature: "older-500", slot: 500, pre: 0, post: 700_000, programs: FLOW },
      { signature: "newer-500", slot: 500, pre: 700_000, post: 900_000, programs: TRADE },
      { signature: "trade-505", slot: 505, pre: 900_000, post: 950_000, programs: TRADE },
    ]);
    const measured = await measureSince(ledger, wallet, 500n, settleProgram);
    // Anchored on older-500, the chain would break: its post is not trade-505's pre.
    expect(measured).toMatchObject({ frontierReached: true, signaturesAbove: 1, txCount: 1, chainBreaks: 0, firstSlot: 505n, profitLamports: 50_000n });
    expect(ledger.transactionCalls).toEqual([finalized("newer-500"), finalized("trade-505")]);
  });

  it("counts a break between the anchor and the window's first transaction, which the old walk never checked", async () => {
    const ledger = new FakeLedger(wallet, [
      { signature: "anchor-500", slot: 500, pre: 0, post: 2_000_000, programs: FLOW },
      // 100 000 lamports left the wallet in a transaction the walk never saw.
      { signature: "trade-505", slot: 505, pre: 1_900_000, post: 2_500_000, programs: TRADE },
    ]);
    const measured = await measureSince(ledger, wallet, 500n, settleProgram);
    expect(measured).toMatchObject({ frontierReached: true, txCount: 1, chainBreaks: 1, unfetchable: 0 });
    expect(await decideFromMeasurement(measured, at500)).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
  });

  it("counts an anchor the RPC will not return as unfetchable, and refuses the window above it", async () => {
    const entries = chained(1_000_000, [
      { signature: "anchor-500", slot: 500, programs: FLOW, delta: 0 },
      { signature: "trade-505", slot: 505, programs: TRADE, delta: 400_000 },
    ]);
    const ledger = new FakeLedger(wallet, entries, new Set(["anchor-500"]));
    const measured = await measureSince(ledger, wallet, 500n, settleProgram);
    expect(measured).toMatchObject({ frontierReached: true, unfetchable: 1, chainBreaks: 0, txCount: 1 });
    const decision = await decideFromMeasurement(measured, at500);
    expect(decision).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
    if (decision.kind === "stop") expect(decision.detail).toContain("OUR node");
  });

  it("walks a trade made between the last window's end and the settle that closed it", async () => {
    // The window ending at slot 100 was settled by a transaction that landed at
    // 110, and settle_v2 moved the frontier to 100. The trade at 105 happened
    // while that settle was being built, so its signature is OLDER than the
    // settle's: a walk that stopped at the settle's signature would never see it.
    const ledger = new FakeLedger(
      wallet,
      chained(3_000_000, [
        { signature: "window-end-100", slot: 100, programs: TRADE, delta: 500_000 },
        { signature: "trade-105", slot: 105, programs: TRADE, delta: 250_000 },
        { signature: "settle-110", slot: 110, programs: SETTLE, delta: -110_000 },
      ]),
    );
    const measured = await measureSince(ledger, wallet, 100n, settleProgram);
    expect(measured).toMatchObject({ frontierReached: true, txCount: 2, settleTxCount: 1, successfulTradeCount: 1, chainBreaks: 0 });
    // The settle is flow: the trade's 250 000 is the profit, not 140 000.
    expect(measured.profitLamports).toBe(250_000n);
    expect(ledger.transactionCalls.map((call) => call.signature)).toEqual(["window-end-100", "trade-105", "settle-110"]);
  });

  it("never stops on a signature: `until` is absent from the walk's source", () => {
    const source = readFileSync(new URL("../src/measure-window.ts", import.meta.url), "utf8");
    expect(
      /until\s*:/.test(source),
      "the walk stops on slot — a stop at the last settle's signature skips trades made while that settle was built",
    ).toBe(false);
  });

  it("counts our own settles and successful trades; a failed trade is walked, costs its fee, and is never a successful trade", async () => {
    const ledger = new FakeLedger(
      wallet,
      chained(5_000_000, [
        { signature: "anchor-200", slot: 200, programs: FLOW, delta: 0 },
        { signature: "trade-201", slot: 201, programs: TRADE, delta: 300_000 },
        { signature: "failed-202", slot: 202, programs: [RAYDIUM, COMPUTE], delta: -5_000, err: { InstructionError: [0, { Custom: 6001 }] } },
        { signature: "settle-203", slot: 203, programs: SETTLE, delta: -65_000 },
        { signature: "deposit-204", slot: 204, programs: FLOW, delta: 1_000_000 },
        // Our instruction bundled into a trade stays a trade, so it is not one of our settles.
        { signature: "bundle-205", slot: 205, programs: [SIP, JUPITER, SYSTEM], delta: -20_000 },
      ]),
    );
    const measured = await measureSince(ledger, wallet, 200n, settleProgram);
    expect(measured).toMatchObject({ txCount: 5, settleTxCount: 1, successfulTradeCount: 2, chainBreaks: 0, unfetchable: 0 });
    // The failed trade's fee sits inside the chain and inside the profit, as a cost of trading.
    expect(measured.profitLamports).toBe(300_000n - 5_000n - 20_000n);
  });
});

// ── slippage ────────────────────────────────────────────────────────────────

describe("min_out", () => {
  it("a live observation tightens min_out far above the lab floor", () => {
    // The tester's real purchase: 1.00 USDC in, 464278 raw NVDAx out.
    const observed = { inRaw: 1_000_000n, outRaw: 464_278n };
    // The floor the web writes: amountIn * 1e15 / 1e18 = amountIn / 1000.
    const floor = 1_000_000n / 1000n; // 1000 raw units — ~460x below market
    const { minOut, live } = tightenMinOut(1_000_000n, floor, observed);
    expect(live).toBe(true);
    // 2% under the observed rate, and hugely tighter than the floor.
    expect(minOut).toBe((464_278n * 9800n) / 10_000n);
    expect(minOut > floor * 400n, "the live bound must dwarf the lab floor").toBe(true);
  });

  it("without an observation it falls back to the floor and admits it", () => {
    const floor = 1_000n;
    const { minOut, live } = tightenMinOut(1_000_000n, floor, null);
    expect(minOut).toBe(floor);
    expect(live, "no observation must never be reported as live protection").toBe(false);
  });

  it("min_out is NEVER below the floor the owner signed", () => {
    // A collapsing pool: the observed rate is worse than the user's own floor.
    const observed = { inRaw: 1_000_000n, outRaw: 10n };
    const floor = 500_000n;
    const { minOut, live } = tightenMinOut(1_000_000n, floor, observed);
    expect(minOut, "the program requires min_out >= floor; tightening is the only direction").toBe(floor);
    expect(live).toBe(false);
  });

  it("a zero-input observation cannot divide by zero", () => {
    const { minOut, live } = tightenMinOut(1_000n, 7n, { inRaw: 0n, outRaw: 5n });
    expect(minOut).toBe(7n);
    expect(live).toBe(false);
  });
});
