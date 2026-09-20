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
import { readSettlementNonce, type VaultState } from "./accounts.js";
import { BN } from "./anchor-interop.js";
import type { ManagedLink } from "./discovery.js";
import { idl } from "./idl.js";
import { connectionReader, measureSince } from "./measure-window.js";
import { method } from "./methods.js";
import { assertSettleShape, type SolanaWalletSubmitter } from "./privy-signer.js";
import { MODE_PROFIT, MODE_VOLUME, attestationInstruction, attestationMessage, type AttestationInputs } from "./program-scripts.js";
import {
  attestationInputs,
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
  type SettleOutcome,
  type VolumeBase,
} from "./settle-decision.js";
import { classifySettleRefusal, type SettleRefusal } from "./settle-refusal.js";

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

/** A refusal's detail: where it happened, what said no, and what happens next. */
function refusalDetail(where: string, refusal: SettleRefusal, raw: string): string {
  switch (refusal.outcome) {
    case "PAUSED":
      return (
        `${where}: settle_v2 refused it with ${refusal.programError} — a pause switch went on after this sweep read the vault; ` +
        "nothing moved and the frontier stays put"
      );
    case "BELOW_RESERVE":
      return (
        `${where}: settle_v2 refused it with ${refusal.programError} — the wallet dropped below its reserve after its balance was read; ` +
        "nothing moved and the frontier stays put until it is funded"
      );
    case "RETRY":
      return (
        `${where}: ${refusal.programError === null ? raw : `settle_v2 refused it with ${refusal.programError}`} — ` +
        "the next sweep reads the vault and the link again and measures anew"
      );
    case "FAILED":
      return `${where}: ${refusal.programError === null ? raw : `settle_v2 refused it with ${refusal.programError} (${raw})`}`;
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
  const unsupported = modeDecision(vault);
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
  // BEFORE THE WALK, NOT AFTER: see MeasurementContext.finalizedSlot.
  const finalizedSlot = BigInt(await connection.getSlot("finalized"));
  const measured = await measureSince(connectionReader(connection), link.wallet, from, program.programId);
  // THE CARRY FOR THIS LINK'S EXACT STATE, read after the walk and before the base.
  // Only a zero settle that landed leaves a link in the state a carry was recorded
  // for, so a loss is netted once, by the window right above that settle.
  const carry = carryFor(deps.carries, link);
  const decision = await decideFromMeasurement(measured, {
    from,
    finalizedSlot,
    mode: vault.skimMode,
    volumeBase: deps.volumeBase ?? defaultVolumeBase,
    carry,
  });
  if (decision.kind === "stop") {
    return {
      outcome: decision.outcome,
      detail: decision.detail,
      ...(decision.baseLamports === undefined ? {} : { baseLamports: decision.baseLamports }),
    };
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
    ...(decision.carry === undefined ? {} : { carry: decision.carry }),
  };
  if (belowReserve !== null) return { ...belowReserve, ...carried };

  if (!deps.live) {
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

  // ONLY THE SETTLE LEAVES, ON EITHER ROUTE. The Privy policy bounds the signer
  // by program and never sees instruction data (privy-policy.ts), so the shape is
  // held here, before a keypair signs or Privy is asked, and the local proof
  // sends through the same check the product path does. A transaction that fails
  // it is a bug in this file: nothing is sent, and a human should look.
  try {
    assertSettleShape(tx, program.programId, link.wallet);
  } catch (error) {
    return { outcome: "FAILED", detail: error instanceof Error ? error.message : String(error), ...carried };
  }

  // THE CARRY IS RECORDED BEFORE THE SEND, NEVER AFTER IT. A send can throw, or go
  // unconfirmed, on a settle that landed, and the next sweep then reads the link in
  // the state this settle leaves: a carry recorded only once the send answered
  // would be missing there, and the loss forgotten. A settle that never lands leaves
  // the link where it is, whose own entry recordCarry keeps. A NULL IS RECORDED TOO:
  // an earlier attempt from this state may have left a carry under the state this
  // settle leaves, for another window, and it must not net against this one. A dry
  // run and BELOW_RESERVE returned above, so neither records anything.
  recordCarry(deps.carries, link, decision.endSlot, decision.carry ?? null);

  let signature: string;
  try {
    if (walletSigner instanceof Keypair) {
      // Localnet: a local keypair signs, we broadcast.
      tx.partialSign(walletSigner);
      signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    } else {
      // The product path: Privy signs as the wallet AND broadcasts, so the
      // policy's program allowlist is in force on the way out. One request,
      // under this attempt's own key.
      signature = await walletSigner.submit(tx, { idempotencyKey: settleIdempotencyKey(link, inputs.validUntilSlot) });
    }
  } catch (error) {
    return unconfirmed(error, "sending the settle threw", summarizeUpstreamError(error, { take: 3, maxChars: 500 }));
  }

  const landed = await landing(connection, signature);
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
  let receiptErr: TransactionError | null = null;
  try {
    const read = async () =>
      connection.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
    // ONE RE-READ, AT NO RISK. The pool can route this read to an endpoint that
    // has not caught up with the one that just confirmed, and a receipt that
    // never arrives used to cost this settlement its row in the mirror.
    let receipt = await read();
    if (receipt === null) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      receipt = await read();
    }
    // A second, independent read of success: the receipt's own meta.err. If it
    // is set, the tx did NOT settle, even though its status said it did.
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
          (settled === paid ? "" : ` — WARNING: the vault moved ${settled} lamports, not the ${paid} settle_v2 computes for this base`),
    ...carried,
    ...(settled === null ? {} : { settledLamports: settled }),
    signature,
    nonce: link.settlementNonce,
    endSlot: inputs.sessionEndSlot,
  };
}
