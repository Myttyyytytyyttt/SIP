// The V3 attestation bytes, pinned. attestation.rs's unit tests hold the same
// two vectors, and neither mirror produced them: they were computed with
// Python's struct.pack from the inputs below. A drift of one byte in the keeper,
// the web or the program is a signature that never verifies on chain; this
// fails first.

import { Keypair, PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import {
  ATTESTATION_MESSAGE_LEN,
  ATTESTATION_V3_MESSAGE_LEN,
  attestationMessage,
  attestationV3Instruction,
  attestationV3Message,
  MODE_FIXED,
  MODE_ROUNDUP,
  MODE_VOLUME,
  type AttestationV3Inputs,
} from "../scripts/attestation";
import { pricesHash, pricesHashWords } from "../scripts/per-trade";

const GOLDEN_V3_ROUNDUP_HEX =
  "5349505f534554544c455f5633000000010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303080706050403020109000000000000006400000000000000c800000000000000aab02800000000000203000000000000002c010000000000000100000080d1f0080000000064000000000000006400000000000000e90d52c052eaaf5aa44d9c0126c3c197e300064f4840256b1a3e13cce8182383";
const GOLDEN_V3_FIXED_HEX =
  "5349505f534554544c455f5633000000010101010101010101010101010101010101010101010101010101010101010102020202020202020202020202020202020202020202020202020202020202020303030303030303030303030303030303030303030303030303030303030303080706050403020109000000000000006400000000000000c800000000000000c0cf6a00000000000303000000000000002c0100000000000007000000000000000000000040420f000000000080969800000000000000000000000000000000000000000000000000000000000000000000000000";

const key = (byte: number) => new PublicKey(Buffer.alloc(32, byte));

/** One $1.60 trade at $150, unit $1, minimum $1: the ADR's worked example. */
const ROUNDUP: AttestationV3Inputs = {
  programId: key(1),
  wallet: key(2),
  vault: key(3),
  linkEpoch: 0x0102030405060708n,
  settlementNonce: 9n,
  sessionStartSlot: 100n,
  sessionEndSlot: 200n,
  amountLamports: 2_666_666n,
  mode: MODE_ROUNDUP,
  policyNonce: 3n,
  validUntilSlot: 300n,
  tradeCount: 1,
  priceMinUsdE6: 150_000_000n,
  modeParam: 100n,
  minTrade: 100n,
  pricesHash: pricesHash([{ slot: 500n, signature: Buffer.alloc(64, 0x11), priceUsdE6: 150_000_000n }]),
};

describe("attestation V3 bytes", () => {
  it("the round-up vector: the TypeScript mirror matches it byte for byte", () => {
    const message = attestationV3Message(ROUNDUP);
    assert.strictEqual(ATTESTATION_V3_MESSAGE_LEN, 229);
    assert.strictEqual(message.length, ATTESTATION_V3_MESSAGE_LEN);
    assert.strictEqual(message.toString("hex"), GOLDEN_V3_ROUNDUP_HEX);
  });

  it("the fixed vector: seven trades at F = 0.001 SOL, no price, a zero hash", () => {
    const message = attestationV3Message({
      ...ROUNDUP,
      amountLamports: 7_000_000n,
      mode: MODE_FIXED,
      tradeCount: 7,
      priceMinUsdE6: 0n,
      modeParam: 1_000_000n,
      minTrade: 10_000_000n,
      pricesHash: Buffer.alloc(32),
    });
    assert.strictEqual(message.toString("hex"), GOLDEN_V3_FIXED_HEX);
  });

  it("puts every field where the program reads it", () => {
    const message = attestationV3Message(ROUNDUP);
    // domain 0, program 16, wallet 48, vault 80, epoch 112, nonce 120, start 128,
    // end 136, amount 144, mode 152, policy nonce 153, deadline 161, count 169,
    // price 173, unit 181, minimum 189, hash 197..229
    assert.isTrue(message.subarray(80, 112).equals(key(3).toBuffer()));
    assert.strictEqual(message.readBigUInt64LE(112), 0x0102030405060708n);
    assert.strictEqual(message.readBigUInt64LE(136), 200n);
    assert.strictEqual(message.readBigUInt64LE(144), 2_666_666n);
    assert.strictEqual(message[152], MODE_ROUNDUP);
    assert.strictEqual(message.readBigUInt64LE(153), 3n);
    assert.strictEqual(message.readBigUInt64LE(161), 300n);
    assert.strictEqual(message.readUInt32LE(169), 1);
    assert.strictEqual(message.readBigUInt64LE(173), 150_000_000n);
    assert.strictEqual(message.readBigUInt64LE(181), 100n);
    assert.strictEqual(message.readBigUInt64LE(189), 100n);
    assert.isTrue(message.subarray(197).equals(Buffer.from(ROUNDUP.pricesHash)));
  });

  it("can never be mistaken for a V2 message: another domain and another length", () => {
    const v2 = attestationMessage({
      programId: key(1),
      wallet: key(2),
      vault: key(3),
      linkEpoch: 0x0102030405060708n,
      settlementNonce: 9n,
      sessionStartSlot: 100n,
      sessionEndSlot: 200n,
      baseLamports: 2_666_666n,
      mode: MODE_VOLUME,
      bps: 20,
      policyNonce: 3n,
      validUntilSlot: 300n,
    });
    assert.notStrictEqual(ATTESTATION_MESSAGE_LEN, ATTESTATION_V3_MESSAGE_LEN);
    assert.isFalse(v2.subarray(0, 16).equals(attestationV3Message(ROUNDUP).subarray(0, 16)));
  });

  it("refuses a prices hash that is not 32 bytes rather than sign a shifted message", () => {
    assert.throws(() => attestationV3Message({ ...ROUNDUP, pricesHash: Buffer.alloc(31) }), /32 bytes/);
  });

  it("rides the Ed25519 instruction intact", () => {
    const attester = Keypair.generate();
    const { data } = attestationV3Instruction(attester.secretKey, ROUNDUP);
    assert.strictEqual(data[0], 1, "exactly one signature");
    assert.strictEqual(data.length, 112 + ATTESTATION_V3_MESSAGE_LEN);
    assert.isTrue(data.subarray(16, 48).equals(attester.publicKey.toBuffer()));
    assert.strictEqual(data.subarray(112).toString("hex"), GOLDEN_V3_ROUNDUP_HEX);
  });

  it("splits the prices hash into the four little-endian words settle_v3 takes", () => {
    const words = pricesHashWords(ROUNDUP.pricesHash);
    assert.strictEqual(words[0], 0x5aafea52c0520de9n);
    const back = Buffer.concat(
      words.map((word) => {
        const buffer = Buffer.alloc(8);
        buffer.writeBigUInt64LE(word);
        return buffer;
      }),
    );
    assert.isTrue(back.equals(Buffer.from(ROUNDUP.pricesHash)));
  });
});
