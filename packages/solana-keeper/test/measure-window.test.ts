// The measurement decides how much of a user's money moves. Ported from Nuvem's
// keeper/test/measure-window.test.mts (node:test) to vitest, with sip-vault's
// program id as the settle marker. The one bug that mattered — a failed
// transaction wedging a wallet forever — survived a full mainnet drill because
// scripted drills do not fail. These are the cases that drill could never
// produce.

import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { isExternalFlowTx } from "../src/measure-window.js";
import { tightenMinOut } from "../src/min-out.js";

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
// These assert the SHAPE of the fix rather than re-running an RPC walk: the
// walk itself is exercised against the chain by the keeper's dry run. What must
// never regress is the decision to include failed signatures.

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
