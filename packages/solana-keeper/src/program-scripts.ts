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

import * as attestationModule from "@sip/solana-program/attestation";
import * as jupiterRouteModule from "@sip/solana-program/jupiter-route";
import * as liveRouteModule from "@sip/solana-program/live-route";
import * as raydiumSwapModule from "@sip/solana-program/raydium-swap";

export type { AttestationInputs } from "@sip/solana-program/attestation";
export type {
  BuildJupiterRouteParams,
  JupiterRoute,
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
})) {
  if (typeof value !== "function") {
    throw new Error(`@sip/solana-program did not provide ${name}: the CommonJS/ESM unwrap in program-scripts.ts no longer matches how it loads`);
  }
}

// THE SAME CHECK FOR A VALUE THAT IS NOT A FUNCTION. RAYDIUM_CLMM and
// JUPITER_PROGRAM are the two venue addresses this keeper can build a route
// for, and an unwrap that lost one of them would otherwise surface as a
// `undefined.equals(...)` deep inside a venue comparison, on a live turn.
for (const [name, value] of Object.entries({ RAYDIUM_CLMM, JUPITER_PROGRAM })) {
  if (typeof value?.toBase58 !== "function") {
    throw new Error(`@sip/solana-program did not provide ${name} as a PublicKey: the CommonJS/ESM unwrap in program-scripts.ts no longer matches how it loads`);
  }
}
