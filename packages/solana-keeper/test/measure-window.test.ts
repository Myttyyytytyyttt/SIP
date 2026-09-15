// The measurement decides how much of a user's money moves. Ported from Nuvem's
// keeper/test/measure-window.test.mts (node:test) to vitest, with sip-vault's
// program id as the settle marker. The one bug that mattered — a failed
// transaction wedging a wallet forever — survived a full mainnet drill because
// scripted drills do not fail. These are the cases that drill could never
// produce, and, since the walk reads finalized history and must prove it reached
// the frontier, the walk itself, run over a fake ledger that refuses any other
// commitment and any `until`.

import { readFileSync } from "node:fs";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { MAX_SIGNATURES, MAX_SIGNATURE_PAGES, SIGNATURE_PAGE_LIMIT, isExternalFlowTx, measureSince } from "../src/measure-window.js";
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

  it("reaches a frontier whose signature opens the second page, however full the first one was", async () => {
    // The old walk declared itself truncated after its last full page even when
    // the frontier signature was the very next one.
    const ledger = new FakeLedger(wallet, [
      { signature: "anchor-100", slot: 100, pre: 1_000_000, post: 1_000_000, programs: FLOW },
      ...perSlot(101, SIGNATURE_PAGE_LIMIT),
    ]);
    const measured = await measureSince(ledger, wallet, 100n, settleProgram);
    expect(measured).toMatchObject({ frontierReached: true, pagesExhausted: false, signaturesAbove: SIGNATURE_PAGE_LIMIT });
    expect(ledger.signatureCalls.map((call) => call.before)).toEqual([undefined, "sig-101"]);
    // Above the read limit, refused before a single transaction is fetched.
    expect(ledger.transactionCalls).toEqual([]);
    expect(await decideFromMeasurement(measured, ctx(100n, 10_000n))).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
  });

  it("reads exactly MAX_SIGNATURES above the frontier, where the old walk called itself truncated, and refuses one more unread", async () => {
    const anchor: LedgerEntry = { signature: "anchor-500", slot: 500, pre: 1_000_000, post: 1_000_000, programs: FLOW };
    const atLimit = new FakeLedger(wallet, [anchor, ...perSlot(501, MAX_SIGNATURES, { programs: TRADE, delta: 1 })]);
    const measured = await measureSince(atLimit, wallet, 500n, settleProgram);
    expect(measured).toMatchObject({ frontierReached: true, signaturesAbove: MAX_SIGNATURES, txCount: MAX_SIGNATURES, chainBreaks: 0 });
    expect(atLimit.transactionCalls).toHaveLength(MAX_SIGNATURES + 1);
    expect(await decideFromMeasurement(measured, at500)).toEqual({ kind: "settle", baseLamports: BigInt(MAX_SIGNATURES), endSlot: 800n });

    const overLimit = new FakeLedger(wallet, [anchor, ...perSlot(501, MAX_SIGNATURES + 1, { programs: TRADE, delta: 1 })]);
    const over = await measureSince(overLimit, wallet, 500n, settleProgram);
    expect(over).toMatchObject({ frontierReached: true, signaturesAbove: MAX_SIGNATURES + 1, txCount: 0 });
    expect(overLimit.transactionCalls).toEqual([]);
    const decision = await decideFromMeasurement(over, at500);
    expect(decision).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
    if (decision.kind === "stop") expect(decision.detail).not.toContain("catch up");
  });

  it("stops after MAX_SIGNATURE_PAGES full pages, one page short of the frontier, and reads nothing", async () => {
    const ledger = new FakeLedger(wallet, [
      { signature: "anchor-100", slot: 100, pre: 1_000_000, post: 1_000_000, programs: FLOW },
      ...perSlot(101, MAX_SIGNATURE_PAGES * SIGNATURE_PAGE_LIMIT),
    ]);
    const measured = await measureSince(ledger, wallet, 100n, settleProgram);
    expect(measured).toMatchObject({ frontierReached: false, pagesExhausted: true, signaturesAbove: MAX_SIGNATURE_PAGES * SIGNATURE_PAGE_LIMIT });
    expect(ledger.signatureCalls).toHaveLength(MAX_SIGNATURE_PAGES);
    expect(ledger.transactionCalls).toEqual([]);
    // INCOMPLETE even over a start finality has not reached: pages decide first.
    expect(await decideFromMeasurement(measured, ctx(100n, 50n))).toMatchObject({ kind: "stop", outcome: "INCOMPLETE" });
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
