// THE FENCED SENDER: one job's fence around every transaction it sends (dispatcher
// ADR §3.6, §4.4 F1; safety §2.2; plan P3a Q3, design detail 1).
//
// WHAT IT IS. A worker job holds one vault at one fence (src/dispatch-store.ts,
// CLAIM). Before EVERY send of that job — each link's settle, the wrap, the
// convert, every leg — the store's GATE runs: the vault row FOR SHARE, still this
// worker's at this fence with the margin left, the send_intent row inserted, and,
// for a PROFIT settle, its loss carry written in the same transaction (S-4). The
// bytes leave only once that COMMIT is acknowledged; any other answer drops them.
//
// TWO SEAMS, NO NEW SEND SITE.
//   * Crank sends (wrap, convert, legs) go through the explicit-send cut's
//     CrankSender (src/explicit-send.ts) — P2's order, blockhash → build → sign →
//     ask → GATE → send → poll — with crankGate() as its `gate`. The keeper's one
//     crank sendRawTransaction stays in that file (test/send-sites.test.ts).
//   * Settles go where settle-tick.ts used to write the carry before the send
//     (SettleDeps.fence): settleFence() is that write, as the gate transaction.
//     Privy still signs and broadcasts; the settle's id is recorded once Privy
//     answers (recordSignature).
//
// WHAT EACH INTENT BECOMES, told by the send that made it (its "ticket"):
//   * landed   — resolved 'landed' at the confirmed height read then, capped at
//                its last valid height: the last height at which it could have
//                acted is at most both. A landed LEG is not resolved here: its
//                history row is written first (the outbox, S-9, the job's), so
//                a worker that dies in between leaves it open for the successor,
//                which writes the row from the receipt, once (tx_ref is UNIQUE).
//   * reverted — resolved 'failed', the same way.
//   * expired  — resolved 'expired' at its last valid height.
//   * unknown  — LEFT OPEN: the send threw or was never confirmed, so it may
//                still land until the finalized height passes its last valid
//                height. The successor's takeover waits it out (ADR §3.6).
// A resolution that fails leaves the intent open, which is the safe direction.
//
// THE SHADOW WORLD (SIP_SOLANA_DISPATCH=shadow, design detail 1). The store
// writes the rows as 'shadow' and drops every carry; nothing here ever sends,
// because a shadow worker holds no key and its turns are dry runs. A shadow
// intent is resolved the moment it is gated, at the confirmed height — where a
// real send would have landed a moment later — so the next fence's plan floor
// waits out finality exactly as it would behind a real one. A shadow worker
// killed between its gate and that resolution leaves an open shadow intent, and
// its successor waits it out by height, as it would a real one.
//
// A4: NO DURABLE-NONCE CRANK TRANSACTION, EVER. Such a transaction never expires,
// which voids the takeover rule; a crank transaction whose first instruction is
// AdvanceNonceAccount is refused before the gate is asked.

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction, type VersionedTransaction } from "@solana/web3.js";
import { summarizeUpstreamError } from "@sip/solana-log";
import type { DispatchStore, GateAnswer, GateCarry, IntentDraft, IntentKind, IntentOutcome } from "./dispatch-store.js";
import { CrankSendRefused, type CrankSendEnd, type CrankSendGate, type CrankSendTicket, type SignedCrankSend } from "./explicit-send.js";
import { instructionDiscriminator } from "./idl.js";
import { keeperModeFor } from "./role-registry.js";
import type { SettleFence, SettleGateAnswer, SettleGateRequest, SettleTicket } from "./settle-tick.js";

/** What the fence needs of the store: the two gate forms, the resolution, and the settle's signature. */
export type FenceStore = Pick<DispatchStore, "gate" | "gateOneStatement" | "resolveIntent" | "recordSignature" | "holder" | "world">;

/** A crank kind: what a send other than a settle can be. */
export type CrankKind = Exclude<IntentKind, "settle">;

/** The three crank instructions, by the discriminator the IDL records for each. */
const CRANK_INSTRUCTIONS: readonly { readonly kind: CrankKind; readonly discriminator: Buffer; readonly amountAt: number }[] = [
  // wrap_sol(amount: u64)
  { kind: "wrap", discriminator: instructionDiscriminator("wrap_sol"), amountAt: 8 },
  // convert(amount_in: u64, min_out: u64, venue_data: bytes)
  { kind: "convert", discriminator: instructionDiscriminator("convert"), amountAt: 8 },
  // invest(leg_index: u8, amount_in: u64, min_out: u64, venue_data: bytes)
  { kind: "invest", discriminator: instructionDiscriminator("invest"), amountAt: 9 },
];

/** SystemInstruction::AdvanceNonceAccount, the u32 index the system program reads first. */
const ADVANCE_NONCE_ACCOUNT = 4;

/** One instruction as the fence reads it, from either message format. */
interface SeenInstruction {
  readonly programId: PublicKey;
  readonly data: Uint8Array;
}

function instructionsOf(transaction: Transaction | VersionedTransaction): readonly SeenInstruction[] {
  if (transaction instanceof Transaction) return transaction.instructions.map((ix) => ({ programId: ix.programId, data: ix.data }));
  // A PROGRAM ID IS ALWAYS A STATIC KEY: a lookup table can lend accounts, never the program an instruction runs.
  const keys = transaction.message.staticAccountKeys;
  return transaction.message.compiledInstructions.map((ix) => {
    const programId = keys[ix.programIdIndex];
    if (programId === undefined) throw new CrankSendRefused("fenced", "a crank instruction names a program outside the message's static keys; nothing was sent");
    return { programId, data: ix.data };
  });
}

/** The transaction's id: its first signature, base58. Null when it is not signed yet. */
export function signatureOf(transaction: Transaction | VersionedTransaction): string | null {
  const first = transaction instanceof Transaction ? transaction.signatures[0]?.signature : transaction.signatures[0];
  if (first === null || first === undefined || first.every((byte) => byte === 0)) return null;
  return anchor.utils.bytes.bs58.encode(Buffer.from(first));
}

/**
 * Which crank this transaction is, and how much it moves: the ONE sip-vault
 * instruction it carries among wrap_sol, convert and invest, and that
 * instruction's amount (the wrap's lamports, the convert's or the leg's
 * amount_in). REFUSES — CrankSendRefused("fenced"), nothing sent — a durable-nonce
 * transaction (A4), and one with no crank instruction or more than one: a fence
 * that cannot name what it lets through is not a fence.
 */
export function crankIntentOf(transaction: Transaction | VersionedTransaction, programId: PublicKey): { readonly kind: CrankKind; readonly amountRaw: bigint } {
  const instructions = instructionsOf(transaction);
  const first = instructions[0];
  if (first !== undefined && first.programId.equals(SystemProgram.programId) && first.data.length >= 4 && Buffer.from(first.data).readUInt32LE(0) === ADVANCE_NONCE_ACCOUNT) {
    throw new CrankSendRefused(
      "fenced",
      "a crank transaction that advances a durable nonce never expires, so no successor could ever wait it out; it was signed and not sent",
    );
  }
  const found: { kind: CrankKind; amountRaw: bigint }[] = [];
  for (const ix of instructions) {
    if (!ix.programId.equals(programId)) continue;
    const data = Buffer.from(ix.data);
    const crank = CRANK_INSTRUCTIONS.find((candidate) => data.length >= candidate.amountAt + 8 && data.subarray(0, 8).equals(candidate.discriminator));
    if (crank !== undefined) found.push({ kind: crank.kind, amountRaw: data.readBigUInt64LE(crank.amountAt) });
  }
  if (found.length !== 1) {
    throw new CrankSendRefused(
      "fenced",
      `a crank transaction carries ${found.length} wrap_sol, convert or invest instruction(s), not exactly one, so the fence cannot name it; it was signed and not sent`,
    );
  }
  return found[0]!;
}

/** One intent this job gated, and what became of it so far. */
export interface OwnIntent {
  readonly id: bigint;
  readonly kind: IntentKind;
  /** The settle's link; null for a crank send. */
  readonly link: string | null;
  signature: string | null;
  readonly lastValidBlockHeight: bigint;
  /** How it ended as far as this job knows: open until a ticket says otherwise. */
  state: "open" | "resolved" | "landed-awaiting-history";
}

/** What the job hands its fence. */
export interface JobFenceOptions {
  readonly store: FenceStore;
  readonly vault: string;
  readonly fence: bigint;
  /**
   * The finalized height this job saw pass every earlier fence's intents before
   * it planned (ADR §3.6) — NULL when no earlier fence ever gated on the vault,
   * which the gate accepts and the audit cannot count against anything: there
   * is no earlier row for it to be compared with, and none can appear once the
   * fence has moved.
   */
  readonly planClearedHeight: bigint | null;
  /** The sip-vault program: where the crank instructions are looked for. */
  readonly programId: PublicKey;
  /** The chain's confirmed block height now: where a landed or reverted send is resolved. */
  readonly confirmedHeight: () => Promise<bigint>;
  /**
   * Why this job may not send now — its lease is lost, its ceiling passed, the
   * process is draining — or null. ASKED BEFORE EVERY GATE, never cached.
   */
  readonly mayAct: () => string | null;
  /** Told every gate's answer, for the worker's stats and log. Its throw is swallowed. */
  readonly onGate?: (kind: IntentKind, answer: GateAnswer) => void;
  /** Told a resolution that could not be written (the intent stays open). Its throw is swallowed. */
  readonly onResolveFailed?: (intent: OwnIntent, detail: string) => void;
}

/**
 * One job's fence. Made when the job has planned — after its takeover cleared —
 * and dropped when the job completes or releases. The job reads `lostReason` at
 * every step: once a gate has said the lease is gone, nothing more is sent.
 */
export class JobFence {
  readonly #options: JobFenceOptions;
  readonly #own: OwnIntent[] = [];
  readonly #work = new Set<Promise<unknown>>();
  #lostReason: string | null = null;

  constructor(options: JobFenceOptions) {
    this.#options = options;
  }

  /** Why this job lost the right to send, once a gate said so; null until then. */
  get lostReason(): string | null {
    return this.#lostReason;
  }

  /** Every intent this job gated, in order. */
  get intents(): readonly OwnIntent[] {
    return this.#own;
  }

  /** The legs that landed and wait for their history row (the outbox, the job's). */
  landedAwaitingHistory(): readonly OwnIntent[] {
    return this.#own.filter((intent) => intent.state === "landed-awaiting-history");
  }

  /** Waits for every resolution and signature record a ticket started. Never throws. */
  async settled(): Promise<void> {
    while (this.#work.size > 0) await Promise.allSettled([...this.#work]);
  }

  /** A ticket's work, tracked so the job can wait for it before it completes; its failure is reported, never thrown. */
  #track(work: Promise<unknown>): void {
    const tracked = work.catch(() => undefined).finally(() => this.#work.delete(tracked));
    this.#work.add(tracked);
  }

  /**
   * The gate itself: mayAct, then the store — the transaction form when a carry
   * rides it, the one-statement form otherwise (fence-pg proves both).
   */
  async #gate(draft: IntentDraft, carry: GateCarry | null): Promise<GateAnswer> {
    // ASKED HERE, NOT OF THE STORE: a job that already lost its lease, ran past its
    // ceiling or is draining sends nothing, and is not a fence reject either.
    const blocked = this.#lostReason ?? this.#options.mayAct();
    if (blocked !== null) {
      this.#lostReason = blocked;
      return { kind: "refused", reason: "lease", detail: `${blocked}; nothing was sent` };
    }
    let answer: GateAnswer;
    try {
      answer = carry === null ? await this.#options.store.gateOneStatement(draft) : await this.#options.store.gate(draft, { carry });
    } catch (error) {
      // A GATE THAT THREW (a mis-wired carry) IS A GATE THAT DID NOT ANSWER: nothing is sent.
      answer = { kind: "unavailable", detail: `the gate threw (${summarizeUpstreamError(error)}); nothing was sent` };
    }
    // A LEASE OR PLAN-FLOOR REFUSAL ENDS THE JOB: the vault is someone else's, or this
    // job planned too early, and neither gets better by asking again.
    if (answer.kind === "refused") this.#lostReason = answer.detail;
    try {
      this.#options.onGate?.(draft.kind, answer);
    } catch {
      // A lost report is a gap in the stats, never a different answer.
    }
    return answer;
  }

  #draft(kind: IntentKind, fields: { link: string | null; blockhash: string; lastValidBlockHeight: number; signature: string | null; idempotencyKey: string | null; amountRaw: bigint | null }): IntentDraft {
    return {
      vault: this.#options.vault,
      fence: this.#options.fence,
      kind,
      link: fields.link,
      blockhash: fields.blockhash,
      lastValidBlockHeight: BigInt(fields.lastValidBlockHeight),
      planClearedHeight: this.#options.planClearedHeight,
      signature: fields.signature,
      idempotencyKey: fields.idempotencyKey,
      amountRaw: fields.amountRaw,
    };
  }

  /** Resolves one own intent, capped at its last valid height for landed and failed; a failure leaves it open. */
  async #resolve(intent: OwnIntent, outcome: IntentOutcome): Promise<void> {
    try {
      let height = intent.lastValidBlockHeight;
      if (outcome !== "expired") {
        const confirmed = await this.#options.confirmedHeight();
        height = confirmed < intent.lastValidBlockHeight ? confirmed : intent.lastValidBlockHeight;
      }
      await this.#options.store.resolveIntent(intent.id, outcome, height);
      intent.state = "resolved";
    } catch (error) {
      try {
        this.#options.onResolveFailed?.(intent, summarizeUpstreamError(error));
      } catch {
        // Reported or not, the intent stays open for the successor.
      }
    }
  }

  /** A shadow row is over as soon as it is written: nothing will ever be sent for it. */
  #shadowGated(intent: OwnIntent): void {
    this.#track(this.#resolve(intent, "landed"));
  }

  #remember(id: bigint, kind: IntentKind, link: string | null, signature: string | null, lastValidBlockHeight: number): OwnIntent {
    const intent: OwnIntent = { id, kind, link, signature, lastValidBlockHeight: BigInt(lastValidBlockHeight), state: "open" };
    this.#own.push(intent);
    return intent;
  }

  /** The CrankSender's gate for this job (CrankSendGate): the wrap, the convert and every leg. */
  crankGate(): CrankSendGate {
    return {
      admit: async (send: SignedCrankSend): Promise<CrankSendTicket> => {
        if (this.#options.store.world === "shadow") {
          throw new CrankSendRefused("fenced", "a shadow worker sends nothing: this crank transaction was signed and not sent");
        }
        const { kind, amountRaw } = crankIntentOf(send.transaction, this.#options.programId);
        const signature = signatureOf(send.transaction);
        const answer = await this.#gate(
          this.#draft(kind, { link: null, blockhash: send.blockhash, lastValidBlockHeight: send.lastValidBlockHeight, signature, idempotencyKey: null, amountRaw }),
          null,
        );
        if (answer.kind !== "gated") throw new CrankSendRefused("fenced", `the dispatcher's fence refused this ${kind}: ${answer.detail}`);
        const intent = this.#remember(answer.intentId, kind, null, signature, send.lastValidBlockHeight);
        return {
          ended: (end: CrankSendEnd): Promise<void> => {
            const work = this.#crankEnded(intent, end);
            this.#track(work);
            return work;
          },
        };
      },
    };
  }

  async #crankEnded(intent: OwnIntent, end: CrankSendEnd): Promise<void> {
    switch (end) {
      case "landed":
        // A LEG'S HISTORY ROW COMES FIRST (the outbox): the job writes it, then resolves.
        if (intent.kind === "invest") intent.state = "landed-awaiting-history";
        else await this.#resolve(intent, "landed");
        return;
      case "reverted":
        await this.#resolve(intent, "failed");
        return;
      case "expired":
        await this.#resolve(intent, "expired");
        return;
      case "unknown":
        // MAY STILL LAND: left open for the takeover rule.
        return;
    }
  }

  /** The job's own outbox step for a leg whose history row is written: resolve it as landed. */
  async historyWritten(intent: OwnIntent): Promise<void> {
    if (intent.state !== "landed-awaiting-history") return;
    await this.#resolve(intent, "landed");
  }

  /** settle-tick.ts's fence (SettleDeps.fence): each settle's gate, its carry inside it. */
  settleFence(): SettleFence {
    return {
      gate: async (request: SettleGateRequest): Promise<SettleGateAnswer> => {
        const world = this.#options.store.world;
        if (world === "shadow" && request.live) {
          // UNREACHABLE: a shadow worker holds no key, so its turns are dry. Refused rather than guessed at.
          return { kind: "refused", detail: "a shadow worker was asked to gate a live settle; nothing was signed or sent" };
        }
        if (world === "live" && !request.live) {
          // A DRY TURN IN THE LIVE WORLD SENDS NOTHING, so it writes no intent a successor would wait on.
          return { kind: "gated", ticket: NO_TICKET };
        }
        const link = request.link.linkAddress.toBase58();
        const carry: GateCarry | null =
          keeperModeFor(request.mode)?.carriesLosses === true
            ? { link: request.link, endSlot: request.endSlot, carry: request.carry, validUntilSlot: request.validUntilSlot }
            : null;
        const answer = await this.#gate(
          this.#draft("settle", {
            link,
            blockhash: request.blockhash,
            lastValidBlockHeight: request.lastValidBlockHeight,
            signature: null,
            idempotencyKey: request.idempotencyKey,
            amountRaw: request.amountLamports,
          }),
          carry,
        );
        if (answer.kind !== "gated") return { kind: "refused", detail: `the dispatcher's fence refused this settle: ${answer.detail}` };
        const intent = this.#remember(answer.intentId, "settle", link, null, request.lastValidBlockHeight);
        if (world === "shadow") {
          this.#shadowGated(intent);
          return { kind: "gated", ticket: NO_TICKET };
        }
        return {
          kind: "gated",
          ticket: {
            signed: (signature: string): void => {
              intent.signature = signature;
              this.#track(this.#options.store.recordSignature(intent.id, signature));
            },
            ended: (ended, outcome): void => {
              // A SETTLED TURN LANDED, however the send itself ended: the nonce moved
              // (settle-tick.ts reads it back before it reports a thrown send as SETTLED).
              if (outcome === "SETTLED") this.#track(this.#resolve(intent, "landed"));
              else if (ended === "reverted") this.#track(this.#resolve(intent, "failed"));
              // threw or unconfirmed, and not SETTLED: it may still land; the takeover waits it out.
            },
          },
        };
      },
    };
  }

  /**
   * A would-be crank send of a SHADOW job (its dry invest turn said it would
   * wrap or buy): the same gate a live send would pass, against a fresh
   * blockhash, and resolved at once. Nothing is signed and nothing is sent.
   */
  async shadowCrank(kind: CrankKind, amountRaw: bigint | null, recent: { readonly blockhash: string; readonly lastValidBlockHeight: number }): Promise<GateAnswer> {
    if (this.#options.store.world !== "shadow") throw new Error("shadowCrank is the shadow world's: a live job gates through its CrankSender");
    const answer = await this.#gate(
      this.#draft(kind, { link: null, blockhash: recent.blockhash, lastValidBlockHeight: recent.lastValidBlockHeight, signature: null, idempotencyKey: null, amountRaw }),
      null,
    );
    if (answer.kind === "gated") this.#shadowGated(this.#remember(answer.intentId, kind, null, null, recent.lastValidBlockHeight));
    return answer;
  }
}

/** The ticket of a gate that wrote nothing to follow up: a shadow row, or a dry turn in the live world. */
const NO_TICKET: SettleTicket = {
  signed: () => undefined,
  ended: () => undefined,
};
