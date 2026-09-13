// Who this keeper is, according to the chain — and whether that lets it act.
//
// NEW IN SIP, and the reason a dry run needs no key. Nuvem's supervisor learned
// the attester and the crank by LOADING THEIR SECRET KEYS at startup, in dry run
// too, and exited when they were absent; /status then served pubkeys derived
// from those secrets. Here the identities come from the one place that decides
// whether an attestation verifies and whether a crank is allowed: the
// ProtocolConfig PDA (authority, attester, keeper, paused). A dry run reads it,
// shows it, and holds nothing; an armed keeper compares its settle key against
// it before it is allowed to act.

import type * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { summarizeUpstreamError } from "@sip/worker/log";
import { readProtocolConfig, type ProtocolConfigState } from "./accounts.js";
import { KEEPER_LOCK_NAME } from "./singleton.js";

export interface ChainSnapshot {
  readonly at: string;
  /** `executable` of the program account. Null when the RPC could not say. */
  readonly programDeployed: boolean | null;
  /** The decoded config, or null when the PDA does not exist. Meaningful only when `configReadable`. */
  readonly config: ProtocolConfigState | null;
  readonly configReadable: boolean;
  /** The balance of `config.keeper` — the crank the chain authorizes — when one is named. */
  readonly crankLamports: bigint | null;
  /** Summarized upstream failures; never a URL. */
  readonly errors: readonly string[];
}

/** One read of the chain's view of this deployment. Never throws: an unreadable part is recorded as such. */
export async function readChainSnapshot(connection: Connection, program: anchor.Program): Promise<ChainSnapshot> {
  const errors: string[] = [];

  let programDeployed: boolean | null = null;
  try {
    programDeployed = (await connection.getAccountInfo(program.programId, "confirmed"))?.executable === true;
  } catch (error) {
    errors.push(`program account unreadable: ${summarizeUpstreamError(error)}`);
  }

  let config: ProtocolConfigState | null = null;
  let configReadable = false;
  try {
    config = await readProtocolConfig(program);
    configReadable = true;
  } catch (error) {
    errors.push(`ProtocolConfig unreadable: ${summarizeUpstreamError(error)}`);
  }

  let crankLamports: bigint | null = null;
  if (config !== null && !config.keeper.equals(PublicKey.default)) {
    try {
      crankLamports = BigInt(await connection.getBalance(config.keeper, "confirmed"));
    } catch (error) {
      errors.push(`crank balance unreadable: ${summarizeUpstreamError(error)}`);
    }
  }

  return { at: new Date().toISOString(), programDeployed, config, configReadable, crankLamports, errors };
}

export type LiveVerification =
  | { readonly kind: "verified" }
  /** Readable and wrong: an armed keeper refuses to start (exit 2). */
  | { readonly kind: "mismatch"; readonly detail: string }
  /** Readable and absent: stay dry, re-verify every sweep. */
  | { readonly kind: "no-config"; readonly detail: string }
  /** RPC trouble: stay dry, re-verify every sweep. */
  | { readonly kind: "unreadable"; readonly detail: string };

/**
 * Whether the settle key IS the deployment's attester AND its keeper.
 *
 * BOTH, because during the hackathon one settle wallet plays both parts: an
 * attester mismatch means every attestation is refused with WrongAttester, and a
 * keeper mismatch means every wrap and convert is refused by may_crank. Acting
 * with either wrong is a keeper that burns fees failing.
 */
export function verifySettleKey(settleKey: PublicKey, snapshot: Pick<ChainSnapshot, "config" | "configReadable">): LiveVerification {
  if (!snapshot.configReadable) {
    return {
      kind: "unreadable",
      detail: "the on-chain ProtocolConfig could not be read (RPC trouble); staying dry and re-verifying every sweep",
    };
  }
  if (snapshot.config === null) {
    return {
      kind: "no-config",
      detail:
        "the on-chain ProtocolConfig does not exist (program not deployed, or init_config not run); " +
        "staying dry and re-verifying every sweep",
    };
  }
  const { attester, keeper } = snapshot.config;
  if (attester.equals(settleKey) && keeper.equals(settleKey)) return { kind: "verified" };
  const wrong = [attester.equals(settleKey) ? null : "attester", keeper.equals(settleKey) ? null : "keeper"].filter(
    (part): part is string => part !== null,
  );
  return {
    kind: "mismatch",
    detail:
      `the on-chain ProtocolConfig names attester ${attester.toBase58()} and keeper ${keeper.toBase58()}, but ` +
      `SIP_SOLANA_SETTLE_KEY is ${settleKey.toBase58()} (wrong: ${wrong.join(" and ")}). The settle wallet must be ` +
      "both: run set_attester and set_keeper for it, or deploy the key the config names.",
  };
}

/**
 * The first condition standing between this keeper and acting, or null when it
 * may act. isLive() is exactly `missingLiveCondition(...) === null`, and /status
 * serves the string, so "why is it dry?" always has an answer.
 */
export function missingLiveCondition(input: {
  readonly armed: boolean;
  readonly verification: LiveVerification | null;
  readonly claimLive: boolean;
}): string | null {
  if (!input.armed) {
    return "not armed: SIP_SOLANA_BROADCAST=1 and the exact SIP_SOLANA_ALLOW_BROADCAST sentence are both required";
  }
  if (input.verification === null) return "the settle key has not been checked against the on-chain ProtocolConfig yet";
  if (input.verification.kind !== "verified") return input.verification.detail;
  if (!input.claimLive) return `another keeper holds the ${KEEPER_LOCK_NAME} claim; retrying every sweep`;
  return null;
}

export interface TurnKeys<K, S> {
  readonly live: boolean;
  readonly settleKey: K | null;
  readonly walletSigner: S | null;
}

/**
 * The keys one tick may hold, decided at the moment that tick starts.
 *
 * ASKED PER TURN, NEVER ONCE PER SWEEP. The single-keeper claim can be lost in
 * the middle of a sweep: its database session drops and a callback releases
 * it. A live flag read at the top of the sweep would let every remaining wallet
 * in that sweep sign, settle, wrap and invest while another instance takes the
 * claim over, which is the double purchase the lock exists to prevent. Nuvem's
 * supervisor asked isLive() at each tick call; this is now the only way a tick
 * gets a key.
 */
export function keysForTurn<K, S>(
  isLive: () => boolean,
  keys: { readonly settleKey: K | null; readonly walletSigner: S | null },
): TurnKeys<K, S> {
  if (!isLive()) return { live: false, settleKey: null, walletSigner: null };
  return { live: true, settleKey: keys.settleKey, walletSigner: keys.walletSigner };
}
