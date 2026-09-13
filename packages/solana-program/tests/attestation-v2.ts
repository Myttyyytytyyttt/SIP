// The V2 attestation bytes, pinned. The unit test in attestation.rs holds the
// same vector, and neither mirror produced it: it was computed with Python's
// struct.pack from the inputs below. If the keeper, the web or the program
// drifts by one byte, a signature stops verifying on chain; this fails first.

import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { ATTESTATION_MESSAGE_LEN, attestationMessage, MODE_VOLUME } from "../scripts/attestation";

const GOLDEN_V2_HEX =
  "5349505f534554544c455f5632000000010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303080706050403020109000000000000006400000000000000c80000000000000000ca9a3b0000000001140003000000000000002c01000000000000";

describe("attestation V2 bytes", () => {
  it("the TypeScript mirror matches the golden vector byte for byte", () => {
    const key = (byte: number) => new PublicKey(Buffer.alloc(32, byte));
    const message = attestationMessage({
      programId: key(1),
      wallet: key(2),
      vault: key(3),
      linkEpoch: 0x0102030405060708n,
      settlementNonce: 9n,
      sessionStartSlot: 100n,
      sessionEndSlot: 200n,
      baseLamports: 1_000_000_000n,
      mode: MODE_VOLUME,
      bps: 20,
      policyNonce: 3n,
      validUntilSlot: 300n,
    });
    assert.strictEqual(message.length, ATTESTATION_MESSAGE_LEN);
    assert.strictEqual(ATTESTATION_MESSAGE_LEN, 171);
    assert.strictEqual(message.toString("hex"), GOLDEN_V2_HEX);
  });
});
