// Whether the keeper's seat check is checking anything at all.
//
// A SEAT is this keeper's one authorization key registered as a signer on a
// trading wallet; the policy attached to that seat as its override is the only
// thing narrowing what the key may do with the wallet. Two public ids decide how
// much of that is examined before the keeper signs, and BOTH are optional
// (src/config.ts), because the live keeper's healthcheck must not depend on a
// variable nobody has set yet. So the combinations exist, and they do not all
// mean the same thing:
//
//   * BOTH SET — the seat must carry exactly the keeper's policy or nothing is
//     signed for that wallet (createPrivySolanaSigner, SEAT_NOT_BOUNDED).
//   * SIGNER, NO POLICY — the keeper checks that its signer is seated, never
//     what bounds it. Today's documented behaviour, said once at start-up.
//   * NO SIGNER — there is no seat to look for, so the grant check is skipped
//     too and EVERY Solana wallet in the app resolves to a signer. This is the
//     combination that WIDENS what gets signed, and with a policy id set it is
//     also the one that looks most correct from outside: /status showed a
//     populated privyPolicyId, which reads as "an unbounded seat would be
//     refused", while in fact no seat was being examined at all.
//
// THE RULE LIVES HERE, NOT IN bin/keeper.mts, so a test can reach it: the
// notice below is the whole reason this file exists, and it was a single `if`
// against one of the two ids.
//
// NAMES ONLY, NEVER VALUES. These ids are public, but a notice that interpolated
// one would print whatever was actually pasted into the variable — and the
// commonest way to hold a wrong id is to have pasted a secret into it.

import type { Alert } from "./alerts.js";

/**
 * How much of a trading wallet's seat the keeper examines before it signs, as
 * /status reports it.
 *
 * Deliberately worded for the person reading the status page at 3 a.m., not for
 * the code: each value says what the keeper DOES, not which variable is unset.
 */
export type SeatCheck =
  /** Both ids: a seat that does not carry exactly the keeper's policy is refused. */
  | "policy-enforced"
  /** A signer id alone: the keeper checks its signer is seated, not what bounds it. */
  | "seat-only"
  /** No signer id: nothing is examined, and every wallet in the app is signed for. */
  | "unchecked";

/** Which of the three the configured pair amounts to. */
export function seatCheck(signerId: string | null, policyId: string | null): SeatCheck {
  if (signerId === null) return "unchecked";
  return policyId === null ? "seat-only" : "policy-enforced";
}

/** A start-up notice about what is NOT being checked: the log line, and the page it deserves. */
export interface SeatCheckNotice {
  readonly severity: "warn" | "critical";
  /** The log line's message. A variable name, so the fix is the first thing read. */
  readonly message: string;
  readonly detail: string;
  /**
   * The alert to fire, or null when the condition is today's documented
   * behaviour rather than a widening of it. An operator reading /status can see
   * a seat-only keeper; nobody would notice, from any page, that the keeper is
   * signing for wallets it was never meant to reach.
   */
  readonly alert: Alert | null;
}

export const SEAT_CHECK_ALERT_KEY = "seat-check-unconfigured";

/**
 * What to say at start-up about the configured pair, or null when both ids are
 * set and the seat is genuinely held to the keeper's policy.
 *
 * SAID ONCE PER PROCESS, not once per sweep: it is a fact about the environment,
 * and a line per minute is a line nobody reads.
 */
export function seatCheckNotice(signerId: string | null, policyId: string | null): SeatCheckNotice | null {
  const check = seatCheck(signerId, policyId);
  if (check === "policy-enforced") return null;

  if (check === "seat-only") {
    return {
      severity: "warn",
      message: "SIP_SOLANA_PRIVY_POLICY_ID is not set",
      detail:
        "The keeper accepts a wallet that seats its signer WITHOUT the keeper's policy, and such a seat is an unbounded " +
        "signer at Privy: it could sign any message, send any transaction and export that wallet's key. Set it and the " +
        "keeper refuses to sign for those wallets.",
      alert: null,
    };
  }

  // NO SIGNER ID. The seat check cannot run, and neither can the grant check
  // above it: createPrivySolanaSigner has no seat to look for, so every Solana
  // wallet in this app resolves to SIGNER and is signed for.
  const detail =
    "With no signer id there is no seat to look for, so EVERY Solana wallet in this Privy app resolves to a signer and " +
    "the keeper signs for it: neither the grant nor the policy bounding it is examined." +
    (policyId === null
      ? " Set it to the key quorum id of the keeper's authorization key, and SIP_SOLANA_PRIVY_POLICY_ID with it."
      : " SIP_SOLANA_PRIVY_POLICY_ID is set and cannot be used without it — /status shows a policy id while no seat is " +
        "being held to it, which reads as the opposite of what is happening. Set the signer id, or remove both.");
  return {
    severity: "critical",
    message: "SIP_SOLANA_PRIVY_SIGNER_ID is not set",
    detail,
    alert: {
      key: SEAT_CHECK_ALERT_KEY,
      severity: "critical",
      title: "The keeper signs for every wallet in its Privy app",
      detail,
    },
  };
}
