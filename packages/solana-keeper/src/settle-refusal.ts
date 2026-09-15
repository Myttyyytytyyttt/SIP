// What a refused or unconfirmed settle means, and whether it wakes someone.
//
// EVERY ERROR WAS FAILED, AND FAILED PAGES CRITICAL. A settle that met a vault
// paused mid-sweep, an attestation that expired while an endpoint was slow, a
// policy the owner rewrote between the sweep's vault read and this turn, a 504
// from Privy: each paged "A settlement failed" next to the refusals that really
// are defects — a wrong attester, a malformed Ed25519 instruction, a link that
// names another vault. An alert that fires for weather gets muted, and then it
// is muted for the defect too.
//
// SO A REFUSAL IS CLASSIFIED BY WHAT THE PROGRAM SAID, by its IDL name and never
// by a number typed here:
//   * VaultPaused, ProtocolPaused — PAUSED: a switch someone turned on;
//   * WalletBelowReserve — BELOW_RESERVE: the trader spent between the balance
//     read and the send;
//   * AttestationExpired, AttestationMismatch, SkimModeMismatch,
//     InvalidSessionWindow — RETRY: the next sweep reads the vault and the link
//     again and measures anew;
//   * any other program error — FAILED.
// With no program error in it, an error is about the road, not the settle. An
// HTTP 4xx other than 408 and 429 is Privy refusing the request itself — its
// policy, or our authorization — and is FAILED; anything else — a 5xx, a
// timeout, a throttle, a dropped connection — is RETRY.
//
// THREE SHAPES ARE KNOWN, AND ONE PATH IS NOT. A confirmed status or a receipt
// carries {InstructionError: [index, {Custom: n}]}; web3.js's preflight carries
// "custom program error: 0x…" in its message; Anchor's log line carries
// "Error Code: <Name>". What Privy answers when its own simulation meets a
// program refusal has not been captured from a real refusal yet. A program error
// in any of the three shapes is found wherever it sits in the error — its
// message, its logs, its body, its cause — and one written some other way falls
// back to the HTTP status.

import type { Idl } from "@coral-xyz/anchor";

export type RefusalOutcome = "PAUSED" | "BELOW_RESERVE" | "RETRY" | "FAILED";

export interface SettleRefusal {
  readonly outcome: RefusalOutcome;
  /**
   * The program error the refusal carried: its IDL name, or
   * `custom program error 0x…` for a code the IDL does not name (Anchor's own
   * constraints, the Ed25519 precompile, the System program). Null when it
   * carried none.
   */
  readonly programError: string | null;
  /** The HTTP status of an error that carried no program error, when it had one. */
  readonly status: number | null;
}

/**
 * The program's refusals that are not defects, by IDL name. Every other program
 * error is FAILED; test/settle-refusal.test.ts pins that the IDL still names each
 * of these, so a rename cannot quietly turn them critical.
 */
export const NOT_A_DEFECT: Readonly<Record<string, Exclude<RefusalOutcome, "FAILED">>> = {
  VaultPaused: "PAUSED",
  ProtocolPaused: "PAUSED",
  WalletBelowReserve: "BELOW_RESERVE",
  AttestationExpired: "RETRY",
  AttestationMismatch: "RETRY",
  SkimModeMismatch: "RETRY",
  InvalidSessionWindow: "RETRY",
};

/** The fields a nested error is searched through, in this order. */
const NESTED = ["message", "logs", "transactionLogs", "transactionMessage", "errorLogs", "error", "err", "cause", "body"] as const;

/** How deep the search follows nested fields before it gives up. */
const MAX_DEPTH = 5;

export function classifySettleRefusal(error: unknown, idl: Pick<Idl, "errors">): SettleRefusal {
  const programError = findProgramError(error, idl);
  if (programError !== null) return { outcome: NOT_A_DEFECT[programError] ?? "FAILED", programError, status: null };
  const status = httpStatus(error);
  const refusedRequest = status !== null && status >= 400 && status <= 499 && status !== 408 && status !== 429;
  return { outcome: refusedRequest ? "FAILED" : "RETRY", programError: null, status };
}

function findProgramError(error: unknown, idl: Pick<Idl, "errors">): string | null {
  const named = (code: number): string =>
    idl.errors?.find((candidate) => candidate.code === code)?.name ?? `custom program error 0x${code.toString(16)}`;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): string | null => {
    if (typeof value === "string") {
      const name = /Error Code: ([A-Za-z0-9_]+)/.exec(value);
      if (name !== null) return name[1]!;
      const hex = /custom program error: 0x([0-9a-fA-F]+)/.exec(value);
      return hex === null ? null : named(Number.parseInt(hex[1]!, 16));
    }
    if (value === null || typeof value !== "object" || depth > MAX_DEPTH || seen.has(value)) return null;
    seen.add(value);
    const instructionError = (value as { readonly InstructionError?: unknown }).InstructionError;
    if (Array.isArray(instructionError)) {
      const custom = (instructionError[1] as { readonly Custom?: unknown } | null | undefined)?.Custom;
      if (typeof custom === "number") return named(custom);
    }
    const children = Array.isArray(value) ? value : NESTED.map((field) => (value as Readonly<Record<string, unknown>>)[field]);
    for (const child of children) {
      const found = visit(child, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return visit(error, 0);
}

function httpStatus(error: unknown): number | null {
  if (error === null || typeof error !== "object") return null;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" && Number.isInteger(status) ? status : null;
}
