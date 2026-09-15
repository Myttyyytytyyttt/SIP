// One settlement turn for one linked wallet.
//
// Ported from Nuvem's solana-lab keeper (keeper/src/settle-tick.ts), moved to
// settle_v2. What is new: the vault is read through the IDL on every turn, a
// paused vault or protocol stops at PAUSED, a VOLUME vault stops at
// UNSUPPORTED_MODE, the attestation binds the mode, the vault's own rate and
// policy nonce and a deadline, and a dry run measures and reports without any
// key in reach. What is unchanged: the frontier-from-epoch
// rule, the order of the completeness checks, confirm plus the receipt's own
// meta.err, and the vault delta read from pre/post balances.
//
// The decisions live in settle-decision.ts, where a test can reach them.

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { summarizeUpstreamError } from "@sip/solana-log";
import { readVault } from "./accounts.js";
import type { ManagedLink } from "./discovery.js";
import { measureSince } from "./measure-window.js";
import { method } from "./methods.js";
import type { SolanaWalletSubmitter } from "./privy-signer.js";
import { attestationInstruction } from "./program-scripts.js";
import {
  attestationInputs,
  decideFromMeasurement,
  expectedContribution,
  measurementStart,
  modeDecision,
  noSignerDetail,
  pauseDecision,
  type SettleOutcome,
} from "./settle-decision.js";

export type { SettleOutcome } from "./settle-decision.js";

export interface SettleResult {
  readonly outcome: SettleOutcome;
  readonly detail: string;
  /** The attested base. In PROFIT mode, the measured profit. */
  readonly baseLamports?: bigint;
  /** The mode `baseLamports` was measured in. */
  readonly mode?: number;
  readonly settledLamports?: bigint;
  readonly signature?: string;
  /** The nonce this settlement consumed, and the slot it closed. Carried out
   * so the keeper can record history without re-deriving either. */
  readonly nonce?: bigint;
  readonly endSlot?: bigint;
}

export interface SettleDeps {
  readonly connection: Connection;
  readonly program: anchor.Program;
  readonly link: ManagedLink;
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
}

export async function runSettleTick(deps: SettleDeps): Promise<SettleResult> {
  const { connection, program, link } = deps;

  // THE VAULT IS READ EVERY TURN. Its mode, its rate and its policy nonce are
  // what settle_v2 rebuilds into the message it verifies, so an attestation
  // built from a remembered copy is refused the moment the owner writes a new
  // policy.
  const vault = await readVault(program, link.vault);
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
  const measured = await measureSince(connection, link.wallet, from, program.programId);
  const decision = decideFromMeasurement(measured, from);
  if (decision.kind === "stop") {
    return {
      outcome: decision.outcome,
      detail: decision.detail,
      ...(decision.baseLamports === undefined ? {} : { baseLamports: decision.baseLamports }),
    };
  }

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

  if (!deps.live) {
    const { owed, paid } = expectedContribution(inputs.baseLamports, inputs.bps, vault.maxContribution);
    return {
      outcome: "SETTLED",
      detail:
        `DRY RUN — would settle ${paid} lamports (${owed} owed at ${inputs.bps} bps` +
        (paid < owed ? `, clipped at max_contribution ${vault.maxContribution}` : "") +
        `) from ${inputs.baseLamports} lamports of measured profit over slots ${inputs.sessionStartSlot}..${inputs.sessionEndSlot}`,
      baseLamports: inputs.baseLamports,
      mode: inputs.mode,
    };
  }

  const attester = deps.attester;
  const walletSigner = deps.walletSigner;
  if (attester === null || walletSigner === null) {
    // Unreachable from the keeper, which builds live deps only from an armed
    // config. Refused here too, because the alternative is an unattested send.
    return { outcome: "FAILED", detail: "a live settle turn arrived without the settle key or a wallet signer; nothing was sent" };
  }

  // Declared out here: the receipt block below runs OUTSIDE the broadcast try
  // and needs the signature the broadcast produced.
  let signature: string;
  try {
    const settleIx = await method(program, "settleV2")(
      inputs.mode,
      new anchor.BN(inputs.sessionStartSlot.toString()),
      new anchor.BN(inputs.sessionEndSlot.toString()),
      new anchor.BN(inputs.baseLamports.toString()),
      new anchor.BN(inputs.validUntilSlot.toString()),
    )
      .accountsPartial({ wallet: link.wallet, vault: link.vault, tradingLink: link.linkAddress })
      .instruction();

    // THE ORDER IS LOAD-BEARING: settle_v2 proves, through the instructions
    // sysvar, that the instruction IMMEDIATELY BEFORE it is the attester's
    // Ed25519 verification of exactly this message. The transaction is signed
    // BY the wallet, which pays.
    const tx = new Transaction().add(attestationInstruction(attester.secretKey, inputs)).add(settleIx);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = link.wallet;

    if (walletSigner instanceof Keypair) {
      // Localnet: a local keypair signs, we broadcast.
      tx.partialSign(walletSigner);
      signature = await connection.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" });
    } else {
      // The product path: Privy signs as the wallet AND broadcasts, so the
      // policy's program allowlist is in force on the way out.
      signature = await walletSigner.submit(tx);
    }
    const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
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
    return { outcome: "FAILED", detail: summarizeUpstreamError(error, { take: 3, maxChars: 500 }) };
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

  if (receiptErr !== null) {
    return { outcome: "FAILED", detail: `settle reverted on chain: ${JSON.stringify(receiptErr)}`, signature };
  }
  return {
    outcome: "SETTLED",
    detail:
      settled === null
        ? `confirmed ${signature.slice(0, 12)}… — the vault delta is on chain, its receipt not read in time`
        : `settled ${settled} lamports from ${inputs.baseLamports} measured over ${measured.txCount} txs`,
    baseLamports: inputs.baseLamports,
    mode: inputs.mode,
    ...(settled === null ? {} : { settledLamports: settled }),
    signature,
    nonce: link.settlementNonce,
    endSlot: inputs.sessionEndSlot,
  };
}
