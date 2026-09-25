// The four modules the keeper shares with @sip/solana-program, unwrapped once.
//
// SHARED, NOT COPIED. Nuvem's keeper imported ../../scripts relatively from
// inside the lab; SIP's lives in its own package and takes the attestation
// mirror, the live route reader, the Raydium swap builder and the Jupiter
// route builder through @sip/solana-program's `exports`. The attestation bytes in particular must be
// the program's own mirror — the one pinned to attestation.rs by a golden
// vector — never a second copy that can drift and sign bytes nothing verifies.
//
// WHY AN UNWRAP. @sip/solana-program is a CommonJS package: its Anchor suite runs
// mocha over a commonjs tsconfig, and its scripts use __dirname. So Node loads
// these .ts files as CommonJS, and under tsx an ES module importing one sees
// ONLY `default` (module.exports) — tsx's CommonJS output carries nothing Node's
// export lexer can read, so `import { attestationInstruction }` fails at startup
// with "does not provide an export named". Vitest transforms the same file as
// ESM and hands back the named exports with no `default`. Both measured on
// 2026-09-13 (tsx 4.23.1 and 4.23.13, vitest 3.2.4). The namespace is taken
// whole and unwrapped here, and every other keeper file imports from this one.
//
// AND A MEASUREMENT THAT ARGUES WITH THAT, KEPT BECAUSE IT DOES. Measured in
// this worktree on 2026-09-21 — Node v22.14.0, tsx 4.23.1, pnpm 10.18.1 — by a
// real tsx run of an .mts importing @sip/solana-program/jupiter-route:
//
//     NAMED_KEY_COUNT: 33   HAS_DEFAULT: true   defaultKeyCount: 32
//     buildJupiterRoute: named=function unwrapped=function sameIdentity=true
//
// So for THIS module, under THESE versions, the named exports are present AND
// so is `default`, and the documented failure does not reproduce. What that is
// a measurement OF matters: one module, one tsx version, one day. The 09-13
// runs measured attestation, live-route and raydium-swap, and found the
// opposite. docs/TESTING_TRAPS.md's own rule — keep the old number, and when a
// new result disagrees, suspect the instrument before the tree — says the
// honest reading is that the shape is VERSION- AND MODULE-DEPENDENT, not that
// the earlier finding was wrong. The unwrap plus the import-time loop below is
// the only shape proven safe under BOTH runtimes, so a friendly probe is not a
// reason to drop it.

import * as attestationModule from "@sip/solana-program/attestation";
import * as jupiterRouteModule from "@sip/solana-program/jupiter-route";
import * as liveRouteModule from "@sip/solana-program/live-route";
import * as raydiumSwapModule from "@sip/solana-program/raydium-swap";

export type { AttestationInputs } from "@sip/solana-program/attestation";
export type {
  AgeTolerance,
  BuildJupiterRouteParams,
  JupiterQuote,
  JupiterRoute,
  LandingEpoch,
  RouteWarning,
  RouteWarningCondition,
} from "@sip/solana-program/jupiter-route";
export type { LiveRoute } from "@sip/solana-program/live-route";
export type { SwapV2Args, SwapV2Pool } from "@sip/solana-program/raydium-swap";

function unwrap<T extends object>(namespace: T): T {
  const inner = (namespace as { readonly default?: unknown }).default;
  return (inner !== null && typeof inner === "object" ? inner : namespace) as T;
}

const attestation = unwrap(attestationModule);
const jupiterRoute = unwrap(jupiterRouteModule);
const liveRoute = unwrap(liveRouteModule);
const raydiumSwap = unwrap(raydiumSwapModule);

export const ATTESTATION_MESSAGE_LEN = attestation.ATTESTATION_MESSAGE_LEN;
export const MODE_PROFIT = attestation.MODE_PROFIT;
export const MODE_VOLUME = attestation.MODE_VOLUME;
export const attestationInstruction = attestation.attestationInstruction;
export const attestationMessage = attestation.attestationMessage;
export const fetchLiveRoute = liveRoute.fetchLiveRoute;
export const JUPITER_PROGRAM = jupiterRoute.JUPITER_PROGRAM;
export const JupiterRouteRefusal = jupiterRoute.JupiterRouteRefusal;
export const buildJupiterRoute = jupiterRoute.buildJupiterRoute;
export const fitsLegacyTransaction = jupiterRoute.fitsLegacyTransaction;
export const investAmountIn = jupiterRoute.investAmountIn;
export const investMinOut = jupiterRoute.investMinOut;
export const legacyTransactionBytes = jupiterRoute.legacyTransactionBytes;
export const routeWarning = jupiterRoute.routeWarning;
export const v0TransactionBytes = jupiterRoute.v0TransactionBytes;
// THE DEPTH GATE'S OWN FOUR, added 2026-09-21 with the move to Jupiter. Every
// one of them is reached on a live invest turn — fetchJupiterQuote for ARM 2's
// probe, findVaultOwnedTokenAccounts and routeMints for the census's exclusion
// set, verifyRouteFresh for a route held across the wrap — so every one has to
// survive the unwrap, and joins the loop below that says so at import.
export const fetchJupiterQuote = jupiterRoute.fetchJupiterQuote;
export const findVaultOwnedTokenAccounts = jupiterRoute.findVaultOwnedTokenAccounts;
export const routeMints = jupiterRoute.routeMints;
export const verifyRouteFresh = jupiterRoute.verifyRouteFresh;
export const verifySharedAccountsRoute = jupiterRoute.verifySharedAccountsRoute;
// THE LANDING-EPOCH RULE, added 2026-09-25. The keeper sizes its slippage and
// the builder derives min_out from the SAME predicate and the SAME window, so
// the two cannot disagree about whether a written fee rise can reach a
// transaction built now (invest-decision.ts, worstCaseTransferFee).
export const LANDING_WINDOW_SLOTS = jupiterRoute.LANDING_WINDOW_SLOTS;
export const feeRiseCanLand = jupiterRoute.feeRiseCanLand;
export const resolveDestinationTransferFee = jupiterRoute.resolveDestinationTransferFee;
export const RAYDIUM_CLMM = raydiumSwap.RAYDIUM_CLMM;
export const buildSwapV2AccountMetas = raydiumSwap.buildSwapV2AccountMetas;
export const buildSwapV2Data = raydiumSwap.buildSwapV2Data;

// LOUD AT IMPORT, not at the first settle: an unwrap that found nothing means
// the package no longer loads the way this file assumes, and --preflight runs
// at image build time precisely to hit this line.
for (const [name, value] of Object.entries({
  attestationInstruction,
  attestationMessage,
  fetchLiveRoute,
  buildSwapV2AccountMetas,
  buildSwapV2Data,
  // THE JUPITER NAMES JOIN THE LOOP, and this is not a formality. Under tsx an
  // ES module importing this CommonJS package sees only `default`; the unwrap
  // above is what turns that back into names, and a name that unwrapped to
  // undefined fails HERE, at import, rather than at the first basket the
  // keeper tries to buy. JupiterRouteRefusal is a class, whose typeof is
  // "function" like the rest.
  JupiterRouteRefusal,
  buildJupiterRoute,
  fitsLegacyTransaction,
  investAmountIn,
  investMinOut,
  legacyTransactionBytes,
  routeWarning,
  v0TransactionBytes,
  fetchJupiterQuote,
  findVaultOwnedTokenAccounts,
  routeMints,
  verifyRouteFresh,
  verifySharedAccountsRoute,
  feeRiseCanLand,
  resolveDestinationTransferFee,
})) {
  if (typeof value !== "function") {
    throw new Error(`@sip/solana-program did not provide ${name}: the CommonJS/ESM unwrap in program-scripts.ts no longer matches how it loads`);
  }
}

// THE SAME CHECK FOR A VALUE THAT IS NOT A FUNCTION, AND IT IS NOT OPTIONAL
// HOUSEKEEPING: the loop above tests `typeof value !== "function"`, so putting
// JUPITER_PROGRAM — a PublicKey — into it would throw at EVERY import and the
// keeper would never boot. RAYDIUM_CLMM and
// JUPITER_PROGRAM are the two venue addresses this keeper can build a route
// for, and an unwrap that lost one of them would otherwise surface as a
// `undefined.equals(...)` deep inside a venue comparison, on a live turn.
for (const [name, value] of Object.entries({ RAYDIUM_CLMM, JUPITER_PROGRAM })) {
  if (typeof value?.toBase58 !== "function") {
    throw new Error(`@sip/solana-program did not provide ${name} as a PublicKey: the CommonJS/ESM unwrap in program-scripts.ts no longer matches how it loads`);
  }
}

// AND THE WINDOW, A BIGINT: an unwrap that lost it would compare every
// slotsLeftInEpoch against undefined, which is false, and silently never let a
// rise at the next epoch reach min_out — the direction that reverts.
if (typeof LANDING_WINDOW_SLOTS !== "bigint") {
  throw new Error("@sip/solana-program did not provide LANDING_WINDOW_SLOTS as a bigint: the CommonJS/ESM unwrap in program-scripts.ts no longer matches how it loads");
}
