// The measurement decides how much of a user's money moves. Until now nothing
// tested it, and the one bug that mattered — a failed transaction wedging a
// wallet forever — survived a full mainnet drill because scripted drills do not
// fail. These are the cases that drill could never produce.
//
// Run: node --test --experimental-strip-types keeper/test/*.test.mts

import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";

import { isExternalFlowTx } from "../src/measure-window.ts";

const NUVEM = "7rtgXTu852M1NTx7PLoJd3bChaCb2hgsgv5o54aFv6Fy";
const SYSTEM = "11111111111111111111111111111111";
const ED25519 = "Ed25519SigVerify111111111111111111111111111";
const COMPUTE = "ComputeBudget111111111111111111111111111111";
const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const RAYDIUM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

test("a real settle counts as external flow, so it does not depress the next window", () => {
  // Measured from a real mainnet settle: {Ed25519, nuvem, System}.
  assert.equal(isExternalFlowTx([ED25519, NUVEM, SYSTEM], NUVEM), true);
});

test("a plain deposit is external flow", () => {
  assert.equal(isExternalFlowTx([SYSTEM], NUVEM), true);
  assert.equal(isExternalFlowTx([SYSTEM, COMPUTE], NUVEM), true);
});

test("a clean trade is trading", () => {
  assert.equal(isExternalFlowTx([JUPITER, SYSTEM], NUVEM), false);
});

test("LAUNDERING: a trade bundled with our own instruction stays trading", () => {
  // The whole reason this predicate is exclusivity-based rather than
  // presence-based. The trading wallet is exported to Axiom, so its owner signs
  // its transactions and could append a 1-lamport wrap_sol to every winning
  // trade — erasing the win from the skim if presence were enough.
  assert.equal(isExternalFlowTx([NUVEM, JUPITER, SYSTEM], NUVEM), false);
  assert.equal(isExternalFlowTx([NUVEM, RAYDIUM], NUVEM), false);
});

test("without a settle program id, only the pure set is flow", () => {
  assert.equal(isExternalFlowTx([SYSTEM], undefined), true);
  assert.equal(isExternalFlowTx([NUVEM, SYSTEM], undefined), false);
});

// ── the wedge ───────────────────────────────────────────────────────────────
//
// These assert the SHAPE of the fix rather than re-running an RPC walk: the
// walk itself is exercised against mainnet by the supervisor's dry run. What
// must never regress is the decision to include failed signatures.

test("failed transactions are not filtered out of the walk", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.promises.readFile(new URL("../src/measure-window.ts", import.meta.url), "utf8"),
  );
  // The exact line that caused a permanent wedge: skipping failures left the
  // fee they charged outside the balance chain, so the next real transaction
  // registered a break and settle refused forever.
  assert.ok(
    !/if\s*\(\s*info\.err\s*!==\s*null\s*\)\s*continue/.test(source),
    "failed signatures must be WALKED — skipping them breaks the balance chain and wedges the wallet",
  );
});

test("PublicKey round-trips the program id used as the settle marker", () => {
  assert.equal(new PublicKey(NUVEM).toBase58(), NUVEM);
});

// ── slippage ────────────────────────────────────────────────────────────────

import { tightenMinOut } from "../src/min-out.ts";

test("a live observation tightens min_out far above the lab floor", () => {
  // The tester's real purchase: 1.00 USDC in, 464278 raw NVDAx out.
  const observed = { inRaw: 1_000_000n, outRaw: 464_278n };
  // The floor the web writes: amountIn * 1e15 / 1e18 = amountIn / 1000.
  const floor = 1_000_000n / 1000n; // 1000 raw units — ~460x below market
  const { minOut, live } = tightenMinOut(1_000_000n, floor, observed);
  assert.equal(live, true);
  // 2% under the observed rate, and hugely tighter than the floor.
  assert.equal(minOut, (464_278n * 9800n) / 10_000n);
  assert.ok(minOut > floor * 400n, "the live bound must dwarf the lab floor");
});

test("without an observation it falls back to the floor and admits it", () => {
  const floor = 1_000n;
  const { minOut, live } = tightenMinOut(1_000_000n, floor, null);
  assert.equal(minOut, floor);
  assert.equal(live, false, "no observation must never be reported as live protection");
});

test("min_out is NEVER below the floor the owner signed", () => {
  // A collapsing pool: the observed rate is worse than the user's own floor.
  const observed = { inRaw: 1_000_000n, outRaw: 10n };
  const floor = 500_000n;
  const { minOut, live } = tightenMinOut(1_000_000n, floor, observed);
  assert.equal(minOut, floor, "the program requires min_out >= floor; tightening is the only direction");
  assert.equal(live, false);
});

test("a zero-input observation cannot divide by zero", () => {
  const { minOut, live } = tightenMinOut(1_000n, 7n, { inRaw: 0n, outRaw: 5n });
  assert.equal(minOut, 7n);
  assert.equal(live, false);
});
