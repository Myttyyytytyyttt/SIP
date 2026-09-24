// The slippage bound, in raw units, over the numbers a real purchase produced.
//
// The four zero-fee vectors moved here from measure-window.test.ts UNCHANGED,
// because no change to this module may move them: a mint that charges nothing
// must price exactly as it always did, and the old arithmetic is re-derived
// below to prove it rather than asserted from memory.
//
// THE REST OF THIS FILE GUARDS ONE REGRESSION, described in full at the top of
// src/min-out.ts. Until 2026-09-20 `observed` was measured by walking real
// swaps and reading the pool OUTPUT VAULT's outflow — GROSS, before Token-2022
// withholds the output mint's transfer fee — so this module took that fee off
// before applying SLIPPAGE_BPS. live-route.ts now derives the rate from the
// pool's own account and composes BOTH mints' transfer fees into it, so the
// number arriving here is already the NET credit. Subtracting the fee again
// would be invisible in every way that normally protects us: no throw, no
// revert, no red test — just a smaller `expected`, hence a LOWER min_out,
// hence a keeper that accepts a fill WORSE than its bound claims to guarantee.
//
// So the assertions below are written against the ONE quantity that catches it:
// the tolerance actually left between the credited amount and min_out. It must
// be SLIPPAGE_BPS and nothing else. At the 50 bps both PreStocks mints have
// charged since epoch 1032 a second subtraction makes it 249; at the 100 bps
// scheduled for epoch 1039, 298.

import { describe, expect, it } from "vitest";
import { MAX_LEG_FEE_BPS } from "../src/invest-decision.js";
import { NO_TRANSFER_FEE, SLIPPAGE_BPS, netOfTransferFee, tightenMinOut } from "../src/min-out.js";

/** u64::MAX: maximum_fee on both PreStocks mints, i.e. no cap at all. */
const UNCAPPED = (1n << 64n) - 1n;

describe("min_out", () => {
  it("a live observation tightens min_out far above the lab floor", () => {
    // The tester's real purchase: 1.00 USDC in, 464278 raw stock out.
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
    // NOT "no price was observable": the price was read and its bound simply
    // lost to the floor. invest-tick.ts's log says so in those words.
    expect(live).toBe(false);
  });

  it("a zero-input observation cannot divide by zero", () => {
    const { minOut, live } = tightenMinOut(1_000n, 7n, { inRaw: 0n, outRaw: 5n });
    expect(minOut).toBe(7n);
    expect(live).toBe(false);
  });

  it("prices EXACTLY as it did before any transfer fee was ever involved", () => {
    // The arithmetic this module had before the fee existed, re-derived here so
    // the claim is proved against the current code rather than remembered.
    const before = (amountIn: bigint, floor: bigint, o: { inRaw: bigint; outRaw: bigint }): bigint => {
      const bounded = (((amountIn * o.outRaw) / o.inRaw) * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      return bounded <= floor ? floor : bounded;
    };
    const vectors = [
      { amountIn: 1_000_000n, floor: 1_000n, observed: { inRaw: 1_000_000n, outRaw: 464_278n } },
      { amountIn: 7n, floor: 1n, observed: { inRaw: 1_000_000n, outRaw: 464_278n } },
      { amountIn: 3_333_333n, floor: 3_333n, observed: { inRaw: 999_999n, outRaw: 1n } },
      { amountIn: 500_000_000n, floor: 0n, observed: { inRaw: 1n, outRaw: 1_000_000_000n } },
    ];
    for (const v of vectors) {
      expect(tightenMinOut(v.amountIn, v.floor, v.observed).minOut).toBe(before(v.amountIn, v.floor, v.observed));
    }
  });
});

describe("the transfer fee is netted ONCE, in live-route.ts, and never again here", () => {
  const AMOUNT_IN = 1_000_000n; // 1.00 USDC
  /** The pool's GROSS outflow for that buy — what the old signature-walk measured. */
  const GROSS = 464_278n;
  const floor = 1_000n;

  /**
   * `observed` exactly as live-route.ts's observedRate now builds it: the fee is
   * a pure multiplication by (10_000 - bps) on outRaw, with the matching scale
   * left on inRaw so the ratio stays exact. NOT Token-2022's rounding — the
   * route nets the RATE, and deliberately so; the comment there records that
   * where maximum_fee binds the quote is low and min_out ends up loose, which
   * is the safe direction.
   */
  const netRate = (feeBps: bigint) => ({ inRaw: AMOUNT_IN * 10_000n, outRaw: GROSS * (10_000n - feeBps) });

  /**
   * What this module would produce if it ALSO took the fee off — i.e. the exact
   * shape of the bug, reconstructed so the assertions can name it rather than
   * gesture at it. This is the code that was here before the merge.
   */
  const subtractedTwice = (feeBps: bigint): bigint => {
    const o = netRate(feeBps);
    const expected = netOfTransferFee((AMOUNT_IN * o.outRaw) / o.inRaw, { bps: feeBps, maximumFee: UNCAPPED });
    return (expected * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  };

  // Real rates on Pren1FvF… (ANTHROPIC) and PreZad18… (FIGUREAI): 50 bps since
  // epoch 1032, 100 bps scheduled for 1039, and 199 as the last rate the leg
  // admission gate would ever have let through had its ceiling been SLIPPAGE_BPS.
  const cases = [
    { feeBps: 0n, credited: 464_278n, minOut: 454_992n, doubledTolerance: 200n },
    { feeBps: 50n, credited: 461_956n, minOut: 452_716n, doubledTolerance: 249n },
    { feeBps: 100n, credited: 459_635n, minOut: 450_442n, doubledTolerance: 298n },
    { feeBps: 199n, credited: 455_038n, minOut: 445_937n, doubledTolerance: 395n },
  ] as const;

  it.each(cases)(
    "at $feeBps bps leaves EXACTLY the slippage bound, not $doubledTolerance bps",
    ({ feeBps, credited, minOut: expectedMinOut, doubledTolerance }) => {
      const observed = netRate(feeBps);

      // What the vault's own ATA is credited at this rate — the quantity
      // invest.rs and swap_v2 compare their thresholds against.
      expect((AMOUNT_IN * observed.outRaw) / observed.inRaw).toBe(credited);

      const { minOut, live } = tightenMinOut(AMOUNT_IN, floor, observed);
      expect(live).toBe(true);
      expect(minOut).toBe(expectedMinOut);

      // THE ASSERTION THAT CATCHES THE REGRESSION. The tolerance the keeper
      // really leaves itself, measured against the credited amount, is the
      // bound it names and nothing more.
      expect(((credited - minOut) * 10_000n) / credited).toBe(SLIPPAGE_BPS);

      // And the same number computed the broken way is strictly looser, so this
      // test cannot pass with the second subtraction reinstated.
      const twice = subtractedTwice(feeBps);
      expect(((credited - twice) * 10_000n) / credited).toBe(doubledTolerance);
      if (feeBps > 0n) {
        expect(twice < minOut, "subtracting twice always LOWERS min_out — a weaker demand, not a stricter one").toBe(true);
      }
    },
  );

  it("the fee is not an input at all: same rate, same min_out, whatever the mint charges", () => {
    // Two mints charging 50 and 100 bps differ ONLY through the rate live-route
    // hands over. Given the SAME rate, this module cannot tell them apart — which
    // is the structural reason the fee cannot be applied twice from in here.
    const same = { inRaw: 1_000_000n, outRaw: 464_278n };
    expect(tightenMinOut(AMOUNT_IN, floor, same).minOut).toBe(tightenMinOut(AMOUNT_IN, floor, same).minOut);
    expect(tightenMinOut(AMOUNT_IN, floor, same).minOut).toBe(454_992n);
    // Pinned so that re-adding a fee parameter is a red test and not a quiet
    // edit: the signature is (amountIn, floor, observed) and nothing else.
    expect(tightenMinOut.length, "tightenMinOut must take no fee argument — see the header of src/min-out.ts").toBe(3);
  });

  it("a fee is bounded by invest-decision.ts's ceiling, which since 2026-09-24 sits ABOVE the old throw — so the throw must stay gone", () => {
    // This module used to throw when the output mint's fee reached SLIPPAGE_BPS,
    // on the ground that the fee had eaten the whole tolerance. Netting the rate
    // in live-route.ts removed that ground — the tolerance here is 200 bps at
    // every rate — and the refusal that protects the basket lives in
    // invest-decision.ts, where it refuses the WHOLE basket before a lamport
    // moves. While that ceiling was 100 the old throw could never have fired.
    // THE OWNER RAISED IT TO 300 ON 2026-09-24: a leg the keeper now buys
    // charges MORE than SLIPPAGE_BPS, so the old throw would refuse it. This is
    // the test that says the throw is not coming back.
    expect(MAX_LEG_FEE_BPS).toBe(300n);
    expect(MAX_LEG_FEE_BPS > SLIPPAGE_BPS, "the ceiling is above the old throw's threshold").toBe(true);
    // A rate observed net of a 300 bps fee prices exactly like any other: the
    // tolerance between the credit and min_out is SLIPPAGE_BPS, not less.
    const net300 = { inRaw: 1_000_000n, outRaw: netOfTransferFee(464_278n, { bps: MAX_LEG_FEE_BPS, maximumFee: UNCAPPED }) };
    const { minOut, live } = tightenMinOut(1_000_000n, 1_000n, net300);
    expect(live).toBe(true);
    expect(minOut).toBe((net300.outRaw * (10_000n - SLIPPAGE_BPS)) / 10_000n);
  });
});

describe("netOfTransferFee still models Token-2022's calculate_fee", () => {
  /** What those mints have charged since epoch 1032. */
  const PRESTOCKS_FEE = { bps: 50n, maximumFee: UNCAPPED } as const;

  it("rounds the fee UP and honours maximum_fee, as Token-2022's calculate_fee does", () => {
    // 1 raw unit at 50 bps owes 0.005 — and Token-2022 still takes one.
    expect(netOfTransferFee(1n, PRESTOCKS_FEE)).toBe(0n);
    expect(netOfTransferFee(200n, PRESTOCKS_FEE)).toBe(199n);
    expect(netOfTransferFee(201n, PRESTOCKS_FEE)).toBe(199n); // 1.005 → 2
    // A capped mint pays the cap, however large the transfer.
    expect(netOfTransferFee(1_000_000n, { bps: 50n, maximumFee: 100n })).toBe(999_900n);
    // Nothing at all: gross through, whatever the cap says.
    expect(netOfTransferFee(1_000_000n, NO_TRANSFER_FEE)).toBe(1_000_000n);
    expect(netOfTransferFee(0n, PRESTOCKS_FEE)).toBe(0n);
  });
});

// ─── THE GUARD THE ARITHMETIC TESTS ABOVE CANNOT BE ───────────────────────────
//
// Measured on this branch, 2026-09-20, by reinstating the bug and running
// everything: give `tightenMinOut` an OPTIONAL fourth `outFee` parameter
// defaulting to NO_TRANSFER_FEE, call netOfTransferFee on `expected` again, and
// pass `admission.fees.get(mint)!` from invest-tick.ts — and `tsc --noEmit`
// exits 0 while all twelve tests above stay green. They must: every one of them
// calls the function with three arguments, so the default absorbs the change and
// the second subtraction only ever happens in production, on the leg path, to a
// real user's money. The `tightenMinOut.length` assertion does not help either;
// a parameter with a default does not count toward `.length`.
//
// So the property is checked where it is actually visible: in the SOURCE. This
// is the same idiom as test/anchor-interop.test.ts, which greps src/ and bin/
// for `new anchor.BN(` because the outage it guards cannot be reproduced under
// vitest either. Comments are stripped first, so prose is free to discuss the
// rule — as min-out.ts's header does at length — without tripping the guard.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith(".ts") || path.endsWith(".mts")) out.push(path);
  }
  return out;
}

/** Block and line comments out, so the guards read code and not prose about code. */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/** Every `callee(...)` in `source`, as its top-level argument list. */
function callArgumentLists(source: string, callee: string): string[][] {
  const calls: string[][] = [];
  const needle = `${callee}(`;
  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + needle.length)) {
    // Not a call if the name is part of a longer identifier (e.g. a rename).
    const before = source[at - 1];
    if (before !== undefined && /[A-Za-z0-9_$.]/.test(before)) continue;
    const args: string[] = [];
    let arg = "";
    let depth = 1;
    let i = at + needle.length;
    for (; i < source.length && depth > 0; i++) {
      const c = source[i]!;
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      if (depth === 0) break;
      if (c === "," && depth === 1) {
        args.push(arg.trim());
        arg = "";
      } else arg += c;
    }
    if (arg.trim() !== "") args.push(arg.trim());
    calls.push(args);
  }
  return calls;
}

describe("nothing in src/ may net the transfer fee a second time", () => {
  const files = sourceFiles(join(here, "src")).concat(sourceFiles(join(here, "bin")));

  // THE GUARD MOVED WITH THE MONEY PATH, 2026-09-21. It used to require both
  // tightenMinOut call sites — the convert hop and the leg — to pass exactly
  // three arguments, because a fourth was the second subtraction. There are now
  // ZERO call sites: the keeper buys through Jupiter, and min_out comes from
  // investMinOut(route), which derives the venue's own floor from the bytes
  // about to be signed and nets the fee off it exactly once, inside
  // jupiter-route.ts.
  //
  // SO THE COUNT IS PINNED AT ZERO RATHER THAN THE GUARD DELETED. A call
  // reappearing means somebody put a keeper-computed bound back on a money path
  // that no longer observes its own rate, and that is worth stopping to think
  // about rather than discovering in a diff.
  it("has no tightenMinOut call sites left on the money path, and says so deliberately", () => {
    const callSites = files
      .filter((path) => !path.endsWith("min-out.ts"))
      .flatMap((path) => callArgumentLists(codeOnly(readFileSync(path, "utf8")), "tightenMinOut").map((args) => ({ path, args })));
    expect(
      callSites.map(({ path, args }) => `${path.slice(here.length)} (${args.length} args)`),
      "the invest and convert paths derive min_out from investMinOut(route) now. A tightenMinOut call here is a " +
        "second, keeper-computed bound on a route whose own floor is already known — decide it on purpose.",
    ).toEqual([]);
  });

  // AND THE SUBTRACTION ITSELF, WHEREVER IT LIVES. This is what the old
  // argument-count rule was really protecting: the fee comes off the bound
  // ONCE. investMinOut does it, in jupiter-route.ts, over the instruction's own
  // tail. A second application anywhere in the keeper would lower min_out below
  // what the bound claims and hand the program a floor the owner never agreed
  // to — and it would do it silently, because a smaller min_out still fills.
  it("never applies netOfTransferFee itself: the one subtraction lives in the route builder", () => {
    const callers = files
      .filter((path) => !path.endsWith("min-out.ts"))
      .filter((path) => callArgumentLists(codeOnly(readFileSync(path, "utf8")), "netOfTransferFee").length > 0)
      .map((path) => path.slice(here.length));
    expect(
      callers,
      "investMinOut already took this leg's transfer fee off the venue threshold. Taking it off again halves the " +
        "margin twice over — see the header of src/min-out.ts.",
    ).toEqual([]);
  });

  it("tightenMinOut's own body never calls netOfTransferFee", () => {
    const source = codeOnly(readFileSync(join(here, "src/min-out.ts"), "utf8"));
    const body = source.slice(source.indexOf("export function tightenMinOut"));
    expect(body.length > 0, "tightenMinOut must still exist under that name").toBe(true);
    expect(
      body.includes("netOfTransferFee"),
      "tightenMinOut must not net the transfer fee: live-route.ts's observedRate already did it, " +
        "and doing it twice lowers min_out below the bound SLIPPAGE_BPS names.",
    ).toBe(false);
  });
});
