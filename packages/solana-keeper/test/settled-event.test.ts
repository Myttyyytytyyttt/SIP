// Reading a settlement back out of a transaction's logs — the half of
// "derived and rebuildable" that makes the other half executable.
//
// The case that matters most is the one nobody would think to write: a
// STRANGER'S program emitting a log with our discriminator inside a transaction
// that also touches sip-vault. A reader that scanned for `Program data:` lines
// would accept it, and a stranger would be writing rows into the history the
// website shows and the leaderboard ranks.

import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { SETTLED_DISCRIMINATOR, decodeSettled, settledEventsFrom, type SettledEvent } from "../src/settled-event.js";

const VAULT = "5Y1bpPuG8hatmmUKC86WLJqbMuNfXAQUQAQMwKM3YNMe";
const WALLET = "8qsJxi8FyxqwVLvotowNRRUKQDW5Em8M7bTcPDwKGCQK";
const OTHER_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** The bytes settle.rs's `emit!` puts on the wire, built from the same IDL layout. */
function encode(over: Partial<SettledEvent> = {}): Buffer {
  const event: SettledEvent = {
    vault: VAULT,
    wallet: WALLET,
    mode: 0,
    baseLamports: 183_000_000n,
    bps: 2_000,
    owed: 36_600_000n,
    paid: 36_600_000n,
    settlementNonce: 7n,
    sessionEndSlot: 300_000_500n,
    linkEpoch: 300_000_000n,
    sessionStartSlot: 299_999_000n,
    policyNonce: 3n,
    ...over,
  };
  const body = Buffer.alloc(32 + 32 + 1 + 8 + 2 + 8 * 7);
  let offset = 0;
  const key = (value: string) => {
    new PublicKey(value).toBuffer().copy(body, offset);
    offset += 32;
  };
  const u64 = (value: bigint) => {
    body.writeBigUInt64LE(value, offset);
    offset += 8;
  };
  key(event.vault);
  key(event.wallet);
  body.writeUInt8(event.mode, offset);
  offset += 1;
  u64(event.baseLamports);
  body.writeUInt16LE(event.bps, offset);
  offset += 2;
  u64(event.owed);
  u64(event.paid);
  u64(event.settlementNonce);
  u64(event.sessionEndSlot);
  u64(event.linkEpoch);
  u64(event.sessionStartSlot);
  u64(event.policyNonce);
  return Buffer.concat([SETTLED_DISCRIMINATOR, body]);
}

const dataLine = (bytes: Buffer): string => `Program data: ${bytes.toString("base64")}`;

describe("decoding one event", () => {
  it("takes its discriminator from the IDL, not from a constant typed here", () => {
    expect(SETTLED_DISCRIMINATOR).toHaveLength(8);
    expect([...SETTLED_DISCRIMINATOR]).toEqual([232, 210, 40, 17, 142, 124, 145, 238]);
  });

  it("reads every field back", () => {
    const decoded = decodeSettled(encode());
    expect(decoded).toEqual({
      vault: VAULT,
      wallet: WALLET,
      mode: 0,
      baseLamports: 183_000_000n,
      bps: 2_000,
      owed: 36_600_000n,
      paid: 36_600_000n,
      settlementNonce: 7n,
      sessionEndSlot: 300_000_500n,
      linkEpoch: 300_000_000n,
      sessionStartSlot: 299_999_000n,
      policyNonce: 3n,
    });
  });

  it("keeps lamports exact past what a double can hold", () => {
    const huge = 9_007_199_254_740_993n;
    expect(decodeSettled(encode({ paid: huge }))!.paid).toBe(huge);
  });

  it("answers null rather than throwing on anything that is not this event", () => {
    expect(decodeSettled(Buffer.alloc(0))).toBeNull();
    expect(decodeSettled(encode().subarray(0, 40))).toBeNull();
    const wrongDiscriminator = encode();
    wrongDiscriminator.writeUInt8(0, 0);
    expect(decodeSettled(wrongDiscriminator)).toBeNull();
  });
});

describe("reading a transaction's logs", () => {
  const ours = (bytes: Buffer): string[] => [
    `Program ${SIP_PROGRAM_ID} invoke [1]`,
    "Program log: Instruction: SettleV2",
    dataLine(bytes),
    `Program ${SIP_PROGRAM_ID} consumed 41234 of 200000 compute units`,
    `Program ${SIP_PROGRAM_ID} success`,
  ];

  it("returns the settlements the program performed, in order", () => {
    const logs = [...ours(encode({ settlementNonce: 7n })), ...ours(encode({ settlementNonce: 8n }))];
    expect(settledEventsFrom(logs, SIP_PROGRAM_ID).map((event) => event.settlementNonce)).toEqual([7n, 8n]);
  });

  it("REFUSES an identical event logged by another program in the same transaction", () => {
    // The poisoning case: same bytes, same discriminator, different program.
    const logs = [
      `Program ${OTHER_PROGRAM} invoke [1]`,
      dataLine(encode({ paid: 999_999_999n })),
      `Program ${OTHER_PROGRAM} success`,
      ...ours(encode({ paid: 36_600_000n })),
    ];
    const events = settledEventsFrom(logs, SIP_PROGRAM_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.paid).toBe(36_600_000n);
  });

  it("accepts our event when our program is CPI'd by another, and not the other way round", () => {
    const logs = [
      `Program ${OTHER_PROGRAM} invoke [1]`,
      `Program ${SIP_PROGRAM_ID} invoke [2]`,
      dataLine(encode({ settlementNonce: 11n })),
      `Program ${SIP_PROGRAM_ID} success`,
      // Back inside the outer program: this one is not ours, whatever it says.
      dataLine(encode({ settlementNonce: 12n })),
      `Program ${OTHER_PROGRAM} success`,
    ];
    expect(settledEventsFrom(logs, SIP_PROGRAM_ID).map((event) => event.settlementNonce)).toEqual([11n]);
  });

  it("ignores logs that are not events, and data that is not one", () => {
    const logs = [
      `Program ${SIP_PROGRAM_ID} invoke [1]`,
      "Program log: Instruction: Settle",
      "Program data: not+valid+base64+for+an+event",
      dataLine(Buffer.alloc(200)),
      `Program ${SIP_PROGRAM_ID} success`,
    ];
    expect(settledEventsFrom(logs, SIP_PROGRAM_ID)).toEqual([]);
  });

  it("survives a failed invocation without losing the stack", () => {
    const logs = [
      `Program ${OTHER_PROGRAM} invoke [1]`,
      `Program ${OTHER_PROGRAM} failed: custom program error: 0x1`,
      ...ours(encode({ settlementNonce: 4n })),
    ];
    expect(settledEventsFrom(logs, SIP_PROGRAM_ID).map((event) => event.settlementNonce)).toEqual([4n]);
  });
});
