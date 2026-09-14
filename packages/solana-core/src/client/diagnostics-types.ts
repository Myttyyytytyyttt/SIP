// Ported unchanged from Nuvem packages/solana-core/src/diagnostics-types.ts (types only, browser-safe).
//
// The shape of a diagnostic answer, shared by both chains' checklists.
//
// LIFTED VERBATIM from the EVM checklist (packages/*/src/lib/diagnostics.ts)
// rather than reinvented, because the doctrine travels with the types: only
// `pass` may look like a tick, and `unknown` is never a pass. A second, subtly
// different Check type would let one chain's checklist drift into being kinder
// than the other's about what counts as verified.

export type CheckStatus =
  /** Verified true. */
  | "pass"
  /** Verified false, and settlement cannot succeed until it changes. */
  | "fail"
  /** Verified, not blocking now, but it will bite. */
  | "warn"
  /** Could not be verified. Never treat as pass. */
  | "unknown"
  /** Does not apply in this state. */
  | "na"
  /** A fact, not a requirement. Deliberately not a tick. */
  | "note";

export type Severity = "blocking" | "warning" | "info";

export interface Check {
  readonly id: string;
  readonly label: string;
  readonly severity: Severity;
  readonly status: CheckStatus;
  /** What was actually observed. */
  readonly detail: string;
  /** Plain language: what this means for the user. */
  readonly meaning: string;
  /** Where the protocol enforces it. */
  readonly source: string;
  /** True when the condition belongs to the vault or protocol, not this account. */
  readonly scope: "protocol" | "vault" | "account";
}

export interface Verdict {
  readonly kind: "settleable" | "blocked" | "unverified";
  readonly headline: string;
  readonly detail: string;
  readonly failures: number;
  readonly unknowns: number;
  readonly warnings: number;
}
