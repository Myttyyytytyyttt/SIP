// One settlement turn for one linked wallet.
//
// Ported from Nuvem's solana-lab keeper (keeper/src/settle-tick.ts), moved to
// settle_v2. What is new: the vault arrives decoded through the IDL from the
// sweep's one batched read, a paused vault or protocol stops at PAUSED, an
// undefined mode stops at UNSUPPORTED_MODE while both real modes are measured, a
// confirmed probe decides whether there is anything to walk, the walk reads
// finalized history and must reach the frontier, a flat span settles a zero base
// once it is worth a transaction, the attestation binds the vault's own mode,
// rate and policy nonce and a deadline, and a dry run measures and reports
// without any key in reach.
// What is unchanged: the frontier-from-epoch rule, the completeness checks
// behind the new frontier and finality stops, confirm plus the receipt's own
// meta.err, and the vault delta read from pre/post balances.
//
// The decisions live in settle-decision.ts, where a test can reach them.

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { summarizeUpstreamError } from "@sip/solana-log";
import type { VaultState } from "./accounts.js";
import type { ManagedLink } from "./discovery.js";
import { connectionReader, measureSince } from "./measure-window.js";
import { method } from "./methods.js";
import type { SolanaWalletSubmitter } from "./privy-signer.js";
import { MODE_VOLUME, attestationInstruction } from "./program-scripts.js";
import {
  attestationInputs,
  decideFromMeasurement,
  defaultVolumeBase,
  expectedContribution,
  measurementStart,
  modeDecision,
  noSignerDetail,
  pauseDecision,
  type SettleOutcome,
  type VolumeBase,
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
  const decision = await decideFromMeasurement(measured, {
    from,
    finalizedSlot,
    mode: vault.skimMode,
    volumeBase: deps.volumeBase ?? defaultVolumeBase,
  });
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
    const modeName = inputs.mode === MODE_VOLUME ? "VOLUME" : "PROFIT";
    return {
      outcome: "SETTLED",
      detail:
        // A ZERO BASE SAYS WHAT IT IS FOR: nothing moves, and the frontier does.
        inputs.baseLamports === 0n
          ? `DRY RUN — would settle 0 lamports in ${modeName} at ${inputs.bps} bps and advance the frontier ` +
            `from ${inputs.sessionStartSlot} to ${inputs.sessionEndSlot} over ${measured.txCount} txs`
          : `DRY RUN — would settle ${paid} lamports (${owed} owed at ${inputs.bps} bps` +
            (paid < owed ? `, clipped at max_contribution ${vault.maxContribution}` : "") +
            `) from ${inputs.baseLamports} lamports of measured ${inputs.mode === MODE_VOLUME ? "notional" : "profit"} ` +
            `over slots ${inputs.sessionStartSlot}..${inputs.sessionEndSlot}`,
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
