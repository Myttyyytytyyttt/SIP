/**
 * The `Settled` event, read back out of a transaction's logs.
 *
 * WHY THIS EXISTS. The mirror is derived and rebuildable — that is the promise
 * at the top of sql/sip_solana.sql — and a promise nobody can execute is not
 * one. This is the reader that makes it executable: given the logs of a
 * transaction, it returns the settlements that transaction actually performed,
 * which bin/backfill-settlements.mts turns back into rows.
 *
 * ONLY OUR PROGRAM'S EVENTS COUNT, and that is the whole reason this file does
 * its own log walk instead of scanning for `Program data:` lines. Anyone can
 * deploy a program that emits a log carrying our discriminator and put it in a
 * transaction that also touches sip-vault; a reader that took every matching
 * line would let a stranger write rows into the history — rows the website
 * shows and the leaderboard now ranks. So the walk tracks the invocation stack
 * and accepts an event only while sip-vault is the program currently running.
 *
 * BORSH BY HAND, deliberately. The layout is twelve fixed-width fields that the
 * IDL pins, and decoding them here costs nothing; going through Anchor's coder
 * would drag anchor.BN into a script that runs under plain Node ESM, which is
 * exactly where that import has failed before.
 */

import { PublicKey } from "@solana/web3.js";
import { idl } from "./idl.js";

/** What settle.rs emits (`emit!(Settled { … })`), in the IDL's field order. */
export interface SettledEvent {
  readonly vault: string;
  readonly wallet: string;
  /** 0 PROFIT, 1 VOLUME: what `baseLamports` measures. */
  readonly mode: number;
  readonly baseLamports: bigint;
  readonly bps: number;
  readonly owed: bigint;
  /** What the vault was actually paid — the contribution the mirror records. */
  readonly paid: bigint;
  readonly settlementNonce: bigint;
  readonly sessionEndSlot: bigint;
  readonly linkEpoch: bigint;
  readonly sessionStartSlot: bigint;
  readonly policyNonce: bigint;
}

/** Eight bytes, from the IDL, so this file cannot disagree with the program. */
export const SETTLED_DISCRIMINATOR: Buffer = Buffer.from(
  (idl as unknown as { events?: readonly { name: string; discriminator: number[] }[] }).events?.find((event) => event.name === "Settled")
    ?.discriminator ?? [],
);

/** 8 discriminator + 32 + 32 + 1 + 8 + 2 + 8 × 7. A shorter buffer is not this event. */
const SETTLED_BYTES = 8 + 32 + 32 + 1 + 8 + 2 + 8 * 7;

/**
 * One event from its raw bytes, discriminator included. NULL, never a throw and
 * never a partial event: this reads attacker-reachable input — a log line in a
 * transaction anyone could have built — and the only safe answer to anything
 * unexpected is "that was not a Settled".
 */
export function decodeSettled(data: Buffer): SettledEvent | null {
  if (SETTLED_DISCRIMINATOR.length !== 8) return null;
  if (data.length < SETTLED_BYTES || !data.subarray(0, 8).equals(SETTLED_DISCRIMINATOR)) return null;
  let offset = 8;
  const pubkey = (): string => {
    const key = new PublicKey(data.subarray(offset, offset + 32)).toBase58();
    offset += 32;
    return key;
  };
  const u64 = (): bigint => {
    const value = data.readBigUInt64LE(offset);
    offset += 8;
    return value;
  };
  try {
    const vault = pubkey();
    const wallet = pubkey();
    const mode = data.readUInt8(offset);
    offset += 1;
    const baseLamports = u64();
    const bps = data.readUInt16LE(offset);
    offset += 2;
    return {
      vault,
      wallet,
      mode,
      baseLamports,
      bps,
      owed: u64(),
      paid: u64(),
      settlementNonce: u64(),
      sessionEndSlot: u64(),
      linkEpoch: u64(),
      sessionStartSlot: u64(),
      policyNonce: u64(),
    };
  } catch {
    return null;
  }
}

const INVOKE = /^Program (\S+) invoke \[\d+\]$/;
const ENDED = /^Program (\S+) (?:success|failed.*|consumed .*)$/;
const DATA = /^Program data: (\S+)$/;

/**
 * Every settlement a transaction's logs prove, in order.
 *
 * `programId` is the program whose events are trusted; a `Program data:` line
 * logged while anything else is on top of the invocation stack is another
 * program's business and is skipped, whatever it decodes to.
 */
export function settledEventsFrom(logs: readonly string[], programId: string): SettledEvent[] {
  const events: SettledEvent[] = [];
  const stack: string[] = [];
  for (const line of logs) {
    const invoke = INVOKE.exec(line);
    if (invoke !== null) {
      stack.push(invoke[1]!);
      continue;
    }
    // "consumed … units" ends the invocation too; it is the line that precedes
    // "success" for the outermost program on some nodes and replaces it on others.
    const ended = ENDED.exec(line);
    if (ended !== null) {
      if (stack[stack.length - 1] === ended[1]) stack.pop();
      continue;
    }
    const data = DATA.exec(line);
    if (data === null) continue;
    if (stack[stack.length - 1] !== programId) continue;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(data[1]!, "base64");
    } catch {
      continue;
    }
    const event = decodeSettled(bytes);
    if (event !== null) events.push(event);
  }
  return events;
}
