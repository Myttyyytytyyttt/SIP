// The program's golden attestation vector, carried by the keeper itself.
//
// A COPY, WHERE program-scripts.ts INSISTS ON SHARING. That rule is about the
// ENCODER: two encoders drift and sign bytes nothing verifies. This is the
// opposite, a fixed answer the shared encoder is checked against, and it has to
// live in the keeper because the image carries no attestation.rs: the Dockerfile
// copies only scripts/attestation.ts, and --preflight runs inside that image at
// build time. test/attestation-golden.test.ts reads attestation.rs and fails the
// day this copy and the program's own vector differ by one character.
//
// COMPUTED BY NEITHER MIRROR. attestation.rs records that the hex came from
// Python's struct.pack over the inputs below, so a mistake the Rust and the
// TypeScript encoders share cannot also be in the vector.

import { PublicKey } from "@solana/web3.js";
import type { AttestationInputs, AttestationV3Inputs } from "./program-scripts.js";

/** attestation.rs's GOLDEN_V2_HEX, verbatim: 171 bytes. */
export const GOLDEN_V2_HEX =
  "5349505f534554544c455f5632000000010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303080706050403020109000000000000006400000000000000c80000000000000000ca9a3b0000000001140003000000000000002c01000000000000";

/**
 * The inputs attestation.rs's unit test encodes to GOLDEN_V2_HEX, field for
 * field: a VOLUME attestation (mode 1) at 20 bps.
 */
export const GOLDEN_V2_INPUTS: AttestationInputs = {
  programId: new PublicKey(Buffer.alloc(32, 1)),
  wallet: new PublicKey(Buffer.alloc(32, 2)),
  vault: new PublicKey(Buffer.alloc(32, 3)),
  linkEpoch: 0x0102_0304_0506_0708n,
  settlementNonce: 9n,
  sessionStartSlot: 100n,
  sessionEndSlot: 200n,
  baseLamports: 1_000_000_000n,
  mode: 1,
  bps: 20,
  policyNonce: 3n,
  validUntilSlot: 300n,
};

/** attestation.rs's GOLDEN_V3_ROUNDUP_HEX, verbatim: 229 bytes (ADR §5.4's SIP_SETTLE_V3). */
export const GOLDEN_V3_ROUNDUP_HEX =
  "5349505f534554544c455f5633000000010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303080706050403020109000000000000006400000000000000c800000000000000aab02800000000000203000000000000002c010000000000000100000080d1f0080000000064000000000000006400000000000000e90d52c052eaaf5aa44d9c0126c3c197e300064f4840256b1a3e13cce8182383";

/** attestation.rs's GOLDEN_V3_FIXED_HEX, verbatim. */
export const GOLDEN_V3_FIXED_HEX =
  "5349505f534554544c455f5633000000010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303080706050403020109000000000000006400000000000000c800000000000000c0cf6a00000000000303000000000000002c0100000000000007000000000000000000000040420f000000000080969800000000000000000000000000000000000000000000000000000000000000000000000000";

/**
 * The inputs attestation.rs's V3 tests encode to GOLDEN_V3_ROUNDUP_HEX: the
 * ADR's $1.60 trade at $150 (2 666 666 lamports), a $1 unit and a $1 minimum,
 * one trade at slot 500 whose signature is 64 × 0x11. Its prices hash is the
 * vector's own last 32 bytes; test/attestation-golden.test.ts recomputes it with
 * the program's pricesHash.
 */
export const GOLDEN_V3_ROUNDUP_INPUTS: AttestationV3Inputs = {
  programId: new PublicKey(Buffer.alloc(32, 1)),
  wallet: new PublicKey(Buffer.alloc(32, 2)),
  vault: new PublicKey(Buffer.alloc(32, 3)),
  linkEpoch: 0x0102_0304_0506_0708n,
  settlementNonce: 9n,
  sessionStartSlot: 100n,
  sessionEndSlot: 200n,
  amountLamports: 2_666_666n,
  mode: 2,
  policyNonce: 3n,
  validUntilSlot: 300n,
  tradeCount: 1,
  priceMinUsdE6: 150_000_000n,
  modeParam: 100n,
  minTrade: 100n,
  pricesHash: Buffer.from("e90d52c052eaaf5aa44d9c0126c3c197e300064f4840256b1a3e13cce8182383", "hex"),
};

/** …and GOLDEN_V3_FIXED_HEX's: seven trades at F = 0.001 SOL, a 0.01 SOL minimum, no price, a zero hash. */
export const GOLDEN_V3_FIXED_INPUTS: AttestationV3Inputs = {
  ...GOLDEN_V3_ROUNDUP_INPUTS,
  amountLamports: 7_000_000n,
  mode: 3,
  tradeCount: 7,
  priceMinUsdE6: 0n,
  modeParam: 1_000_000n,
  minTrade: 10_000_000n,
  pricesHash: Buffer.alloc(32),
};
