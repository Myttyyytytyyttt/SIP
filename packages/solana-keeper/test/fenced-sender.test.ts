// The fenced sender (src/fenced-sender.ts): one job's fence around every send it
// makes — the store's gate before the bytes leave, and what each intent becomes
// after. The store is the in-memory model of the real one
// (test/memory-dispatch-store.ts); the chain answers the four methods the sender
// uses. The same rules against the real store on Postgres are
// test/worker-pg.test.ts's.

import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { CrankSendRefused, CrankSender, type SigningWallet } from "../src/explicit-send.js";
import { JobFence, crankIntentOf, signatureOf } from "../src/fenced-sender.js";
import type { ManagedLink } from "../src/discovery.js";
import { idl } from "../src/idl.js";
import { CRANK, convertTransaction, investTransaction, offlineProgram, wrapTransaction } from "./crank-txs.js";
import { MemoryDb, MemoryDispatchStore } from "./memory-dispatch-store.js";

const programId = new PublicKey(idl.address);
const BLOCKHASH = "3Nx5J6yqnGRrZ2mYqPSgDh1ZrmQnrgjSvJnBeCxMwGWk";
const LVBH = 1_000;
const VAULT = Keypair.generate().publicKey.toBase58();

const wallet: SigningWallet = {
  publicKey: CRANK.publicKey,
  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (tx instanceof Transaction) tx.partialSign(CRANK);
    else (tx as VersionedTransaction).sign([CRANK]);
    return tx;
  },
};

/** A chain that confirms what it is sent (or reverts, or never answers), and records every raw send. */
function chain(script: { readonly status?: () => { confirmationStatus: string; err: unknown } | null; readonly throwOnSend?: boolean; readonly finalized?: () => number } = {}) {
  const raw: Buffer[] = [];
  const connection = {
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: LVBH }),
    sendRawTransaction: async (bytes: Buffer) => {
      if (script.throwOnSend === true) throw new Error("the node refused the bytes");
      raw.push(Buffer.from(bytes));
      return `sig-${raw.length}`;
    },
    getSignatureStatuses: async () => ({ context: { slot: 1 }, value: [script.status === undefined ? { confirmationStatus: "confirmed", err: null } : script.status()] }),
    getBlockHeight: async () => script.finalized?.() ?? 0,
  } as unknown as Connection;
  return { connection, raw };
}

/** A store holding VAULT at fence 1 with a fresh lease, and a fence for that job. */
function held(options: { readonly world?: "live" | "shadow"; readonly confirmed?: bigint; readonly mayAct?: () => string | null } = {}) {
  const db = new MemoryDb();
  db.addVault(VAULT);
  const store = new MemoryDispatchStore(db, "worker-a", options.world ?? "live");
  return {
    db,
    store,
    claim: async () => {
      const [claimed] = await store.claim(1);
      return claimed!;
    },
    fence: (fence: bigint, planClearedHeight: bigint | null = null) =>
      new JobFence({
        store,
        vault: VAULT,
        fence,
        planClearedHeight,
        programId,
        confirmedHeight: async () => options.confirmed ?? 950n,
        mayAct: options.mayAct ?? (() => null),
      }),
  };
}

const sender = (connection: Connection, fence: JobFence, isLive: () => boolean = () => true) =>
  new CrankSender({ connection, wallet, isLive, quietMs: 0, gate: fence.crankGate(), sleep: async () => undefined });

const link = (): ManagedLink => ({
  linkAddress: Keypair.generate().publicKey,
  wallet: Keypair.generate().publicKey,
  vault: new PublicKey(VAULT),
  epoch: 10n,
  settlementNonce: 3n,
  frontierSlot: 500n,
});

describe("crankIntentOf: the fence names what it lets through", () => {
  const program = offlineProgram();

  it("names wrap_sol, convert and invest by the IDL's discriminators, with each one's amount — legacy and v0 alike", async () => {
    expect(crankIntentOf(await wrapTransaction(program, 123_456_789n), programId)).toEqual({ kind: "wrap", amountRaw: 123_456_789n });
    expect(crankIntentOf(await convertTransaction(program, 9_007_199_254_740_993n), programId)).toEqual({ kind: "convert", amountRaw: 9_007_199_254_740_993n });
    expect(crankIntentOf(await investTransaction(program, 5_000_000n, BLOCKHASH), programId)).toEqual({ kind: "invest", amountRaw: 5_000_000n });
  });

  it("refuses a transaction with no crank instruction, or two: a fence that cannot name a send does not let it through", async () => {
    const transfer = new Transaction().add(SystemProgram.transfer({ fromPubkey: CRANK.publicKey, toPubkey: PublicKey.default, lamports: 1 }));
    expect(() => crankIntentOf(transfer, programId)).toThrow(CrankSendRefused);
    const wrap = await wrapTransaction(program, 1n);
    const two = new Transaction().add(...wrap.instructions, ...(await convertTransaction(program, 2n)).instructions);
    expect(() => crankIntentOf(two, programId)).toThrow(/2 wrap_sol, convert or invest/);
  });

  it("refuses a durable-nonce transaction outright (A4): it never expires, so no successor could wait it out", async () => {
    const wrap = await wrapTransaction(program, 1n);
    const nonced = new Transaction().add(
      SystemProgram.nonceAdvance({ noncePubkey: Keypair.generate().publicKey, authorizedPubkey: CRANK.publicKey }),
      ...wrap.instructions,
    );
    expect(() => crankIntentOf(nonced, programId)).toThrow(/durable nonce never expires/);
  });

  it("reads a transaction's id as its first signature, and none before it is signed", async () => {
    const wrap = await wrapTransaction(program, 1n);
    wrap.feePayer = CRANK.publicKey;
    wrap.recentBlockhash = BLOCKHASH;
    expect(signatureOf(wrap)).toBeNull();
    wrap.partialSign(CRANK);
    expect(signatureOf(wrap)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  });
});

describe("the fence around a crank send", () => {
  const program = offlineProgram();

  it("gates BEFORE the bytes leave: an intent row with the kind, the amount, the blockhash, its last valid height, the signature and the plan height", async () => {
    const h = held();
    const claimed = await h.claim();
    const fence = h.fence(claimed.fence, 777n);
    const c = chain();
    let rowsWhenSent = -1;
    const watched = { ...c.connection, sendRawTransaction: async (bytes: Buffer) => ((rowsWhenSent = h.db.intents.length), c.connection.sendRawTransaction(bytes)) } as unknown as Connection;
    await sender(watched, fence).sendLegacy(await wrapTransaction(program, 42n), [CRANK]);
    expect(rowsWhenSent).toBe(1);
    const [row] = h.db.intents;
    expect(row).toMatchObject({ kind: "wrap", amountRaw: 42n, blockhash: BLOCKHASH, lastValidBlockHeight: BigInt(LVBH), planClearedHeight: 777n, fence: 1n, state: "landed" });
    expect(row!.signature).toBe(signatureOf(Transaction.from(c.raw[0]!)));
    // ONE STATEMENT, NO CARRY: a crank send never writes one.
    expect(h.db.gateCalls.map((call) => call.form)).toEqual(["one-statement"]);
  });

  it("resolves a landed wrap at the confirmed height, capped at its last valid height", async () => {
    for (const [confirmed, expected] of [[950n, 950n], [5_000n, BigInt(LVBH)]] as const) {
      const h = held({ confirmed });
      const fence = h.fence((await h.claim()).fence);
      await sender(chain().connection, fence).sendLegacy(await wrapTransaction(program, 1n), [CRANK]);
      await fence.settled();
      expect(h.db.intents[0]).toMatchObject({ state: "landed", resolvedHeight: expected });
    }
  });

  it("sends NOTHING when the store refuses the lease, and stops the job: the next send is not even asked of the store", async () => {
    const h = held();
    const claimed = await h.claim();
    h.db.advance(40_000); // 5 s of lease left: under the 10 s margin
    const fence = h.fence(claimed.fence);
    const c = chain();
    const refused = await sender(c.connection, fence).sendLegacy(await wrapTransaction(program, 1n), [CRANK]).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CrankSendRefused);
    expect((refused as CrankSendRefused).reason).toBe("fenced");
    expect(c.raw).toHaveLength(0);
    expect(fence.lostReason).toContain("no longer held");
    const calls = h.db.gateCalls.length;
    await sender(c.connection, fence).sendLegacy(await wrapTransaction(program, 1n), [CRANK]).catch(() => undefined);
    expect(h.db.gateCalls).toHaveLength(calls);
    expect(c.raw).toHaveLength(0);
  });

  it("asks mayAct first: a job past its ceiling or draining is refused here, never by the store, and nothing leaves", async () => {
    let blocked: string | null = null;
    const h = held({ mayAct: () => blocked });
    const fence = h.fence((await h.claim()).fence);
    blocked = "the job passed its 6-minute ceiling";
    const c = chain();
    await expect(sender(c.connection, fence).sendLegacy(await wrapTransaction(program, 1n), [CRANK])).rejects.toBeInstanceOf(CrankSendRefused);
    expect(h.db.gateCalls).toHaveLength(0);
    expect(c.raw).toHaveLength(0);
    expect(fence.lostReason).toBe("the job passed its 6-minute ceiling");
  });

  it("reports a store refusal to onGate, and never a refusal it made itself", async () => {
    const answers: string[] = [];
    let blocked: string | null = null;
    const db = new MemoryDb();
    db.addVault(VAULT);
    const store = new MemoryDispatchStore(db, "worker-a");
    const [claimed] = await store.claim(1);
    const make = () =>
      new JobFence({ store, vault: VAULT, fence: claimed!.fence, planClearedHeight: null, programId, confirmedHeight: async () => 1n, mayAct: () => blocked, onGate: (_kind, answer) => answers.push(answer.kind) });
    blocked = "draining";
    await sender(chain().connection, make()).sendLegacy(await wrapTransaction(program, 1n), [CRANK]).catch(() => undefined);
    expect(answers).toEqual([]);
    blocked = null;
    db.advance(60_000);
    await sender(chain().connection, make()).sendLegacy(await wrapTransaction(program, 1n), [CRANK]).catch(() => undefined);
    expect(answers).toEqual(["refused"]);
  });

  it("marks a reverted send failed and an expired one expired at its last valid height; a send whose fate is unknown stays OPEN", async () => {
    const reverted = held();
    const f1 = reverted.fence((await reverted.claim()).fence);
    await sender(chain({ status: () => ({ confirmationStatus: "confirmed", err: { InstructionError: [1, { Custom: 6000 }] } }) }).connection, f1)
      .sendLegacy(await wrapTransaction(program, 1n), [CRANK])
      .catch(() => undefined);
    await f1.settled();
    expect(reverted.db.intents[0]).toMatchObject({ state: "failed", resolvedHeight: 950n });

    const expired = held();
    const f2 = expired.fence((await expired.claim()).fence);
    await sender(chain({ status: () => null, finalized: () => LVBH + 1 }).connection, f2).sendLegacy(await wrapTransaction(program, 1n), [CRANK]).catch(() => undefined);
    await f2.settled();
    expect(expired.db.intents[0]).toMatchObject({ state: "expired", resolvedHeight: BigInt(LVBH) });

    const unknown = held();
    const f3 = unknown.fence((await unknown.claim()).fence);
    await sender(chain({ throwOnSend: true }).connection, f3).sendLegacy(await wrapTransaction(program, 1n), [CRANK]).catch(() => undefined);
    await f3.settled();
    expect(unknown.db.intents[0]).toMatchObject({ state: "intent", resolvedAt: null });
  });

  it("holds a landed LEG for its history row: resolved only once the job says the row is written (the outbox, S-9)", async () => {
    const h = held();
    const fence = h.fence((await h.claim()).fence);
    const c = chain();
    const leg = await investTransaction(program, 5_000_000n, BLOCKHASH);
    await sender(c.connection, fence).sendVersioned(() => leg, [CRANK]);
    await fence.settled();
    expect(h.db.intents.at(-1)).toMatchObject({ kind: "invest", state: "intent", resolvedAt: null });
    expect(fence.landedAwaitingHistory()).toHaveLength(1);
    await fence.historyWritten(fence.landedAwaitingHistory()[0]!);
    expect(h.db.intents.at(-1)).toMatchObject({ kind: "invest", state: "landed", resolvedHeight: 950n });
    expect(fence.landedAwaitingHistory()).toHaveLength(0);
  });
});

describe("the fence around a settle (settle-tick.ts's SettleDeps.fence)", () => {
  const request = (over: Partial<Parameters<ReturnType<JobFence["settleFence"]>["gate"]>[0]> = {}) => ({
    link: link(),
    mode: 0,
    blockhash: BLOCKHASH,
    lastValidBlockHeight: LVBH,
    idempotencyKey: "a".repeat(64),
    amountLamports: 12_345n,
    endSlot: 600n,
    carry: { lossLamports: 500n, walletSignedTxCount: 1 },
    validUntilSlot: 750n,
    live: true,
    ...over,
  });

  it("writes a PROFIT settle's carry INSIDE its gate (the transaction form, S-4) — a VOLUME settle carries none and takes one statement", async () => {
    const h = held();
    const fence = h.fence((await h.claim()).fence);
    const profit = request();
    expect((await fence.settleFence().gate(profit)).kind).toBe("gated");
    expect(h.db.gateCalls.at(-1)).toMatchObject({ form: "transaction" });
    expect(h.db.carries).toEqual([{ link: profit.link.linkAddress.toBase58(), fence: 1n, intentId: 1n, endSlot: 600n, lossLamports: 500n }]);
    expect(h.db.intents[0]).toMatchObject({ kind: "settle", link: profit.link.linkAddress.toBase58(), amountRaw: 12_345n, idempotencyKey: "a".repeat(64), signature: null });

    // A NULL CARRY IS WRITTEN TOO, as recordCarry records one: it clears the link's other states.
    expect((await fence.settleFence().gate(request({ carry: null }))).kind).toBe("gated");
    expect(h.db.carries.at(-1)).toMatchObject({ lossLamports: null });

    await fence.settleFence().gate(request({ mode: 1, carry: null }));
    expect(h.db.gateCalls.at(-1)).toMatchObject({ form: "one-statement", carry: null });
    expect(h.db.carries).toHaveLength(2);
  });

  it("records the settle's id once Privy answers, and resolves it by the turn's outcome — a send that may still land stays open", async () => {
    const h = held();
    const fence = h.fence((await h.claim()).fence);
    const gate = fence.settleFence();
    const landed = await gate.gate(request());
    const reverted = await gate.gate(request({ link: link() }));
    const unknown = await gate.gate(request({ link: link() }));
    const nonceMoved = await gate.gate(request({ link: link() }));
    if (landed.kind !== "gated" || reverted.kind !== "gated" || unknown.kind !== "gated" || nonceMoved.kind !== "gated") throw new Error("not gated");
    landed.ticket.signed("sig-landed");
    landed.ticket.ended("landed", "SETTLED");
    reverted.ticket.signed("sig-reverted");
    reverted.ticket.ended("reverted", "RETRY");
    unknown.ticket.ended("threw", "RETRY");
    // A SEND THAT THREW, WHOSE NONCE MOVED, IS SETTLED (settle-tick.ts reads it back): landed.
    nonceMoved.ticket.ended("threw", "SETTLED");
    await fence.settled();
    expect(h.db.intents.map((row) => [row.signature, row.state])).toEqual([
      ["sig-landed", "landed"],
      ["sig-reverted", "failed"],
      [null, "intent"],
      [null, "landed"],
    ]);
  });

  it("refuses with the store's words and stops the job when the lease is gone; nothing is gated", async () => {
    const h = held();
    const claimed = await h.claim();
    const fence = h.fence(claimed.fence);
    h.db.vaults.get(VAULT)!.fence = 2n; // someone else claimed it since
    const answer = await fence.settleFence().gate(request());
    expect(answer).toMatchObject({ kind: "refused" });
    expect(answer.kind === "refused" && answer.detail).toContain("the dispatcher's fence refused this settle");
    expect(h.db.intents).toHaveLength(0);
    expect(h.db.carries).toHaveLength(0);
    expect(fence.lostReason).not.toBeNull();
  });

  it("in the live world a DRY turn's would-be settle writes no intent a successor would have to wait on", async () => {
    const h = held();
    const fence = h.fence((await h.claim()).fence);
    expect((await fence.settleFence().gate(request({ live: false }))).kind).toBe("gated");
    expect(h.db.intents).toHaveLength(0);
  });
});

describe("the shadow world: gated, written 'shadow', never sent", () => {
  const program = offlineProgram();

  it("gates a dry settle as a shadow row, drops its carry, and resolves it at once at the confirmed height", async () => {
    const h = held({ world: "shadow", confirmed: 940n });
    const fence = h.fence((await h.claim()).fence);
    const answer = await fence.settleFence().gate({
      link: link(),
      mode: 0,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: LVBH,
      idempotencyKey: "b".repeat(64),
      amountLamports: 1n,
      endSlot: 2n,
      carry: { lossLamports: 9n, walletSignedTxCount: 1 },
      validUntilSlot: 3n,
      live: false,
    });
    expect(answer.kind).toBe("gated");
    await fence.settled();
    expect(h.db.intents).toHaveLength(1);
    expect(h.db.intents[0]).toMatchObject({ state: "shadow", resolvedHeight: 940n });
    expect(h.db.carries).toHaveLength(0);
  });

  it("never lets a crank send through, even a gate-worthy one, and gates the would-be sends a dry invest names instead", async () => {
    const h = held({ world: "shadow" });
    const fence = h.fence((await h.claim()).fence);
    const c = chain();
    const refused = await sender(c.connection, fence).sendLegacy(await wrapTransaction(program, 1n), [CRANK]).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CrankSendRefused);
    expect(c.raw).toHaveLength(0);
    expect(h.db.intents).toHaveLength(0);

    await fence.shadowCrank("wrap", 7n, { blockhash: BLOCKHASH, lastValidBlockHeight: LVBH });
    await fence.shadowCrank("invest", null, { blockhash: BLOCKHASH, lastValidBlockHeight: LVBH });
    await fence.settled();
    expect(h.db.intents.map((row) => [row.kind, row.state, row.amountRaw])).toEqual([
      ["wrap", "shadow", 7n],
      ["invest", "shadow", null],
    ]);
    expect(h.db.intents.every((row) => row.resolvedAt !== null)).toBe(true);
    expect(c.raw).toHaveLength(0);
  });

  it("refuses a live settle outright: a shadow worker holds no key, so one reaching here is a bug", async () => {
    const h = held({ world: "shadow" });
    const fence = h.fence((await h.claim()).fence);
    const answer = await fence.settleFence().gate({
      link: link(),
      mode: 0,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: LVBH,
      idempotencyKey: "c".repeat(64),
      amountLamports: 1n,
      endSlot: 2n,
      carry: null,
      validUntilSlot: 3n,
      live: true,
    });
    expect(answer.kind).toBe("refused");
    expect(h.db.intents).toHaveLength(0);
  });
});
