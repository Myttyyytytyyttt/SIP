// One settlement turn for one linked wallet.
//
// Ported from Nuvem's solana-lab keeper (keeper/src/settle-tick.ts), moved to
// settle_v2. What is new: the vault arrives decoded through the IDL from the
// sweep's one batched read, a paused vault or protocol stops at PAUSED, an
// undefined mode stops at UNSUPPORTED_MODE while both real modes are measured, a
// confirmed probe decides whether there is anything to walk, the walk reads
// finalized history and must reach the frontier, a backlog settles its oldest
// complete prefix one sweep at a time, a flat span settles a zero base once it
// is worth a transaction, a losing prefix's zero settle carries its loss into
// the next window and records that carry before it is sent, the attestation
// binds the vault's own mode,
// rate and policy nonce and a deadline, the wallet's reserve is checked against
// the node's own fee before anything is signed, only [Ed25519SigVerify,
// settle_v2] paid by the wallet is sent on either route, the Privy route sends
// it once under an idempotency key of its own, a send is confirmed by polling
// its status, a refusal is classified by the program's own error name, a send
// that threw or never confirmed is read back from its link before it is
// reported, and a dry run measures and reports without any key in reach.
// What is unchanged: the frontier-from-epoch rule, the completeness checks
// behind the new frontier and finality stops, the receipt's own meta.err, and
// the vault delta read from pre/post balances.
//
// The decisions live in settle-decision.ts and settle-refusal.ts, where a test
// can reach them.

import { createHash } from "node:crypto";
import type * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Ed25519Program,
  Keypair,
  PublicKey,
  Transaction,
  type TransactionError,
  type TransactionInstruction,
} from "@solana/web3.js";
import { summarizeUpstreamError } from "@sip/solana-log";
import { perTradePolicyAddress, readSettlementNonce, type PerTradePolicyState, type VaultState } from "./accounts.js";
import { BN } from "./anchor-interop.js";
import type { ManagedLink } from "./discovery.js";
import { idl } from "./idl.js";
import { connectionReader, measureSince, readTransaction, type WalkCache } from "./measure-window.js";
import type { VolumeProbe } from "./measure-volume.js";
import { method } from "./methods.js";
import { SeatWithdrawnError, assertSettleShape, type SolanaWalletSubmitter } from "./privy-signer.js";
import { oracleRefusal, perTradePaid, type PerTradeCharge } from "./per-trade-base.js";
import {
  MODE_PROFIT,
  MODE_ROUNDUP,
  MODE_VOLUME,
  attestationInstruction,
  attestationMessage,
  attestationV3Instruction,
  attestationV3Message,
  pricesHashWords,
  type AttestationInputs,
  type AttestationV3Inputs,
} from "./program-scripts.js";
import type { PythPriceUpdate } from "./pyth.js";
import { isPerTradeMode, keeperModeFor } from "./role-registry.js";
import {
  attestationInputs,
  attestationV3Inputs,
  carryFor,
  decideFromMeasurement,
  defaultVolumeBase,
  expectedContribution,
  measurementStart,
  modeDecision,
  noSignerDetail,
  pauseDecision,
  recordCarry,
  reserveDecision,
  type CarryBook,
  type LossCarry,
  type PerTradeBase,
  type SettleOutcome,
  type SettleWaitingOn,
  type VolumeBase,
} from "./settle-decision.js";
import { classifySettleRefusal, type SettleRefusal } from "./settle-refusal.js";
import type { RestBook } from "./rest-book.js";
import type { CarryStoreTurn } from "./carry-store.js";

export type { SettleOutcome } from "./settle-decision.js";

export interface SettleResult {
  readonly outcome: SettleOutcome;
  readonly detail: string;
  /** The attested base. In PROFIT mode, the measured profit net of any loss carried into the window. */
  readonly baseLamports?: bigint;
  /** The mode `baseLamports` was measured in. */
  readonly mode?: number;
  readonly settledLamports?: bigint;
  /**
   * What settle_v2 computes for this base: floor(base × bps / 10 000), clipped at
   * max_contribution. A landed settle whose vault moved anything else is a warning.
   */
  readonly expectedLamports?: bigint;
  /** The node's price for this settle's message: the fee the reserve check counted. */
  readonly feeLamports?: bigint;
  /**
   * What this window TRADED, from the same walk that measured it (measureSince).
   * Recorded in the mirror so the leaderboard can rank by usage; never attested,
   * never charged, and absent from every outcome that measured nothing.
   */
  readonly tradedLamports?: bigint;
  /**
   * What this window traded BY THE VOLUME RULE (measure-volume.ts): the sum over
   * every transaction the volume probe counted, before any cadence or policy
   * boundary. Present only on a volume keeper's turns, which pass the probe.
   */
  readonly volumeLamports?: bigint;
  /**
   * WHEN THE CHAIN SAYS THIS SETTLED — the receipt's blockTime, in ms.
   *
   * The mirror's `at` used to default to the writer's clock, seconds later.
   * Seconds only matter once a year: a settle that lands just before midnight
   * UTC and is written just after is credited to the WRONG DAY, and the
   * leaderboard groups by day — a streak breaks, or one it should not have
   * earned appears. The receipt is already read, one line above, to learn how
   * much moved; taking its timestamp costs nothing and makes the live row and a
   * rebuilt one carry the same date. Absent when the receipt could not be read,
   * where the column's own default is the honest fallback.
   */
  readonly blockTimeMs?: number;
  readonly signature?: string;
  /** The nonce this settlement consumed, and the slot it closed. Carried out
   * so the keeper can record history without re-deriving either. */
  readonly nonce?: bigint;
  readonly endSlot?: bigint;
  /**
   * The loss, and the wallet-signed count, this settle hands to the window from
   * `endSlot` (LossCarry): set only on a PROFIT prefix's zero settle whose net base
   * is negative. A live turn has recorded it in the book before sending.
   */
  readonly carry?: LossCarry;
  /**
   * Set only on a RETRY that waited on something every wallet shares, never on
   * the wallet's own: the loss-carry store in `on` could not be read or written
   * (src/carry-store.ts). The keeper's per-wallet ladder neither counts nor pages
   * it (settleRetryStreak, settleAlert); the store pages once, for everyone.
   * Never set without a carry store, so a keeper without one alerts as before.
   */
  readonly waitingOn?: SettleWaitingOn;
  /**
   * A per-trade span that waits for its own clock: the unix second it settles
   * (MeasurementDecision.dueAt). Only a per-trade turn sets it.
   */
  readonly dueAt?: number;
  /**
   * A per-trade settle's charge, trade by trade (src/per-trade-base.ts): the
   * rows /status and the Live page list. Only a per-trade turn sets it.
   */
  readonly perTrade?: PerTradeCharge;
}

/**
 * What a per-trade vault's turn needs beyond the walk (SettleDeps.perTrade): the
 * dispatcher's per-trade module builds it once per job (src/settle-modules.ts).
 */
export interface PerTradeTurn {
  /** The span's charge and cadence (PerTradeBase). */
  readonly base: PerTradeBase;
  /** The vault's PerTradePolicy as the job read it: the daily counter the payment is clipped by. */
  readonly policy: PerTradePolicyState;
  /**
   * ROUND-UP: the Pyth SOL/USD account settle_v3 reads its floor from, and that
   * account as the job read it, checked here before anything is signed. Null for
   * FIXED, which passes no oracle.
   */
  readonly oracle: { readonly address: PublicKey; readonly update: PythPriceUpdate } | null;
  /** Unix seconds now: the UTC day the daily cap counts on. */
  readonly nowSeconds: () => number;
}

export interface SettleDeps {
  readonly connection: Connection;
  readonly program: anchor.Program;
  readonly link: ManagedLink;
  /**
   * The link's vault, decoded from the sweep's one batched read (readVaults),
   * or null when that read found no account at the address the link names.
   */
  readonly vault: VaultState | null;
  /** Signs attestations: the settle key. NULL IN DRY RUN — a dry run holds no key. */
  readonly attester: Keypair | null;
  /**
   * Signs the settle transaction AS THE TRADING WALLET: a Privy signer
   * (production: no key on this box) or, on localnet, a local keypair. Always
   * null in dry run, where resolving one would need secrets a dry run does not
   * read.
   */
  readonly walletSigner: SolanaWalletSubmitter | Keypair | null;
  readonly live: boolean;
  /**
   * The protocol's emergency switch, from the ProtocolConfig this sweep read.
   * False when there is no config, and then there are no links either.
   */
  readonly protocolPaused: boolean;
  /**
   * The modes THIS keeper settles, its role profile's `settles` in production
   * (src/role-registry.ts): exactly one.
   * REQUIRED, like the mode in MeasurementContext: a default could hand a VOLUME
   * vault to the profit keeper, and two keepers would settle one link.
   */
  readonly settles: readonly number[];
  /**
   * The volume keeper's probe (measure-volume.ts), handed to the walk so each
   * measured transaction carries what it traded. Absent on the profit keeper,
   * whose walk then runs no volume code.
   */
  readonly volumeProbe?: VolumeProbe;
  /**
   * Where a VOLUME span's notional comes from. Absent — as keeper.mts always
   * leaves it — it is defaultVolumeBase: zero for a span with no successful
   * trade, and nothing attested otherwise. keeper-medir-volumen replaces the
   * default; the local proof injects a notional here.
   */
  readonly volumeBase?: VolumeBase;
  /**
   * The losses zero settles carried forward, per link state (LossCarry): read
   * before the base is decided, and written before a live settle is sent.
   * REQUIRED, because a fresh book every turn would forget every carried loss
   * without a word. In memory: a restart forgets it.
   */
  readonly carries: CarryBook;
  /**
   * SIP_SOLANA_CARRY_STORE's store (src/carry-store.ts), passed only when it is
   * `dual` or `on`. ABSENT IS `off`, which is today: `carries` is read and written
   * here, in memory, exactly as before the store existed.
   *
   * PRESENT, IT OWNS BOTH THE READ AND THE WRITE, `carries` included. In `on` a
   * read it cannot make ends the turn RETRY before anything is decided, and a
   * write it cannot make — or its gate refuses — ends it RETRY before anything is
   * sent: a settle never leaves without the carry it owes or hands on.
   */
  readonly carryStore?: CarryStoreTurn;
  /**
   * What earlier sweeps' walks read, kept by keeper.mts for the life of the
   * process (WalkCache). Absent, every turn whose walk reaches its frontier
   * fetches its whole window again — the anchor and the oldest prefix above it.
   */
  readonly walkCache?: WalkCache;
  /**
   * The `rest-skip` cut's memos (src/rest-book.ts), kept by keeper.mts for the
   * life of the process, and only when SIP_SOLANA_CUTS names the cut. ABSENT IS
   * TODAY: every turn whose probe sees a signature above the frontier walks.
   *
   * IT CAN ONLY RETURN A RESTING STATE. A memo answers IDLE, with the loop
   * guard's own detail, for a link whose probe shows exactly what the walk that
   * wrote it showed; it is read before any walk and written after one, and
   * nothing between a base and a send ever looks at it.
   */
  readonly restBook?: RestBook;
  /**
   * Told, after the fact, what each live send took and how it ended
   * (SettleSend): /status's turn timers and the Privy signature count by mode
   * (bin/keeper.mts). Absent, nothing is told.
   *
   * IT CANNOT CHANGE THE SETTLE. It is called only once the outcome it reports
   * has happened, its return value is ignored, and a throw from it is
   * swallowed where it is called (tellSend): every line of this function that
   * decides what is sent, or what is reported, runs exactly as it would without
   * it. A test holds that a throwing onSend leaves the outcome identical.
   */
  readonly onSend?: (send: SettleSend) => void;
  /**
   * THE DISPATCHER'S FENCE (src/fenced-sender.ts, ADR §3.6, §4.4 F1), a worker's
   * only. ABSENT — as every legacy keeper leaves it — this turn is exactly what
   * it was: the carry is written by `carries` or `carryStore` before the send,
   * and a dry run returns its "would settle" without asking anyone.
   *
   * PRESENT, IT TAKES THE CARRY WRITE'S PLACE. The settle's GATE runs where the
   * carry was written — after the shape check and the seat check, before the
   * wallet signs or Privy is asked — and writes the PROFIT carry inside its own
   * transaction (S-4); anything but `gated` ends the turn RETRY with nothing
   * sent. The ticket it hands back is told the settle's id once it is known, and
   * how the send ended. A DRY RUN ASKS IT TOO, which is the shadow world's whole
   * point (plan P3a design detail 1): the would-be settle is gated, as a shadow
   * intent, exactly where a live one would be, and still nothing is sent.
   *
   * IT CANNOT CHANGE WHAT IS SENT. Every byte is decided before it is asked,
   * and a ticket's methods are told after the fact, inside a try of their own.
   */
  readonly fence?: SettleFence;
  /**
   * A PER-TRADE VAULT'S TURN (ROUND-UP, FIXED), from the dispatcher's per-trade
   * module only. ABSENT — as every legacy keeper leaves it — a per-trade vault
   * rests at UNSUPPORTED_MODE (modeDecision first, then the measurement's own
   * stop), and nothing here builds settle_v3. PRESENT, a span the seam charges is
   * attested as SIP_SETTLE_V3 and sent as [Ed25519SigVerify, settle_v3] through
   * the same fence, seat check, send and landing as a settle_v2.
   */
  readonly perTrade?: PerTradeTurn;
}

/** What the dispatcher's fence is told about one settle about to leave (SettleDeps.fence). */
export interface SettleGateRequest {
  readonly link: ManagedLink;
  /** The mode the attestation charges in: whether a carry rides the gate (KeeperMode.carriesLosses). */
  readonly mode: number;
  /** The blockhash the settle is built over, and its last valid block height: when it can no longer land. */
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
  /** settleIdempotencyKey: the settle's handle until Privy answers with its id. */
  readonly idempotencyKey: string;
  /** What settle_v2 moves for this base (expectedContribution's `paid`). */
  readonly amountLamports: bigint;
  /** The window's end slot: the frontier of the state the settle leaves. */
  readonly endSlot: bigint;
  /** The loss this settle hands to the window above it, or null — recorded either way, as recordCarry records it. */
  readonly carry: LossCarry | null;
  readonly validUntilSlot: bigint;
  /** False for a dry run: a shadow worker's would-be settle, gated and never sent. */
  readonly live: boolean;
}

/** What a settle's ticket is told, after the fact. Neither method can change the settle. */
export interface SettleTicket {
  /** The settle's id, once it is known: Privy's answer, or the local keypair's send. */
  signed(signature: string): void;
  /** How the send ended (SettleSend.ended), and the outcome this turn then reports. */
  ended(ended: SettleSend["ended"], outcome: SettleOutcome): void;
}

export type SettleGateAnswer = { readonly kind: "gated"; readonly ticket: SettleTicket } | { readonly kind: "refused"; readonly detail: string };

/** The dispatcher's fence as a settle turn sees it (src/fenced-sender.ts, JobFence.settleFence). */
export interface SettleFence {
  gate(request: SettleGateRequest): Promise<SettleGateAnswer>;
}

/** Tells the fence's ticket something, where nothing it does can reach the settle. */
function tellTicket(ticket: SettleTicket | null, tell: (ticket: SettleTicket) => void): void {
  if (ticket === null) return;
  try {
    tell(ticket);
  } catch {
    // The fence's record is the fence's; an intent it could not follow stays open for the successor.
  }
}

/**
 * One live settle send, as onSend is told it.
 *
 * TWO DURATIONS, BECAUSE THEY ARE TWO DIFFERENT WAITS. `submitMs` is the send
 * itself — Privy signing and broadcasting, or the node accepting a local
 * keypair's bytes; `confirmMs` is the landing poll after it, null when the send
 * threw and nothing was polled. The ADR sizes the dispatcher on "a send of
 * about 2 s" (ASSUMED, never measured), and which half of those seconds is
 * Privy's and which is the chain's decides what could make it shorter.
 */
export interface SettleSend {
  /** Which route sent it: Privy (a signature on the free-tier count) or a local keypair (localnet). */
  readonly route: "privy" | "local-keypair";
  /** The mode byte the attestation charged in. */
  readonly mode: number;
  readonly submitMs: number;
  readonly confirmMs: number | null;
  /**
   * How it ended, as the landing poll saw it: confirmed and landed, confirmed
   * with an on-chain error, no confirmed status within CONFIRM_TIMEOUT_MS, or
   * the send itself threw. What the turn then REPORTS can differ — a send that
   * threw and whose nonce moved is SETTLED — because that is decided after,
   * from the link, and is the outcome's business, not this record's.
   */
  readonly ended: "landed" | "reverted" | "unconfirmed" | "threw";
}

/** Hands one send to onSend, if there is one, where nothing it does can reach the settle. */
function tellSend(deps: SettleDeps, send: SettleSend): void {
  if (deps.onSend === undefined) return;
  try {
    deps.onSend(send);
  } catch {
    // A lost report is a gap on /status. The settle's outcome is already decided.
  }
}

/** How often a sent settle's status is asked for. */
export const CONFIRM_POLL_MS = 500;

/**
 * How long a sent settle is waited for: 60 s, about the life of the blockhash it
 * carries (150 blocks) and of its attestation's 150-slot deadline. A settle not
 * confirmed by then is read back from its link, and otherwise retried.
 */
export const CONFIRM_TIMEOUT_MS = 60_000;

/**
 * rent_exempt(0) per connection, read once: the rent floor settle_v2 adds to
 * wallet_reserve. Rent does not change while a process runs. A read that failed
 * is forgotten, so the next turn asks again.
 */
const rentExemptZeroByConnection = new WeakMap<Connection, Promise<bigint>>();

function rentExemptZero(connection: Connection): Promise<bigint> {
  const cached = rentExemptZeroByConnection.get(connection);
  if (cached !== undefined) return cached;
  const read = connection.getMinimumBalanceForRentExemption(0).then((lamports) => BigInt(lamports));
  rentExemptZeroByConnection.set(connection, read);
  read.catch(() => rentExemptZeroByConnection.delete(connection));
  return read;
}

/**
 * Whether a sent settle landed: its confirmed error, null for success — or null
 * for the whole answer when no confirmed status arrived within CONFIRM_TIMEOUT_MS.
 *
 * HTTP POLLING, NOT confirmTransaction. confirmTransaction listens on a websocket
 * web3.js derives from the Connection's one endpoint, outside the pool's failover
 * (rpc-pool.ts), and a confirmation that timed out became FAILED however the
 * settle had ended. Every getSignatureStatuses here goes through the pool, and a
 * request that throws is asked again until the deadline.
 *
 * CONFIRMED, FOR SUCCESS AND FOR FAILURE ALIKE, as confirmTransaction's
 * "confirmed" was: an error seen at processed can belong to a fork that is dropped.
 */
async function landing(connection: Connection, signature: string): Promise<{ readonly err: TransactionError | null } | null> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  for (;;) {
    try {
      const { value } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const status = value[0];
      // A node that omits confirmationStatus reports a rooted transaction as confirmations: null.
      const level = status?.confirmationStatus ?? (status?.confirmations === null ? "finalized" : "processed");
      if (status && (level === "confirmed" || level === "finalized")) return { err: status.err };
    } catch {
      // Asked again below: the pool has set the failing endpoint aside.
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, CONFIRM_POLL_MS));
  }
}

/** The settle_v2 instruction for an attestation's inputs: the IDL's own builder, over the accounts the link names. */
export function settleInstruction(
  program: anchor.Program,
  link: Pick<ManagedLink, "wallet" | "vault" | "linkAddress">,
  inputs: AttestationInputs,
): Promise<TransactionInstruction> {
  return method(program, "settleV2")(
    inputs.mode,
    new BN(inputs.sessionStartSlot.toString()),
    new BN(inputs.sessionEndSlot.toString()),
    new BN(inputs.baseLamports.toString()),
    new BN(inputs.validUntilSlot.toString()),
  )
    .accountsPartial({ wallet: link.wallet, vault: link.vault, tradingLink: link.linkAddress })
    .instruction();
}

/**
 * A settle transaction, as it is priced and as it leaves on either route.
 *
 * THE ORDER IS LOAD-BEARING: settle_v2 proves, through the instructions
 * sysvar, that the instruction IMMEDIATELY BEFORE it is the attester's
 * Ed25519 verification of exactly this message. The transaction is signed
 * BY the wallet, which pays, and carries the blockhash its fee was priced at.
 * assertSettleShape (privy-signer.ts) holds every settle sent to this shape.
 */
export function settleTransaction(
  recent: { readonly blockhash: string; readonly lastValidBlockHeight: number },
  wallet: PublicKey,
  attestation: TransactionInstruction,
  settle: TransactionInstruction,
): Transaction {
  return new Transaction({ blockhash: recent.blockhash, lastValidBlockHeight: recent.lastValidBlockHeight, feePayer: wallet }).add(attestation, settle);
}

/**
 * The idempotency key one settle attempt is sent to Privy under: sha256, in hex,
 * of the link, the nonce its attestation consumes and the attestation's deadline.
 *
 * NEW FOR EVERY ATTEMPT. On /rpc Privy caches a 4xx or a 5xx against the key for
 * 24 hours and replays it (docs.privy.io, api-reference/idempotency-keys, "Error
 * replay behavior"), so a key the next sweep reused after a 504 could only ever
 * be answered 504. The deadline is the chain's confirmed slot at the turn plus
 * ATTESTATION_VALIDITY_SLOTS, so each sweep's attempt carries its own, and a
 * landed settle moves the nonce, so no later attempt shares its key either. Only
 * a node that reports the same confirmed slot to two sweeps repeats one, and
 * Privy answers that repeat from its record rather than signing again.
 */
export function settleIdempotencyKey(link: Pick<ManagedLink, "linkAddress" | "settlementNonce">, validUntilSlot: bigint): string {
  return createHash("sha256").update(`${link.linkAddress.toBase58()}:${link.settlementNonce}:${validUntilSlot}`).digest("hex");
}

/** A refusal's detail: where it happened, what said no, and what happens next. `instruction` names the settle that was refused. */
function refusalDetail(where: string, refusal: SettleRefusal, raw: string, instruction: "settle_v2" | "settle_v3" = "settle_v2"): string {
  switch (refusal.outcome) {
    case "PAUSED":
      return (
        `${where}: ${instruction} refused it with ${refusal.programError} — a pause switch went on after this sweep read the vault; ` +
        "nothing moved and the frontier stays put"
      );
    case "BELOW_RESERVE":
      return (
        `${where}: ${instruction} refused it with ${refusal.programError} — the wallet dropped below its reserve after its balance was read; ` +
        "nothing moved and the frontier stays put until it is funded"
      );
    case "RETRY":
      return (
        `${where}: ${refusal.programError === null ? raw : `${instruction} refused it with ${refusal.programError}`} — ` +
        "the next sweep reads the vault and the link again and measures anew"
      );
    case "FAILED":
      return `${where}: ${refusal.programError === null ? raw : `${instruction} refused it with ${refusal.programError} (${raw})`}`;
  }
}

export async function runSettleTick(deps: SettleDeps): Promise<SettleResult> {
  const { connection, program, link, vault } = deps;

  // THE VAULT COMES FROM THIS SWEEP'S BATCHED READ, NEVER FROM AN EARLIER ONE.
  // Its mode, its rate and its policy nonce are what settle_v2 rebuilds into the
  // message it verifies. Within a sweep the copy is as old as the turns before
  // this one; a policy the owner writes in that gap makes this attestation a
  // different byte string, so settle_v2 refuses it, nothing moves, the frontier
  // stays, and the next sweep reads the new policy.
  if (vault === null) {
    // NOT A RESTING STATE. No sip-vault instruction closes a vault (withdraw
    // keeps its rent floor) and settle_v2 needs this one, so an address the
    // sweep's read found empty means the read or the link is wrong, and a human
    // should look.
    return {
      outcome: "FAILED",
      detail:
        `vault account missing: the sweep's read found no account at ${link.vault.toBase58()}, the vault this link names; ` +
        "nothing was measured or attested",
    };
  }
  // EITHER PAUSE SWITCH ENDS THE TURN HERE, before the mode, in settle.rs's own
  // order. settle_v2 refuses both, so a turn that measured, signed and sent
  // anyway burned a fee and fired a critical "settlement failed" for every
  // wallet, every sweep, over a switch someone turned on deliberately.
  const paused = pauseDecision(vault, deps.protocolPaused);
  if (paused !== null) return paused;
  const unsupported = modeDecision(vault, deps.settles);
  if (unsupported !== null) return unsupported;

  if (deps.live && deps.walletSigner === null) {
    return { outcome: "NO_SIGNER", detail: noSignerDetail(link.wallet) };
  }

  // Measure ONLY the unsettled span.
  const from = measurementStart(link);
  // ONE CONFIRMED PROBE BEFORE ANY WALK: the wallet's newest signature. None
  // above the start is an idle wallet, and it costs this one request, as its one
  // page did before the walk read finalized history. Past this line there IS
  // activity above the start, which is how an empty finalized walk is known to
  // be finality catching up rather than a wallet with nothing to settle.
  const [newest] = await connection.getSignaturesForAddress(link.wallet, { limit: 1 }, "confirmed");
  if (newest === undefined || BigInt(newest.slot) <= from) {
    return { outcome: "IDLE", detail: `nothing since slot ${from}` };
  }
  // A LINK RESTING ON ITS OWN SETTLE, WHOSE PROBE SHOWS WHAT THE LAST WALK SHOWED
  // (the `rest-skip` cut, src/rest-book.ts): the walk would read the same final
  // history and stop at the same loop guard, so its answer is returned without
  // it — the same IDLE in the same words. Any other newest signature, or a link
  // state that moved, misses here and walks.
  const resting = deps.restBook?.restingDetail(link, newest.signature) ?? null;
  if (resting !== null) return { outcome: "IDLE", detail: resting };
  // BEFORE THE WALK, NOT AFTER: see MeasurementContext.finalizedSlot.
  const finalizedSlot = BigInt(await connection.getSlot("finalized"));
  const measured = await measureSince(connectionReader(connection), link.wallet, from, program.programId, deps.volumeProbe, {
    cache: deps.walkCache,
  });
  // THE CARRY FOR THIS LINK'S EXACT STATE, read after the walk and before the base.
  // Only a zero settle that landed leaves a link in the state a carry was recorded
  // for, so a loss is netted once, by the window right above that settle.
  let carry: LossCarry | null;
  if (deps.carryStore === undefined) {
    carry = carryFor(deps.carries, link);
  } else {
    // A CARRY THAT CANNOT BE READ IS A BASE THAT CANNOT BE KNOWN (`on` only; `dual`
    // decides from memory whatever Postgres says).
    const read = await deps.carryStore.carryFor(deps.carries, link, vault.skimMode);
    if ("unavailable" in read) {
      return {
        outcome: "RETRY",
        detail: `${read.unavailable}: the loss this span may owe is unknown, so nothing was attested or sent; the next sweep reads it again`,
        waitingOn: "carry-store",
      };
    }
    carry = read.carry;
  }
  const decision = await decideFromMeasurement(measured, {
    from,
    finalizedSlot,
    mode: vault.skimMode,
    volumeBase: deps.volumeBase ?? defaultVolumeBase,
    carry,
    ...(deps.perTrade === undefined ? {} : { perTrade: deps.perTrade.base }),
  });
  if (decision.kind === "stop") {
    // REMEMBERED ONLY WHEN THE WALK SAW EVERYTHING THE PROBE DID: its newest
    // finalized signature is the probe's newest confirmed one. A settle the walk
    // could not see yet (confirmed, not finalized) ends elsewhere, at
    // PENDING_FINALITY, and writes nothing.
    if (deps.restBook !== undefined && decision.ownSettleOnly === true && measured.newestSignature === newest.signature) {
      deps.restBook.record(link, newest.signature, decision.detail);
    }
    return {
      outcome: decision.outcome,
      detail: decision.detail,
      ...(decision.baseLamports === undefined ? {} : { baseLamports: decision.baseLamports }),
      ...(decision.dueAt === undefined ? {} : { dueAt: decision.dueAt }),
    };
  }

  // A PER-TRADE SPAN SETTLES THROUGH settle_v3, and only with its module's turn:
  // the decision above is a settle only when the seam was there to charge it.
  if (isPerTradeMode(vault.skimMode)) {
    if (deps.perTrade === undefined || decision.perTrade === undefined) {
      return { outcome: "FAILED", detail: `a skim_mode ${vault.skimMode} span reached its settle without a per-trade charge; nothing was attested or sent` };
    }
    return settlePerTrade(deps, vault, deps.perTrade, {
      from,
      endSlot: decision.endSlot,
      charge: decision.perTrade,
      measured,
      backlog: decision.backlog === undefined ? "" : `; ${decision.backlog}`,
    });
  }

  // A BACKLOG SAYS HOW MUCH OF IT THIS SETTLE TAKES, in every SETTLED detail
  // below: the window is the span's oldest complete prefix, and the next sweep
  // measures the rest from its end.
  const backlog = decision.backlog === undefined ? "" : `; ${decision.backlog}`;
  // A CARRY SAYS WHAT IT TOOK AND WHAT IT LEAVES, in every SETTLED detail below,
  // right after the backlog: a PROFIT base is net of the loss an earlier zero settle
  // carried into this window, and a losing prefix's zero settle names the loss and
  // the count it hands to the window above. Neither appears without a carry, so a
  // detail with none reads as it always did.
  const applied = carry !== null && vault.skimMode === MODE_PROFIT ? `; net of ${carry.lossLamports} lamports carried` : "";
  const passing =
    decision.carry === undefined
      ? ""
      : `; ${deps.live ? "carrying" : "would carry"} ${decision.carry.lossLamports} lamports of losses and ` +
        `${decision.carry.walletSignedTxCount} wallet-signed transactions into the window from slot ${decision.endSlot}`;

  // The deadline counts from the chain's own confirmed slot, read now rather
  // than taken from the measurement: a walk over a busy span takes seconds.
  const currentSlot = BigInt(await connection.getSlot("confirmed"));
  const inputs = attestationInputs({
    programId: program.programId,
    link,
    vault,
    from,
    endSlot: decision.endSlot,
    baseLamports: decision.baseLamports,
    currentSlot,
  });
  const { owed, paid } = expectedContribution(inputs.baseLamports, inputs.bps, vault.maxContribution);
  const clipped = paid < owed ? `, clipped at max_contribution ${vault.maxContribution}` : "";

  // BUILT ONCE, PRICED, THEN SENT. The fee below is the node's price for a
  // message carrying exactly this instruction and this blockhash, and a live
  // turn sends those same two.
  const settleIx = await settleInstruction(program, link, inputs);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

  // THE RESERVE, BEFORE ANYTHING IS SIGNED, IN DRY RUN TOO. settle_v2 refuses a
  // payment that would leave the wallet below rent_exempt(0) + wallet_reserve,
  // and the wallet pays the fee before settle_v2 runs. A turn that signed and sent
  // anyway burned that fee and paged a critical "settlement failed" every sweep
  // for a wallet that only needed funding. The fee is not a constant: it is the
  // node's price for this message, the Ed25519 instruction's signature included,
  // with the attester's key and a blank signature of the same size standing in
  // for the one a live turn signs.
  const priced = settleTransaction(
    { blockhash, lastValidBlockHeight },
    link.wallet,
    Ed25519Program.createInstructionWithPublicKey({
      publicKey: deps.attester?.publicKey.toBytes() ?? new Uint8Array(32),
      message: attestationMessage(inputs),
      signature: new Uint8Array(64),
    }),
    settleIx,
  );
  const { value: fee } = await connection.getFeeForMessage(priced.compileMessage(), "confirmed");
  if (fee === null) {
    return {
      outcome: "RETRY",
      detail: "the node could not price this settle's fee, so the wallet's reserve could not be checked; nothing was signed",
    };
  }
  const feeLamports = BigInt(fee);
  const walletLamports = BigInt(await connection.getBalance(link.wallet, "confirmed"));
  const belowReserve = reserveDecision({
    walletLamports,
    feeLamports,
    rentExemptZero: await rentExemptZero(connection),
    walletReserve: vault.walletReserve,
    paid,
  });
  /** What every result from here on carries. */
  const carried = {
    baseLamports: inputs.baseLamports,
    mode: inputs.mode,
    feeLamports,
    expectedLamports: paid,
    tradedLamports: measured.tradedLamports,
    ...(measured.volumeTrades === undefined ? {} : { volumeLamports: measured.volumeTrades.reduce((sum, trade) => sum + trade.lamports, 0n) }),
    ...(decision.carry === undefined ? {} : { carry: decision.carry }),
  };
  if (belowReserve !== null) return { ...belowReserve, ...carried };

  if (!deps.live) {
    // THE SHADOW WORLD'S GATE (SettleDeps.fence): the would-be settle is gated
    // exactly where a live one is, and a refusal is this turn's answer. Without
    // a fence a dry run asks nobody, as it never has.
    if (deps.fence !== undefined) {
      const gated = await deps.fence.gate({
        link,
        mode: inputs.mode,
        blockhash,
        lastValidBlockHeight,
        idempotencyKey: settleIdempotencyKey(link, inputs.validUntilSlot),
        amountLamports: paid,
        endSlot: decision.endSlot,
        carry: decision.carry ?? null,
        validUntilSlot: inputs.validUntilSlot,
        live: false,
      });
      if (gated.kind !== "gated") return { outcome: "RETRY", detail: `DRY RUN — ${gated.detail}`, ...carried };
    }
    const modeName = inputs.mode === MODE_VOLUME ? "VOLUME" : "PROFIT";
    return {
      outcome: "SETTLED",
      detail:
        // A ZERO BASE SAYS WHAT IT IS FOR: nothing moves, and the frontier does.
        inputs.baseLamports === 0n
          ? `DRY RUN — would settle 0 lamports in ${modeName} at ${inputs.bps} bps and advance the frontier ` +
            `from ${inputs.sessionStartSlot} to ${inputs.sessionEndSlot} over ${measured.txCount} txs${backlog}${applied}${passing}`
          : `DRY RUN — would settle ${paid} lamports (${owed} owed at ${inputs.bps} bps${clipped}) ` +
            `from ${inputs.baseLamports} lamports of measured ${inputs.mode === MODE_VOLUME ? "notional" : "profit"} ` +
            `over slots ${inputs.sessionStartSlot}..${inputs.sessionEndSlot}${backlog}${applied}${passing}`,
      ...carried,
    };
  }

  const attester = deps.attester;
  const walletSigner = deps.walletSigner;
  if (attester === null || walletSigner === null) {
    // Unreachable from the keeper, which builds live deps only from an armed
    // config. Refused here too, because the alternative is an unattested send.
    return { outcome: "FAILED", detail: "a live settle turn arrived without the settle key or a wallet signer; nothing was sent" };
  }

  const expectation = `${paid} expected at ${inputs.bps} bps${clipped}`;

  // A REFUSAL THE CHAIN STATED is named by the program and classified. Nothing is
  // read back: a settle that reverted moved no nonce.
  const refused = (err: TransactionError, where: string, signature: string): SettleResult => {
    const refusal = classifySettleRefusal(err, idl);
    return { outcome: refusal.outcome, detail: refusalDetail(where, refusal, JSON.stringify(err)), ...carried, signature };
  };

  // A SETTLE THAT LANDED IS NEVER FAILED. A send can throw after the transaction
  // reached a leader — a 504 from Privy, a connection dropped mid-answer — and a
  // confirmation can time out on a settle that landed. settle_v2 bumps the link's
  // nonce exactly once for each settle that lands, so before a thrown or
  // unconfirmed send is reported RETRY or FAILED, the link is read again: one
  // nonce past this attestation's is this settle, landed. A read that fails
  // proves nothing and leaves the classification standing.
  const unconfirmed = async (error: unknown, where: string, raw: string, signature?: string): Promise<SettleResult> => {
    const refusal = classifySettleRefusal(error, idl);
    const withSignature = signature === undefined ? {} : { signature };
    if (refusal.outcome === "RETRY" || refusal.outcome === "FAILED") {
      const nonce = await readSettlementNonce(program, link.linkAddress).catch(() => null);
      if (nonce === link.settlementNonce + 1n) {
        return {
          outcome: "SETTLED",
          detail: `landed; receipt not read — ${where}, and this link's nonce has moved to ${nonce} (${expectation})${backlog}${applied}${passing}`,
          ...carried,
          ...withSignature,
          nonce: link.settlementNonce,
          endSlot: inputs.sessionEndSlot,
        };
      }
    }
    return { outcome: refusal.outcome, detail: refusalDetail(where, refusal, raw), ...carried, ...withSignature };
  };

  // The same two instructions the fee was priced for, the attestation now signed.
  const tx = settleTransaction({ blockhash, lastValidBlockHeight }, link.wallet, attestationInstruction(attester.secretKey, inputs), settleIx);

  // ONLY THE SETTLE LEAVES, ON EITHER ROUTE. The Privy policy privy-policy.ts
  // builds lets the signer send settle_v2 and Ed25519SigVerify instructions, in
  // any number and order, and the local route has no policy at all, so the exact
  // shape is held here, before a keypair signs or Privy is asked, and the local
  // proof sends through the same check the product path does. A transaction that fails
  // it is a bug in this file: nothing is sent, and a human should look.
  try {
    assertSettleShape(tx, program.programId, link.wallet);
  } catch (error) {
    return { outcome: "FAILED", detail: error instanceof Error ? error.message : String(error), ...carried };
  }

  // THE SEAT IS ASKED ABOUT BEFORE THE SEND, when the signer can be asked
  // (SolanaWalletSubmitter.confirmSeat: only under the `privy-address` cut, whose
  // records can be 30 minutes old). A seat its owner removed or unbounded since
  // is the NO_SIGNER the next sweep would report — not a send Privy refuses,
  // which is FAILED and pages "A settlement failed" for the owner's own press of
  // Remove SaverFi permission. Nothing is recorded and nothing is told: nothing
  // leaves. Any other throw is a defect in the check and propagates, as a turn
  // that threw.
  if (!(walletSigner instanceof Keypair) && walletSigner.confirmSeat !== undefined) {
    try {
      await walletSigner.confirmSeat();
    } catch (error) {
      if (!(error instanceof SeatWithdrawnError)) throw error;
      return { outcome: "NO_SIGNER", detail: `${noSignerDetail(link.wallet)}. ${error.message}`, ...carried };
    }
  }

  // THE CARRY IS RECORDED BEFORE THE SEND, NEVER AFTER IT. A send can throw, or go
  // unconfirmed, on a settle that landed, and the next sweep then reads the link in
  // the state this settle leaves: a carry recorded only once the send answered
  // would be missing there, and the loss forgotten. A settle that never lands leaves
  // the link where it is, whose own entry recordCarry keeps. A NULL IS RECORDED TOO:
  // an earlier attempt from this state may have left a carry under the state this
  // settle leaves, for another window, and it must not net against this one. A dry
  // run and BELOW_RESERVE returned above, so neither records anything.
  //
  // UNDER THE DISPATCHER'S FENCE THE CARRY IS WRITTEN BY THE GATE, in the gate's
  // own transaction (SettleDeps.fence, S-4): the intent and the carry commit
  // together or not at all, and nothing leaves without both.
  let ticket: SettleTicket | null = null;
  if (deps.fence !== undefined) {
    const gated = await deps.fence.gate({
      link,
      mode: inputs.mode,
      blockhash,
      lastValidBlockHeight,
      idempotencyKey: settleIdempotencyKey(link, inputs.validUntilSlot),
      amountLamports: paid,
      endSlot: decision.endSlot,
      carry: decision.carry ?? null,
      validUntilSlot: inputs.validUntilSlot,
      live: true,
    });
    if (gated.kind !== "gated") return { outcome: "RETRY", detail: gated.detail, ...carried };
    ticket = gated.ticket;
  } else if (deps.carryStore === undefined) {
    recordCarry(deps.carries, link, decision.endSlot, decision.carry ?? null);
  } else {
    // IN `on`, NOTHING LEAVES UNLESS THE STORE HAS IT: a write it cannot make, or
    // one its gate refuses because another settle's carry stands in the way, ends
    // the turn here, before the wallet signs anything.
    const write = await deps.carryStore.recordCarry(deps.carries, link, decision.endSlot, decision.carry ?? null, vault.skimMode, {
      currentSlot,
      validUntilSlot: inputs.validUntilSlot,
      nonceNow: () => readSettlementNonce(program, link.linkAddress).catch(() => null),
    });
    // REFUSED BY THE GATE is this link's own state; UNAVAILABLE is the store's, every wallet's at once.
    if (write.kind === "refused") return { outcome: "RETRY", detail: write.detail, ...carried };
    if (write.kind === "unavailable") return { outcome: "RETRY", detail: write.detail, waitingOn: "carry-store", ...carried };
  }

  const route: SettleSend["route"] = walletSigner instanceof Keypair ? "local-keypair" : "privy";
  const sentAt = Date.now();
  let signature: string;
  try {
    signature = await sendSettle(connection, walletSigner, tx, settleIdempotencyKey(link, inputs.validUntilSlot));
  } catch (error) {
    tellSend(deps, { route, mode: inputs.mode, submitMs: Date.now() - sentAt, confirmMs: null, ended: "threw" });
    const threw = await unconfirmed(error, "sending the settle threw", summarizeUpstreamError(error, { take: 3, maxChars: 500 }));
    tellTicket(ticket, (fenced) => fenced.ended("threw", threw.outcome));
    return threw;
  }
  // THE SETTLE'S ID, the moment it is known: a successor can then ask about it by signature.
  const sent = signature;
  tellTicket(ticket, (fenced) => fenced.signed(sent));

  const submittedAt = Date.now();
  const landed = await landing(connection, signature);
  const ended: SettleSend["ended"] = landed === null ? "unconfirmed" : landed.err === null ? "landed" : "reverted";
  tellSend(deps, {
    route,
    mode: inputs.mode,
    submitMs: submittedAt - sentAt,
    confirmMs: Date.now() - submittedAt,
    ended,
  });
  const result = await settledFromLanding(connection, link, sent, landed, {
    inputs,
    measured,
    expectation,
    paid,
    backlog,
    applied,
    passing,
    carried,
    refused,
    unconfirmed,
  });
  tellTicket(ticket, (fenced) => fenced.ended(ended, result.outcome));
  return result;
}

/** What a settle that was sent comes to: the landing poll's answer, then the receipt. Split out so the fence's ticket hears every way out. */
async function settledFromLanding(
  connection: Connection,
  link: ManagedLink,
  signature: string,
  landed: { readonly err: TransactionError | null } | null,
  context: {
    readonly inputs: Pick<AttestationInputs, "baseLamports" | "sessionEndSlot">;
    readonly measured: { readonly txCount: number };
    readonly expectation: string;
    readonly paid: bigint;
    readonly backlog: string;
    readonly applied: string;
    readonly passing: string;
    readonly carried: Omit<SettleResult, "outcome" | "detail">;
    readonly refused: (err: TransactionError, where: string, signature: string) => SettleResult;
    readonly unconfirmed: (error: unknown, where: string, raw: string, signature?: string) => Promise<SettleResult>;
    /** The instruction whose arithmetic `paid` is: settle_v2 unless a per-trade settle says otherwise. */
    readonly instruction?: "settle_v3";
  },
): Promise<SettleResult> {
  const { inputs, measured, expectation, paid, backlog, applied, passing, carried, refused, unconfirmed } = context;
  const instruction = context.instruction ?? "settle_v2";
  if (landed === null) {
    const waited = `${CONFIRM_TIMEOUT_MS / 1_000} s`;
    return unconfirmed(
      new Error(`no confirmed status within ${waited}`),
      `settle ${signature.slice(0, 12)}… was not confirmed within ${waited}`,
      "no confirmed status arrived",
      signature,
    );
  }
  if (landed.err !== null) return refused(landed.err, "the settle landed and reverted", signature);

  // PAST THIS LINE THE SETTLE HAS LANDED SUCCESSFULLY. The receipt read is only
  // to report HOW MUCH; a failure to read it must never turn a real settlement
  // into a FAILED — so it lives in its own try, outside the broadcast's.
  let settled: bigint | null = null;
  let blockTimeMs: number | undefined;
  let receiptErr: TransactionError | null = null;
  try {
    // THROUGH THE SHARED READER, so this receipt and the walk agree about which
    // transaction versions exist. Our own settle is a legacy message and would
    // have been readable either way — but the version contract belongs in one
    // place, or the next read added here quietly gets it wrong again.
    const read = () => readTransaction(connection, signature, "confirmed");
    // ONE RE-READ, AT NO RISK, AND IT WRAPS THAT SHARED READER RATHER THAN A
    // SECOND SPELLING OF THE SAME CALL. The pool can route this read to an
    // endpoint that has not caught up with the one that just confirmed, and a
    // receipt that never arrives used to cost this settlement its row in the
    // mirror. Both attempts go through readTransaction, so the retry cannot
    // drift away from the version contract the walk holds.
    //
    // readTransaction ALSO answers null for a version it cannot decode, so such
    // a receipt is read twice before it is given up on. That costs one extra
    // read a second apart on a settle that has already landed, and buys the
    // same null either way — the cheap half of this trade.
    let receipt = await read();
    if (receipt === null) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      receipt = await read();
    }
    // A second, independent read of success: the receipt's own meta.err. If it
    // is set, the tx did NOT settle, even though its status said it did.
    // The chain's own timestamp for this settlement, whatever the receipt says
    // about its amount: a reverted settle writes no row, so this is only ever
    // read for one that landed.
    if (receipt?.blockTime != null) blockTimeMs = receipt.blockTime * 1_000;
    if (receipt?.meta?.err != null) receiptErr = receipt.meta.err;
    else if (receipt?.meta) {
      // pre/postBalances are consensus data about exactly this tx — no racy
      // balance re-read. Under settle_v2 a successful settle CAN move zero (a
      // base that floors to nothing still advances the frontier), so a zero
      // here is a real answer, not a contradiction.
      const keys = receipt.transaction.message.getAccountKeys({
        accountKeysFromLookups: receipt.meta.loadedAddresses ?? undefined,
      });
      for (let i = 0; i < keys.length; i++) {
        if (keys.get(i)!.equals(link.vault)) {
          settled = BigInt(receipt.meta.postBalances[i]!) - BigInt(receipt.meta.preBalances[i]!);
          break;
        }
      }
    }
  } catch {
    // Unreadable receipt for an already-confirmed settle: settled stays null,
    // reported honestly below rather than as a failure.
    settled = null;
  }

  if (receiptErr !== null) return refused(receiptErr, "the settle's receipt shows it reverted", signature);
  return {
    outcome: "SETTLED",
    detail:
      settled === null
        ? `confirmed ${signature.slice(0, 12)}… (${expectation}) — the vault delta is on chain, its receipt not read in time${backlog}${applied}${passing}`
        : `settled ${settled} lamports from ${inputs.baseLamports} measured over ${measured.txCount} txs (${expectation})${backlog}${applied}${passing}` +
          // settle_v2's arithmetic is expectedContribution's, so any other
          // amount means one of the two is not what the other believes.
          (settled === paid ? "" : ` — WARNING: the vault moved ${settled} lamports, not the ${paid} ${instruction} computes for this base`),
    ...carried,
    ...(settled === null ? {} : { settledLamports: settled }),
    ...(blockTimeMs === undefined ? {} : { blockTimeMs }),
    signature,
    nonce: link.settlementNonce,
    endSlot: inputs.sessionEndSlot,
  };
}

/**
 * The settle_v3 instruction for a V3 attestation's inputs (ADR §5.4): the IDL's
 * own builder, over the accounts the link names, the vault's PerTradePolicy and,
 * for ROUND-UP, the Pyth SOL/USD account settle_v3 reads its floor from. FIXED
 * passes no oracle: Anchor encodes the absent optional account as the program id,
 * and settle_v3 refuses a FIXED window that names one (PriceNotAllowed).
 *
 * THE PRICES HASH TRAVELS AS FOUR u64 ARGUMENTS, word i its bytes 8i..8i+8 little
 * endian: the Privy policy's IDL subset takes primitive arguments only.
 */
export function settleV3Instruction(
  program: anchor.Program,
  link: Pick<ManagedLink, "wallet" | "vault" | "linkAddress">,
  inputs: AttestationV3Inputs,
  oracle: PublicKey | null,
): Promise<TransactionInstruction> {
  const words = pricesHashWords(inputs.pricesHash);
  return method(program, "settleV3")(
    inputs.mode,
    new BN(inputs.sessionStartSlot.toString()),
    new BN(inputs.sessionEndSlot.toString()),
    inputs.tradeCount,
    new BN(inputs.amountLamports.toString()),
    new BN(inputs.priceMinUsdE6.toString()),
    new BN(words[0].toString()),
    new BN(words[1].toString()),
    new BN(words[2].toString()),
    new BN(words[3].toString()),
    new BN(inputs.validUntilSlot.toString()),
  )
    .accountsPartial({
      wallet: link.wallet,
      vault: link.vault,
      tradingLink: link.linkAddress,
      perTradePolicy: perTradePolicyAddress(program.programId, link.vault),
      // ANCHOR'S "NONE" FOR AN OPTIONAL ACCOUNT IS THE PROGRAM'S OWN ID, written out.
      pythSolUsd: oracle ?? program.programId,
    })
    .instruction();
}

/**
 * A per-trade span the seam charged, from its attestation to its landing: the
 * same steps, in the same order, as a settle_v2 turn after its decision — the
 * confirmed slot, the instruction, the node's fee for exactly this message, the
 * reserve, the dry run's answer, the attester and signer, the shape, the seat,
 * the fence's gate, the send, the landing and the receipt — with settle_v3's own
 * numbers: what is owed is the charge's amount, and what moves is that amount
 * clipped by max_contribution and by the day's remaining cap (perTradePaid).
 *
 * TWO THINGS ONLY THIS PATH DOES. A ROUND-UP window's price is held against the
 * job's Pyth read before anything is priced or signed (oracleRefusal): a refusal
 * there is a RETRY, with nothing sent. And a live per-trade settle leaves ONLY
 * through the dispatcher's fence: no carry is ever written for one (neither mode
 * carries a loss), and a live turn without a fence is a caller bug, FAILED.
 */
async function settlePerTrade(
  deps: SettleDeps,
  vault: VaultState,
  turn: PerTradeTurn,
  span: {
    readonly from: bigint;
    readonly endSlot: bigint;
    readonly charge: PerTradeCharge;
    readonly measured: { readonly txCount: number; readonly tradedLamports: bigint; readonly volumeTrades?: readonly { readonly lamports: bigint }[] };
    readonly backlog: string;
  },
): Promise<SettleResult> {
  const { connection, program, link } = deps;
  const { charge, measured, backlog } = span;
  const modeName = keeperModeFor(vault.skimMode)?.name ?? `skim_mode ${vault.skimMode}`;
  const roundUp = charge.mode === MODE_ROUNDUP;

  const currentSlot = BigInt(await connection.getSlot("confirmed"));
  const inputs = attestationV3Inputs({ programId: program.programId, link, vault, from: span.from, endSlot: span.endSlot, charge, currentSlot });
  const { paid, headroom, savedToday } = perTradePaid({
    amountLamports: charge.amountLamports,
    maxContribution: vault.maxContribution,
    policy: turn.policy,
    nowSeconds: turn.nowSeconds(),
  });
  const clipped =
    paid >= charge.amountLamports
      ? ""
      : paid === headroom && headroom < vault.maxContribution
        ? `, clipped by the daily cap (${savedToday} of ${turn.policy.dailyCapLamports} saved today)`
        : `, clipped at max_contribution ${vault.maxContribution}`;
  const charged =
    `${charge.amountLamports} owed over ${charge.tradeCount} charged trade(s)` +
    (roundUp
      ? ` of ${charge.rows.length} counted, lowest price ${charge.priceMinUsdE6} µ$/SOL${charge.latePriced > 0 ? `, ${charge.latePriced} priced late` : ""}`
      : ` of ${charge.rows.length} counted, at ${charge.modeParam} lamports each`);
  const carried = {
    baseLamports: charge.amountLamports,
    mode: inputs.mode,
    expectedLamports: paid,
    tradedLamports: measured.tradedLamports,
    ...(measured.volumeTrades === undefined ? {} : { volumeLamports: measured.volumeTrades.reduce((sum, trade) => sum + trade.lamports, 0n) }),
    perTrade: charge,
  };

  // THE ORACLE, BEFORE ANYTHING IS PRICED OR SIGNED (ROUND-UP only).
  let oracle: PublicKey | null = null;
  if (roundUp) {
    if (turn.oracle === null) {
      return { outcome: "RETRY", detail: "a ROUND-UP settle needs the Pyth SOL/USD account settle_v3 reads its floor from, and this job read none; nothing was signed", ...carried };
    }
    const refusal = oracleRefusal(turn.oracle.update, charge.priceMinUsdE6, turn.nowSeconds());
    if (refusal !== null) return { outcome: "RETRY", detail: `${refusal}; nothing was signed`, ...carried };
    oracle = turn.oracle.address;
  }

  const settleIx = await settleV3Instruction(program, link, inputs, oracle);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  // THE RESERVE, priced for exactly this message, as a settle_v2's is.
  const priced = settleTransaction(
    { blockhash, lastValidBlockHeight },
    link.wallet,
    Ed25519Program.createInstructionWithPublicKey({
      publicKey: deps.attester?.publicKey.toBytes() ?? new Uint8Array(32),
      message: attestationV3Message(inputs),
      signature: new Uint8Array(64),
    }),
    settleIx,
  );
  const { value: fee } = await connection.getFeeForMessage(priced.compileMessage(), "confirmed");
  if (fee === null) {
    return { outcome: "RETRY", detail: "the node could not price this settle's fee, so the wallet's reserve could not be checked; nothing was signed", ...carried };
  }
  const feeLamports = BigInt(fee);
  const walletLamports = BigInt(await connection.getBalance(link.wallet, "confirmed"));
  const belowReserve = reserveDecision({ walletLamports, feeLamports, rentExemptZero: await rentExemptZero(connection), walletReserve: vault.walletReserve, paid });
  const withFee = { ...carried, feeLamports };
  if (belowReserve !== null) return { ...belowReserve, ...withFee };

  const gateRequest = (live: boolean): SettleGateRequest => ({
    link,
    mode: inputs.mode,
    blockhash,
    lastValidBlockHeight,
    idempotencyKey: settleIdempotencyKey(link, inputs.validUntilSlot),
    amountLamports: paid,
    endSlot: span.endSlot,
    carry: null,
    validUntilSlot: inputs.validUntilSlot,
    live,
  });

  if (!deps.live) {
    if (deps.fence !== undefined) {
      const gated = await deps.fence.gate(gateRequest(false));
      if (gated.kind !== "gated") return { outcome: "RETRY", detail: `DRY RUN — ${gated.detail}`, ...withFee };
    }
    return {
      outcome: "SETTLED",
      detail:
        paid === 0n && charge.tradeCount === 0
          ? `DRY RUN — would settle 0 lamports in ${modeName} through settle_v3 and advance the frontier ` +
            `from ${inputs.sessionStartSlot} to ${inputs.sessionEndSlot} over ${measured.txCount} txs${backlog}`
          : `DRY RUN — would settle ${paid} lamports in ${modeName} through settle_v3 (${charged}${clipped}) ` +
            `over slots ${inputs.sessionStartSlot}..${inputs.sessionEndSlot}${backlog}`,
      ...withFee,
    };
  }

  const attester = deps.attester;
  const walletSigner = deps.walletSigner;
  if (attester === null || walletSigner === null) {
    return { outcome: "FAILED", detail: "a live settle turn arrived without the settle key or a wallet signer; nothing was sent", ...withFee };
  }
  if (deps.fence === undefined) {
    return { outcome: "FAILED", detail: "a live per-trade settle leaves only through the dispatcher's fence, and this turn has none; nothing was sent", ...withFee };
  }

  const expectation = `${paid} expected through settle_v3 (${charged}${clipped})`;
  const refused = (err: TransactionError, where: string, signature: string): SettleResult => {
    const refusal = classifySettleRefusal(err, idl);
    return { outcome: refusal.outcome, detail: refusalDetail(where, refusal, JSON.stringify(err), "settle_v3"), ...withFee, signature };
  };
  // A SETTLE THAT LANDED IS NEVER FAILED: the nonce is read back, as for settle_v2.
  const unconfirmed = async (error: unknown, where: string, raw: string, signature?: string): Promise<SettleResult> => {
    const refusal = classifySettleRefusal(error, idl);
    const withSignature = signature === undefined ? {} : { signature };
    if (refusal.outcome === "RETRY" || refusal.outcome === "FAILED") {
      const nonce = await readSettlementNonce(program, link.linkAddress).catch(() => null);
      if (nonce === link.settlementNonce + 1n) {
        return {
          outcome: "SETTLED",
          detail: `landed; receipt not read — ${where}, and this link's nonce has moved to ${nonce} (${expectation})${backlog}`,
          ...withFee,
          ...withSignature,
          nonce: link.settlementNonce,
          endSlot: inputs.sessionEndSlot,
        };
      }
    }
    return { outcome: refusal.outcome, detail: refusalDetail(where, refusal, raw, "settle_v3"), ...withFee, ...withSignature };
  };

  const tx = settleTransaction({ blockhash, lastValidBlockHeight }, link.wallet, attestationV3Instruction(attester.secretKey, inputs), settleIx);
  try {
    assertSettleShape(tx, program.programId, link.wallet);
  } catch (error) {
    return { outcome: "FAILED", detail: error instanceof Error ? error.message : String(error), ...withFee };
  }
  if (!(walletSigner instanceof Keypair) && walletSigner.confirmSeat !== undefined) {
    try {
      await walletSigner.confirmSeat();
    } catch (error) {
      if (!(error instanceof SeatWithdrawnError)) throw error;
      return { outcome: "NO_SIGNER", detail: `${noSignerDetail(link.wallet)}. ${error.message}`, ...withFee };
    }
  }
  const gated = await deps.fence.gate(gateRequest(true));
  if (gated.kind !== "gated") return { outcome: "RETRY", detail: gated.detail, ...withFee };
  const ticket = gated.ticket;

  const route: SettleSend["route"] = walletSigner instanceof Keypair ? "local-keypair" : "privy";
  const sentAt = Date.now();
  let signature: string;
  try {
    signature = await sendSettle(connection, walletSigner, tx, settleIdempotencyKey(link, inputs.validUntilSlot));
  } catch (error) {
    tellSend(deps, { route, mode: inputs.mode, submitMs: Date.now() - sentAt, confirmMs: null, ended: "threw" });
    const threw = await unconfirmed(error, "sending the settle threw", summarizeUpstreamError(error, { take: 3, maxChars: 500 }));
    tellTicket(ticket, (fenced) => fenced.ended("threw", threw.outcome));
    return threw;
  }
  const sent = signature;
  tellTicket(ticket, (fenced) => fenced.signed(sent));
  const submittedAt = Date.now();
  const landed = await landing(connection, signature);
  const ended: SettleSend["ended"] = landed === null ? "unconfirmed" : landed.err === null ? "landed" : "reverted";
  tellSend(deps, { route, mode: inputs.mode, submitMs: submittedAt - sentAt, confirmMs: Date.now() - submittedAt, ended });
  const result = await settledFromLanding(connection, link, sent, landed, {
    inputs: { baseLamports: inputs.amountLamports, sessionEndSlot: inputs.sessionEndSlot },
    measured,
    expectation,
    paid,
    backlog,
    applied: "",
    passing: "",
    carried: withFee,
    refused,
    unconfirmed,
    instruction: "settle_v3",
  });
  tellTicket(ticket, (fenced) => fenced.ended(ended, result.outcome));
  return result;
}

/**
 * THE ONE PLACE A SETTLE LEAVES, settle_v2's and settle_v3's alike, on either
 * route (test/send-sites.test.ts counts it).
 *
 * Localnet: a local keypair signs, we broadcast. The product path: Privy signs as
 * the wallet AND broadcasts, so the policy is in force on the way out — one
 * request, under this attempt's own key.
 */
async function sendSettle(connection: Connection, walletSigner: SolanaWalletSubmitter | Keypair, tx: Transaction, idempotencyKey: string): Promise<string> {
  if (walletSigner instanceof Keypair) {
    tx.partialSign(walletSigner);
    return connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
  }
  return walletSigner.submit(tx, { idempotencyKey });
}
