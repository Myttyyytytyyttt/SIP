// Which refusals of a settle wake someone. Every error on the settle path used to
// be FAILED, which pages critical; a pause switched on mid-sweep, an attestation
// that expired behind a slow endpoint and a 504 from Privy paged next to a wrong
// attester. Here every error sip-vault's IDL declares is classified in each of
// the three shapes the path produces it in — a confirmed status's
// InstructionError, web3.js's "custom program error: 0x…" and Anchor's
// "Error Code: <Name>" — and an error with no program error in it is classified
// by its HTTP status.

import { SendTransactionError } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { idl } from "../src/idl.js";
import { NOT_A_DEFECT, classifySettleRefusal } from "../src/settle-refusal.js";

const errors = idl.errors ?? [];
const codeOf = (name: string): number => {
  const found = errors.find((error) => error.name === name);
  if (found === undefined) throw new Error(`the IDL has no ${name}`);
  return found.code;
};

/** The three shapes one program error arrives in on the settle path. */
const shapes = (code: number, name: string): readonly unknown[] => [
  { InstructionError: [1, { Custom: code }] },
  new Error(`Transaction simulation failed: Error processing Instruction 1: custom program error: 0x${code.toString(16)}`),
  new Error(`AnchorError thrown in programs/sip-vault/src/instructions/settle.rs:148. Error Code: ${name}. Error Number: ${code}. Error Message: refused.`),
];

describe("a program refusal, by its IDL name", () => {
  it("the IDL still names every refusal that is not a defect", () => {
    const names = errors.map((error) => error.name);
    for (const name of Object.keys(NOT_A_DEFECT)) expect(names, name).toContain(name);
    expect(NOT_A_DEFECT).toEqual({
      VaultPaused: "PAUSED",
      ProtocolPaused: "PAUSED",
      WalletBelowReserve: "BELOW_RESERVE",
      AttestationExpired: "RETRY",
      AttestationMismatch: "RETRY",
      SkimModeMismatch: "RETRY",
      InvalidSessionWindow: "RETRY",
    });
  });

  it("classifies every error the IDL declares the same way in all three shapes, and every other one as FAILED", () => {
    expect(errors.length).toBeGreaterThan(30);
    for (const { code, name } of errors) {
      const want = NOT_A_DEFECT[name] ?? "FAILED";
      for (const shape of shapes(code, name)) {
        expect(classifySettleRefusal(shape, idl), `${name} as ${shape instanceof Error ? shape.message.slice(0, 30) : "InstructionError"}`).toEqual({
          outcome: want,
          programError: name,
          status: null,
        });
      }
    }
  });

  it("keeps the defects FAILED: a wrong attester, a missing or malformed attestation, a link to another vault, a bad policy", () => {
    for (const name of ["WrongAttester", "AttestationMissing", "AttestationMalformed", "LinkVaultMismatch", "InvalidPolicy"]) {
      expect(classifySettleRefusal({ InstructionError: [1, { Custom: codeOf(name) }] }, idl).outcome, name).toBe("FAILED");
    }
  });

  it("finds a program error in a SendTransactionError's logs and in a Privy-shaped body, ahead of the HTTP status", () => {
    const preflight = new SendTransactionError({
      action: "simulate",
      signature: "",
      transactionMessage: "Transaction simulation failed: Error processing Instruction 1",
      logs: [
        "Program 6kA9H9zQT6PW5xWkXoAFCS3NotxarzaYqj66mjMf9w4J invoke [1]",
        `Program log: AnchorError thrown in programs/sip-vault/src/instructions/settle.rs:91. Error Code: AttestationExpired. Error Number: ${codeOf("AttestationExpired")}. Error Message: expired.`,
      ],
    });
    expect(classifySettleRefusal(preflight, idl)).toEqual({ outcome: "RETRY", programError: "AttestationExpired", status: null });

    // A 400 whose body quotes the program's refusal is the program's refusal, not Privy's.
    const privy = Object.assign(new Error("400 simulation failed"), {
      status: 400,
      error: { message: `Error processing Instruction 1: custom program error: 0x${codeOf("VaultPaused").toString(16)}` },
    });
    expect(classifySettleRefusal(privy, idl)).toEqual({ outcome: "PAUSED", programError: "VaultPaused", status: null });

    const nested = new Error("send failed", { cause: { err: { InstructionError: [1, { Custom: codeOf("WalletBelowReserve") }] } } });
    expect(classifySettleRefusal(nested, idl).outcome).toBe("BELOW_RESERVE");
  });

  it("names a code the IDL does not declare and calls it FAILED: the Ed25519 precompile, Anchor's own constraints", () => {
    expect(classifySettleRefusal({ InstructionError: [0, { Custom: 2 }] }, idl)).toEqual({ outcome: "FAILED", programError: "custom program error 0x2", status: null });
    expect(classifySettleRefusal(new Error("custom program error: 0x7d6"), idl)).toEqual({ outcome: "FAILED", programError: "custom program error 0x7d6", status: null });
    expect(classifySettleRefusal(new Error("Error Code: ConstraintSeeds. Error Number: 2006."), idl)).toEqual({ outcome: "FAILED", programError: "ConstraintSeeds", status: null });
  });
});

describe("an error with no program error in it", () => {
  it("a 4xx other than 408 and 429 is Privy refusing the request itself: FAILED", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifySettleRefusal(Object.assign(new Error(`${status} refused`), { status }), idl), String(status)).toEqual({ outcome: "FAILED", programError: null, status });
    }
    expect(classifySettleRefusal({ status: 403 }, idl).outcome).toBe("FAILED");
  });

  it("a 408, a 429, a 5xx, a dropped connection, a timeout or a runtime error is RETRY", () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(classifySettleRefusal({ status }, idl), String(status)).toEqual({ outcome: "RETRY", programError: null, status });
    }
    for (const error of [
      new TypeError("fetch failed"),
      new Error("every Solana endpoint refused (endpoint 1/2 HTTP 503; endpoint 2/2 TimeoutError)"),
      "InsufficientFundsForFee",
      { InstructionError: [1, "ProgramFailedToComplete"] },
    ]) {
      expect(classifySettleRefusal(error, idl), String(error)).toMatchObject({ outcome: "RETRY", programError: null });
    }
  });

  it("never throws on odd input, a cycle included", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.cause = cyclic;
    for (const odd of [null, undefined, 5, cyclic, [], { status: "504" }]) {
      expect(classifySettleRefusal(odd, idl)).toMatchObject({ outcome: "RETRY", programError: null });
    }
  });
});
