// One settlement turn for one linked wallet.
//
// THE FRONTIER IS THE WHOLE DIFFERENCE FROM THE DRILL. The drill measured a
// wallet's entire recent history because that history was one simulated
// session. A real tester trading on Axiom accumulates sessions, and settling
// the same profit twice is the one failure here that costs money. So this
// measures ONLY what happened after `frontierSlot` — the link's own watermark,
// advanced by the program on every settle. Profit already settled is invisible
// to the next tick by construction, not by bookkeeping.
//
// IT REFUSES RATHER THAN GUESSES. A broken balance chain means a transaction
// was missed, so the measurement is incomplete and no attestation is signed —
// the EVM keeper's quiet.ts stance, ported: an unproven number never moves
// money.

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { attestationInstruction } from "../../scripts/attestation";
import type { SolanaWalletSubmitter } from "./privy-signer";
import { measureSince } from "./measure-window";
import type { ManagedLink } from "./discovery";

export type SettleOutcome =
  /** Nothing new since the frontier. The resting state of a linked wallet. */
  | "IDLE"
  /** New profit measured, attested and settled. */
  | "SETTLED"
  /**
   * Measured a loss or zero, so nothing is taken.
   *
   * THE FRONTIER DOES NOT ADVANCE. settle.rs is the only writer of
   * frontier_slot and it requires profit_lamports > 0, so a flat or losing span
   * stays inside the window and the window keeps growing. A wallet that loses
   * for long enough eventually exceeds the walk limit and flips to INCOMPLETE,
   * which never resolves. Closing that properly needs an on-chain instruction
   * that advances the watermark without settling; until then the keeper watches
   * the span and says when it is getting dangerous, rather than claiming an
   * advance that does not happen.
   */
  | "NO_PROFIT"
  /** The completeness oracle broke — a human should look. */
  | "INCOMPLETE"
  /**
   * The wallet exists but never granted the keeper's signer. A RESTING state,
   * not a failure: it repeats every sweep until the user re-runs step 3, so
   * the supervisor dedupes it rather than logging a settle FAILED each minute.
   */
  | "NO_SIGNER"
  | "FAILED";

export interface SettleResult {
  readonly outcome: SettleOutcome;
  readonly detail: string;
  readonly profitLamports?: bigint;
  readonly settledLamports?: bigint;
  readonly signature?: string;
  /** The nonce this settlement consumed, and the slot it closed. Carried out
   * so the supervisor can record history without re-deriving either. */
  readonly nonce?: bigint;
  readonly endSlot?: bigint;
}

export interface SettleDeps {
  readonly connection: Connection;
  readonly program: anchor.Program;
  readonly link: ManagedLink;
  /** Signs attestations. The keeper's trust anchor. */
  readonly attester: Keypair;
  /**
   * Signs the settle transaction AS THE TRADING WALLET. Either a Privy signer
   * (production: no key on this box) or a local keypair (the drill). Null when
   * the keeper has neither — then the turn reports and skips, because settle()
   * requires the wallet's own signature by design.
   */
  readonly walletSigner: SolanaWalletSubmitter | Keypair | null;
  readonly live: boolean;
}

export async function runSettleTick(deps: SettleDeps): Promise<SettleResult> {
  const { connection, program, link } = deps;

  if (deps.walletSigner === null) {
    return {
      outcome: "NO_SIGNER",
      detail:
        `no signer for trading wallet ${link.wallet.toBase58()} — settle() is pushed BY the wallet, ` +
        "so the keeper needs its Privy session signer or a local key (re-run onboarding step 3)",
    };
  }

  // Measure ONLY the unsettled span.
  //
  // A NEVER-SETTLED LINK STARTS AT ITS OWN CREATION, not at slot zero. The
  // program writes frontier_slot 0 at link time and `epoch` = the creation
  // slot, so zero here means "nothing settled yet", not "measure everything".
  // Reading it literally walked the wallet's entire pre-link history: it
  // truncated at the walk limit (INCOMPLETE forever, a deadlock) and would have
  // skimmed profit the user earned before they ever joined.
  const from = link.frontierSlot === 0n ? link.epoch : link.frontierSlot;
  const measured = await measureSince(connection, link.wallet, from, program.programId);
  // ORDER MATTERS. This used to run first, so a span where the RPC returned
  // null for EVERY transaction — exactly what heavy throttling looks like —
  // reported "nothing since slot N" and went quiet, defeating the unfetchable
  // check below entirely. An empty walk is only empty if we could actually see.
  if (measured.unfetchable > 0) {
    return {
      outcome: "INCOMPLETE",
      detail:
        `${measured.unfetchable} transaction(s) in this span could not be read from the RPC — ` +
        "the measurement is incomplete because of OUR node, not the wallet. Nothing is attested; " +
        "the next sweep retries the same span",
    };
  }
  if (measured.txCount === 0) {
    return { outcome: "IDLE", detail: `nothing since slot ${from}` };
  }
  if (measured.truncated) {
    return {
      outcome: "INCOMPLETE",
      detail:
        `the unsettled span exceeds the ${measured.txCount}-tx walk limit — measured only part of it, ` +
        "so nothing is attested (the frontier will catch up as earlier spans settle)",
    };
  }
  if (measured.chainBreaks > 0) {
    return {
      outcome: "INCOMPLETE",
      detail:
        `${measured.chainBreaks} balance-chain break(s) over ${measured.txCount} transactions — ` +
        "a transaction was missed, so the measurement is incomplete and nothing will be attested",
    };
  }
  if (measured.profitLamports <= 0n) {
    return {
      outcome: "NO_PROFIT",
      detail:
        `measured ${measured.profitLamports} lamports over ${measured.txCount} txs — a losing or flat span` +
        // The frontier cannot move without a settle, so this span will be
        // re-walked in full every sweep and will keep growing.
        (measured.txCount > 200
          ? ` — WARNING: this unsettled span is ${measured.txCount} transactions and the walk stops at 300; ` +
            "past that the wallet reports INCOMPLETE and stops being measurable"
          : ""),
      profitLamports: measured.profitLamports,
    };
  }

  const endSlot = measured.lastSlot;
  if (endSlot <= from) {
    return { outcome: "IDLE", detail: "no slot beyond the frontier yet" };
  }

  const inputs = {
    programId: program.programId,
    wallet: link.wallet,
    vault: link.vault,
    linkEpoch: link.epoch,
    settlementNonce: link.settlementNonce,
    // The window it ACTUALLY measured, which is what the attestation must
    // bind. The program requires session_start_slot >= frontier_slot, and the
    // link's epoch satisfies that for a never-settled link (frontier 0) while
    // describing the real span. Attesting 0 here would sign a window the keeper
    // did not measure.
    sessionStartSlot: from,
    sessionEndSlot: endSlot,
    profitLamports: measured.profitLamports,
  };

  if (!deps.live) {
    return {
      outcome: "SETTLED",
      detail: `DRY RUN — would settle from ${measured.profitLamports} lamports of measured profit`,
      profitLamports: measured.profitLamports,
    };
  }

  // Declared out here: the receipt block below runs OUTSIDE the broadcast try
  // and needs the signature the broadcast produced.
  let signature: string;
  try {
    // Build the settle instruction; the transaction carries the attester's
    // Ed25519 verification first, then settle, and is signed BY the wallet.
    const settleIx = await program.methods
      .settle(
        new anchor.BN(inputs.sessionStartSlot.toString()),
        new anchor.BN(inputs.sessionEndSlot.toString()),
        new anchor.BN(inputs.profitLamports.toString()),
      )
      .accountsPartial({ wallet: link.wallet, vault: link.vault, tradingLink: link.linkAddress })
      .instruction();

    const tx = new Transaction()
      .add(attestationInstruction(deps.attester.secretKey, inputs))
      .add(settleIx);
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = link.wallet;

    if (deps.walletSigner instanceof Keypair) {
      // The drill path: a local keypair signs, we broadcast.
      tx.partialSign(deps.walletSigner);
      signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    } else {
      // The product path: Privy signs as the wallet AND broadcasts, so the
      // policy's program allowlist is in force on the way out.
      signature = await deps.walletSigner.submit(tx);
    }
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight: (await connection.getBlockHeight()) + 150 },
      "confirmed",
    );
    // confirmTransaction RESOLVES on an on-chain revert (web3.js only rejects
    // on the fallback path), so a settle that landed-and-reverted would sail
    // past here. A confirmed error is a FAILED settle, not a settlement of
    // zero — the frontier did not move and the next sweep retries.
    if (confirmation.value.err !== null) {
      return {
        outcome: "FAILED",
        detail: `settle confirmed WITH an on-chain error: ${JSON.stringify(confirmation.value.err)}`,
        signature,
      };
    }
  } catch (error) {
    return { outcome: "FAILED", detail: error instanceof Error ? error.message : String(error), signature: undefined };
  }

  // PAST THIS LINE THE SETTLE HAS LANDED SUCCESSFULLY. The receipt read is only
  // to report HOW MUCH; a failure to read it must never turn a real settlement
  // into a FAILED — so it lives in its own try, outside the broadcast's.
  let settled: bigint | null = null;
  let receiptErr: unknown = null;
  try {
    const receipt = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    // A second, independent read of success: the receipt's own meta.err. If it
    // is set, the tx did NOT settle — report FAILED even though confirm passed.
    if (receipt?.meta?.err != null) receiptErr = receipt.meta.err;
    else if (receipt?.meta) {
      // pre/postBalances are consensus data about exactly this tx — no racy
      // balance re-read. A successful settle always moves >0 into the vault
      // (the program requires contribution > 0), so a 0 here would itself be a
      // contradiction, caught by the meta.err check above.
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

  if (receiptErr !== null) {
    return { outcome: "FAILED", detail: `settle reverted on chain: ${JSON.stringify(receiptErr)}`, signature };
  }
  return {
    outcome: "SETTLED",
    detail:
      settled === null
        ? `confirmed ${signature.slice(0, 12)}… — the vault delta is on chain, its receipt not read in time`
        : `settled ${settled} lamports from ${measured.profitLamports} measured over ${measured.txCount} txs`,
    profitLamports: measured.profitLamports,
    ...(settled === null ? {} : { settledLamports: settled }),
    signature,
    nonce: link.settlementNonce,
    endSlot,
  };
}
