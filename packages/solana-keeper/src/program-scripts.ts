// The three modules the keeper shares with @sip/solana-program, unwrapped once.
//
// SHARED, NOT COPIED. Nuvem's keeper imported ../../scripts relatively from
// inside the lab; SIP's lives in its own package and takes the attestation
// mirror, the live route reader and the Raydium swap builder through
// @sip/solana-program's `exports`. The attestation bytes in particular must be
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
import * as liveRouteModule from "@sip/solana-program/live-route";
import * as raydiumSwapModule from "@sip/solana-program/raydium-swap";

export type { AttestationInputs } from "@sip/solana-program/attestation";
export type { LiveRoute } from "@sip/solana-program/live-route";
export type { SwapV2Args, SwapV2Pool } from "@sip/solana-program/raydium-swap";

function unwrap<T extends object>(namespace: T): T {
  const inner = (namespace as { readonly default?: unknown }).default;
  return (inner !== null && typeof inner === "object" ? inner : namespace) as T;
}

const attestation = unwrap(attestationModule);
const liveRoute = unwrap(liveRouteModule);
const raydiumSwap = unwrap(raydiumSwapModule);

export const ATTESTATION_MESSAGE_LEN = attestation.ATTESTATION_MESSAGE_LEN;
export const MODE_PROFIT = attestation.MODE_PROFIT;
export const MODE_VOLUME = attestation.MODE_VOLUME;
export const attestationInstruction = attestation.attestationInstruction;
export const attestationMessage = attestation.attestationMessage;
export const fetchLiveRoute = liveRoute.fetchLiveRoute;
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
})) {
  if (typeof value !== "function") {
    throw new Error(`@sip/solana-program did not provide ${name}: the CommonJS/ESM unwrap in program-scripts.ts no longer matches how it loads`);
  }
}
