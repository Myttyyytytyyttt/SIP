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
import type { AttestationInputs } from "./program-scripts.js";

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
