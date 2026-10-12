// The explicit-send cut's sender on its own (src/explicit-send.ts): the order
// of a send, the question asked between "signed" and "sent", the takeover quiet
// period, the SIGTERM drain, and how a landing is watched.
//
// THE CHAIN AND THE CLOCK ARE THE TEST'S. The connection below answers the five
// methods the sender uses and records each call; the clock moves only when the
// sender sleeps or the test says so. The byte-for-byte equality with Anchor's
// sends is test/invest-transaction.test.ts's; the whole-turn proofs (a claim
// lost after the wrap sends no convert or leg; no buy in the quiet period) are
// test/accounts.test.ts's, under "the explicit-send cut".

import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, TransactionMessage, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import {
  CrankSendRefused,
  CrankSender,
  QUIET_AFTER_TAKEOVER_MS,
  SEND_POLL_MS,
  SIGTERM_DRAIN_MS,
  type CrankSendEnd,
  type CrankSendGate,
  type SigningWallet,
} from "../src/explicit-send.js";

const BLOCKHASH = "3Nx5J6yqnGRrZ2mYqPSgDh1ZrmQnrgjSvJnBeCxMwGWk";
const crank = Keypair.fromSeed(new Uint8Array(32).fill(3));

/** A wallet that is the crank, as the keeper's is: it signs what it is handed, last. */
const wallet: SigningWallet & { signed: number } = {
  publicKey: crank.publicKey,
  signed: 0,
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    wallet.signed += 1;
    if (tx instanceof Transaction) tx.partialSign(crank);
    else (tx as VersionedTransaction).sign([crank]);
    return tx;
  },
};

interface ChainScript {
  /** Status answers per poll: null for "not seen yet". Past the end, the last one repeats. */
  readonly statuses?: readonly ({ readonly confirmationStatus: "processed" | "confirmed" | "finalized"; readonly err: unknown } | null)[];
  readonly finalizedHeight?: () => number;
  readonly onSend?: () => void;
  /** Overrides `statuses`: asked on every poll, so a test can confirm a send when IT chooses. */
  readonly status?: () => { readonly confirmationStatus: "confirmed"; readonly err: unknown } | null;
}

function scriptedChain(script: ChainScript = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const raw: Buffer[] = [];
  let polls = 0;
  const statuses = script.statuses ?? [{ confirmationStatus: "confirmed", err: null }];
  const connection = {
    getLatestBlockhash: async (...args: unknown[]) => {
      calls.push({ method: "getLatestBlockhash", args });
      return { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 };
    },
    sendRawTransaction: async (bytes: Buffer, ...args: unknown[]) => {
      calls.push({ method: "sendRawTransaction", args });
      raw.push(Buffer.from(bytes));
      script.onSend?.();
      return `sig-${raw.length}`;
    },
    getSignatureStatuses: async (...args: unknown[]) => {
      calls.push({ method: "getSignatureStatuses", args });
      const answer = script.status !== undefined ? script.status() : (statuses[Math.min(polls, statuses.length - 1)] ?? null);
      polls += 1;
      return { context: { slot: 1 }, value: [answer] };
    },
    getBlockHeight: async (...args: unknown[]) => {
      calls.push({ method: "getBlockHeight", args });
      return script.finalizedHeight?.() ?? 0;
    },
  } as unknown as Connection;
  return { connection, calls, raw };
}

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => (now += ms),
  };
}

/** A sender past its quiet period, live unless told otherwise. */
function ready(chain: ReturnType<typeof scriptedChain>, over: { isLive?: () => boolean; onConfirmed?: (ms: number) => void } = {}) {
  const time = clock();
  const sender = new CrankSender({
    connection: chain.connection,
    wallet,
    isLive: over.isLive ?? (() => true),
    now: time.now,
    sleep: time.sleep,
    ...(over.onConfirmed === undefined ? {} : { onConfirmed: over.onConfirmed }),
  });
  time.advance(QUIET_AFTER_TAKEOVER_MS);
  return { sender, time };
}

const transfer = () => new Transaction().add(SystemProgram.transfer({ fromPubkey: crank.publicKey, toPubkey: PublicKey.default, lamports: 1 }));

describe("one crank send", () => {
  it("reads the blockhash, signs as Anchor does — the crank, then the wallet — and only THEN sends, then polls until confirmed", async () => {
    const chain = scriptedChain({ statuses: [null, { confirmationStatus: "processed", err: null }, { confirmationStatus: "confirmed", err: null }] });
    const { sender } = ready(chain);
    wallet.signed = 0;
    const tx = transfer();
    const signature = await sender.sendLegacy(tx, [crank]);
    expect(signature).toBe("sig-1");
    expect(chain.calls.map((c) => c.method)).toEqual([
      "getLatestBlockhash",
      "sendRawTransaction",
      "getSignatureStatuses",
      "getSignatureStatuses",
      "getSignatureStatuses",
    ]);
    // ANCHOR'S OWN REQUESTS: the blockhash at the provider's commitment, the send with its preflight commitment.
    expect(chain.calls[0]!.args).toEqual(["confirmed"]);
    expect(chain.calls[1]!.args).toEqual([{ preflightCommitment: "confirmed" }]);
    // No history inside the window: the standard-credit status.
    expect(chain.calls[2]!.args).toEqual([["sig-1"], undefined]);
    // THE FEE PAYER DEFAULTS TO THE WALLET, as AnchorProvider.sendAndConfirm makes it; both signatures were made.
    expect(tx.feePayer?.equals(crank.publicKey)).toBe(true);
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    expect(wallet.signed).toBe(1);
    expect(Transaction.from(chain.raw[0]!).verifySignatures()).toBe(true);
    expect(sender.status()).toMatchObject({ sent: 1, landed: 1, reverted: 0, expired: 0, inFlight: 0 });
  });

  it("builds a versioned message around the blockhash it read, and signs it the same way", async () => {
    const chain = scriptedChain();
    const { sender } = ready(chain);
    let builtWith: string | null = null;
    await sender.sendVersioned((recentBlockhash) => {
      builtWith = recentBlockhash;
      const message = new TransactionMessage({ payerKey: crank.publicKey, recentBlockhash, instructions: transfer().instructions }).compileToV0Message();
      return new VersionedTransaction(message);
    }, [crank]);
    expect(builtWith).toBe(BLOCKHASH);
    expect(VersionedTransaction.deserialize(chain.raw[0]!).signatures[0]!.some((byte) => byte !== 0)).toBe(true);
  });

  it("reports a revert in Anchor's own words, and counts it", async () => {
    const chain = scriptedChain({ statuses: [{ confirmationStatus: "confirmed", err: { InstructionError: [0, { Custom: 6001 }] } }] });
    const { sender } = ready(chain);
    await expect(sender.sendLegacy(transfer(), [crank])).rejects.toThrow(/^Raw transaction sig-1 failed \(\{"err":\{"InstructionError":\[0,\{"Custom":6001\}\]\}\}\)$/);
    expect(sender.status()).toMatchObject({ sent: 1, reverted: 1, landed: 0, inFlight: 0 });
  });

  it("says a send never landed only once the FINALIZED height has passed its last valid block height, after one look with history", async () => {
    // Below the last valid height for the first two reads, past it on the third.
    let heightReads = 0;
    const chain = scriptedChain({ statuses: [null], finalizedHeight: () => (++heightReads <= 2 ? 900 : 1_001) });
    const { sender } = ready(chain);
    const error = (await sender.sendLegacy(transfer(), [crank]).catch((caught: unknown) => caught)) as Error;
    expect(error.message).toMatch(/did not land: the finalized block height 1001 has passed its last valid block height 1000/);
    const heights = chain.calls.filter((c) => c.method === "getBlockHeight");
    expect(heights).toHaveLength(3);
    expect(heights.every((c) => c.args[0] === "finalized")).toBe(true);
    // ONE look with history, the very last status call, and none before it.
    const statuses = chain.calls.filter((c) => c.method === "getSignatureStatuses");
    expect(statuses.at(-1)!.args).toEqual([["sig-1"], { searchTransactionHistory: true }]);
    expect(statuses.slice(0, -1).every((c) => c.args[1] === undefined)).toBe(true);
    // The height is read every fourth poll, not every poll: 12 polls, 3 heights.
    expect(statuses).toHaveLength(13);
    expect(sender.status()).toMatchObject({ expired: 1, landed: 0, inFlight: 0 });
    expect(SEND_POLL_MS).toBe(500);
  });

  it("tells /status the confirmation time, and a throw from that report changes nothing", async () => {
    const seen: number[] = [];
    const chain = scriptedChain({ statuses: [null, null, { confirmationStatus: "confirmed", err: null }] });
    const { sender } = ready(chain, { onConfirmed: (ms) => seen.push(ms) });
    await sender.sendLegacy(transfer(), [crank]);
    expect(seen).toEqual([2 * SEND_POLL_MS]);
    const throwing = ready(scriptedChain(), {
      onConfirmed: () => {
        throw new Error("status is broken");
      },
    });
    await expect(throwing.sender.sendLegacy(transfer(), [crank])).resolves.toBe("sig-1");
  });
});

describe("the question between signed and sent", () => {
  it("asks isLive() before EVERY send: a claim lost between two sends stops the second, which is signed and never sent", async () => {
    let live = true;
    const chain = scriptedChain({ onSend: () => (live = false) });
    const { sender } = ready(chain, { isLive: () => live });
    await sender.sendLegacy(transfer(), [crank]);
    const refused = await sender.sendLegacy(transfer(), [crank]).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CrankSendRefused);
    expect((refused as CrankSendRefused).reason).toBe("not-live");
    expect((refused as Error).message).toContain("signed and not sent");
    // THE SECOND WAS SIGNED (its blockhash was read) AND NEVER LEFT.
    expect(chain.calls.filter((c) => c.method === "getLatestBlockhash")).toHaveLength(2);
    expect(chain.raw).toHaveLength(1);
    expect(sender.status().refused).toEqual({ notLive: 1, quiet: 0, draining: 0 });
  });
});

describe("the takeover quiet period", () => {
  it("starts with the process and with every takeover, holds buys for 75 s, and then lets them go", async () => {
    const chain = scriptedChain();
    const time = clock();
    const sender = new CrankSender({ connection: chain.connection, wallet, isLive: () => true, now: time.now, sleep: time.sleep });
    // A NEW PROCESS IS A NEW HOLDER.
    expect(sender.buyingBlocked()).toMatch(/^the takeover quiet period: .* \(75 s\)/);
    expect(sender.status().quietUntil).not.toBeNull();
    const refused = await sender.sendLegacy(transfer(), [crank]).catch((error: unknown) => error);
    expect((refused as CrankSendRefused).reason).toBe("quiet");
    expect(chain.raw).toHaveLength(0);
    time.advance(QUIET_AFTER_TAKEOVER_MS - 1);
    expect(sender.buyingBlocked()).not.toBeNull();
    time.advance(1);
    expect(sender.buyingBlocked()).toBeNull();
    await sender.sendLegacy(transfer(), [crank]);
    // A LATER TAKEOVER — a claim lost and taken again — starts it over.
    sender.noteTakeover();
    expect(sender.buyingBlocked()).toContain("(75 s)");
    expect(QUIET_AFTER_TAKEOVER_MS).toBe(75_000);
  });
});

describe("the SIGTERM drain", () => {
  /** Real time, one millisecond a poll: the drain's interleavings are the event loop's, not a fake clock's. */
  const quick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms === SIGTERM_DRAIN_MS ? ms : 1));

  it("lets a send already on the wire confirm, starts no new one, and is idle once it lands", async () => {
    let landed = false;
    const chain = scriptedChain({ status: () => (landed ? { confirmationStatus: "confirmed", err: null } : null) });
    const sender = new CrankSender({ connection: chain.connection, wallet, isLive: () => true, quietMs: 0, sleep: quick });
    const inFlight = sender.sendLegacy(transfer(), [crank]);
    while (chain.raw.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    sender.beginDrain();
    expect(sender.draining).toBe(true);
    expect(sender.buyingBlocked()).toMatch(/^the keeper is draining after SIGTERM/);
    const refused = await sender.sendLegacy(transfer(), [crank]).catch((error: unknown) => error);
    expect((refused as CrankSendRefused).reason).toBe("draining");
    expect(chain.raw).toHaveLength(1);
    const idle = sender.idle();
    expect(sender.status().inFlight).toBe(1);
    landed = true;
    await expect(inFlight).resolves.toBe("sig-1");
    await expect(idle).resolves.toBe(true);
    expect(sender.status().drain).toMatchObject({ inFlightAtStart: 1, completed: true });
  });

  it("gives up after 20 s on a send that never confirms, so the claim is still released", async () => {
    const chain = scriptedChain({ status: () => null, finalizedHeight: () => 0 });
    const asked: number[] = [];
    const sender = new CrankSender({
      connection: chain.connection,
      wallet,
      isLive: () => true,
      quietMs: 0,
      // THE SEND HANGS ON THE WIRE (its polls never return); the drain's own twenty seconds do.
      sleep: (ms) => {
        asked.push(ms);
        return ms === SIGTERM_DRAIN_MS ? Promise.resolve() : new Promise(() => undefined);
      },
    });
    void sender.sendLegacy(transfer(), [crank]).catch(() => undefined);
    while (chain.raw.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    sender.beginDrain();
    await expect(sender.idle()).resolves.toBe(false);
    expect(asked).toContain(SIGTERM_DRAIN_MS);
    expect(SIGTERM_DRAIN_MS).toBe(20_000);
    expect(sender.status()).toMatchObject({ inFlight: 1, drain: { inFlightAtStart: 1, completed: false } });
  });

  it("is idle at once when nothing is on the wire", async () => {
    const { sender } = ready(scriptedChain());
    sender.beginDrain();
    await expect(sender.idle()).resolves.toBe(true);
    expect(sender.status().drain).toMatchObject({ inFlightAtStart: 0, completed: true });
  });
});

// ── the dispatcher's fence (CrankSenderOptions.gate) ───────────────────────────
//
// A worker's CrankSender carries a gate (src/fenced-sender.ts): asked after the
// three questions and after signing, before the bytes leave. These pin the seam
// itself, with a gate the test writes; the fence's own rules are
// test/fenced-sender.test.ts's.
describe("the dispatcher's gate", () => {
  /** A gate that records what it was shown, in order with the chain's calls, and answers as told. */
  function gate(chain: ReturnType<typeof scriptedChain>, answer: "admit" | "refuse" = "admit") {
    const seen: { readonly blockhash: string; readonly lastValidBlockHeight: number; readonly signed: boolean; readonly sentBefore: number }[] = [];
    const ends: CrankSendEnd[] = [];
    const hook: CrankSendGate = {
      admit: async (send) => {
        const first = send.transaction instanceof Transaction ? send.transaction.signatures[0]?.signature : send.transaction.signatures[0];
        seen.push({
          blockhash: send.blockhash,
          lastValidBlockHeight: send.lastValidBlockHeight,
          signed: first !== null && first !== undefined && first.some((byte) => byte !== 0),
          sentBefore: chain.raw.length,
        });
        if (answer === "refuse") throw new CrankSendRefused("fenced", "the fence refused this send");
        return { ended: (end) => void ends.push(end) };
      },
    };
    return { hook, seen, ends };
  }

  it("is shown the SIGNED transaction, its blockhash and last valid height, before the bytes leave — and told how it ended", async () => {
    const chain = scriptedChain();
    const fence = gate(chain);
    const sender = new CrankSender({ connection: chain.connection, wallet, isLive: () => true, quietMs: 0, gate: fence.hook });
    await sender.sendLegacy(transfer(), [crank]);
    expect(fence.seen).toEqual([{ blockhash: BLOCKHASH, lastValidBlockHeight: 1_000, signed: true, sentBefore: 0 }]);
    expect(chain.raw).toHaveLength(1);
    expect(fence.ends).toEqual(["landed"]);
    // THE ORDER IS P2's, THE GATE INSIDE IT: blockhash, then (gate), then the send and its polls.
    expect(chain.calls.map((call) => call.method)).toEqual(["getLatestBlockhash", "sendRawTransaction", "getSignatureStatuses"]);
  });

  it("sends NOTHING when the gate refuses, and the refusal is the fence's, not one of the sender's three", async () => {
    const chain = scriptedChain();
    const fence = gate(chain, "refuse");
    const sender = new CrankSender({ connection: chain.connection, wallet, isLive: () => true, quietMs: 0, gate: fence.hook });
    const refused = await sender.sendLegacy(transfer(), [crank]).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CrankSendRefused);
    expect((refused as CrankSendRefused).reason).toBe("fenced");
    expect(chain.raw).toHaveLength(0);
    expect(chain.calls.map((call) => call.method)).toEqual(["getLatestBlockhash"]);
    expect(sender.status()).toMatchObject({ sent: 0, inFlight: 0, refused: { notLive: 0, quiet: 0, draining: 0 } });
  });

  it("is never asked when one of the three questions already refused: a lost claim is not a gate", async () => {
    const chain = scriptedChain();
    const fence = gate(chain);
    const sender = new CrankSender({ connection: chain.connection, wallet, isLive: () => false, quietMs: 0, gate: fence.hook });
    await expect(sender.sendLegacy(transfer(), [crank])).rejects.toBeInstanceOf(CrankSendRefused);
    expect(fence.seen).toHaveLength(0);
    expect(chain.raw).toHaveLength(0);
  });

  it("tells the ticket `reverted`, `expired` and `unknown` as the watch saw them", async () => {
    const reverted = scriptedChain({ statuses: [{ confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } }] });
    const r = gate(reverted);
    await new CrankSender({ connection: reverted.connection, wallet, isLive: () => true, quietMs: 0, gate: r.hook }).sendLegacy(transfer(), [crank]).catch(() => undefined);
    expect(r.ends).toEqual(["reverted"]);

    const expired = scriptedChain({ statuses: [null], finalizedHeight: () => 1_001 });
    const e = gate(expired);
    const time = clock();
    await new CrankSender({ connection: expired.connection, wallet, isLive: () => true, quietMs: 0, gate: e.hook, now: time.now, sleep: time.sleep })
      .sendLegacy(transfer(), [crank])
      .catch(() => undefined);
    expect(e.ends).toEqual(["expired"]);

    // A NODE THAT REFUSED THE BYTES: whether they reached a leader is unknown, so the fence must wait it out.
    const threw = scriptedChain({
      onSend: () => {
        throw new Error("node refused the bytes");
      },
    });
    const t = gate(threw);
    await new CrankSender({ connection: threw.connection, wallet, isLive: () => true, quietMs: 0, gate: t.hook }).sendLegacy(transfer(), [crank]).catch(() => undefined);
    expect(t.ends).toEqual(["unknown"]);
  });

  it("keeps a drain waiting for a gate already asked: the in-flight count covers it", async () => {
    const chain = scriptedChain();
    let open!: () => void;
    const held = new Promise<void>((resolve) => {
      open = resolve;
    });
    const hook: CrankSendGate = {
      admit: async () => {
        await held;
        return { ended: () => undefined };
      },
    };
    const sender = new CrankSender({ connection: chain.connection, wallet, isLive: () => true, quietMs: 0, gate: hook });
    const sending = sender.sendLegacy(transfer(), [crank]);
    while (sender.status().inFlight === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    sender.beginDrain();
    const idle = sender.idle(60_000);
    expect(sender.status().inFlight).toBe(1);
    open();
    await expect(sending).resolves.toBe("sig-1");
    await expect(idle).resolves.toBe(true);
  });
});
