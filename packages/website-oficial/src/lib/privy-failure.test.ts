// Privy's failures, classified from the messages its 3.36.0 bundle actually throws, so the page says
// something someone can act on and never a blank.

import { describe, expect, it } from "vitest";

import { privyFailure, type PrivyFailureKind } from "@/lib/privy-failure";

const CASES: ReadonlyArray<readonly [string, unknown, PrivyFailureKind]> = [
  ["a closed login dialog", "exited_auth_flow", "exited"],
  ["a closed link dialog", "exited_link_flow", "exited"],
  [
    "signers on an app without TEE",
    new Error(
      "Specifying additionalSigners is only supported for TEE execution and this app uses on-device execution. Learn more https://docs.privy.io/recipes/tee-wallet-migration-guide",
    ),
    "tee",
  ],
  [
    "signers on a wallet whose record is not a TEE wallet",
    new Error(
      "Specifying signers in addSessionSigners is only supported for TEE execution and this app uses On-device execution. Pass an empty array for signers instead. Learn more https://docs.privy.io/recipes/tee-wallet-migration-guide",
    ),
    "wallet-record",
  ],
  ["a wallet with no server id", new Error("Wallet to add signers to must have ID on server"), "wallet-record"],
  ["a wallet the record does not list yet", new Error("Address to add signers too is not associated with current user."), "propagating"],
  ["the SDK's own stale user", new Error("User must be authenticated and have an embedded wallet to add a session signer."), "propagating"],
  ["a missing wallet frame", new Error("Wallet proxy not initialized."), "frame"],
  ["a rate limit, by code", "too_many_requests", "rate"],
  ["a rate limit, by the code an Error carries", Object.assign(new Error("Request failed"), { privyErrorCode: "too_many_requests" }), "rate"],
  ["an ended session", new Error("User must be authenticated before creating a Privy wallet"), "session"],
  ["a disallowed origin", "invalid_origin", "origin"],
  ["a refused policy", new Error("Invalid policy ids"), "refused"],
  ["a refused signer", new Error("Key quorum not found"), "refused"],
  ["anything else", new Error("Something new"), "other"],
];

describe("privyFailure", () => {
  it.each(CASES)("classifies %s", (_, error, kind) => {
    expect(privyFailure(error).kind).toBe(kind);
  });

  it("says nothing for a closed dialog, and something for every real failure", () => {
    for (const [, error, kind] of CASES) {
      const { message } = privyFailure(error);
      if (kind === "exited") expect(message).toBe("");
      else expect(message.length).toBeGreaterThan(0);
    }
  });

  it("names both seat variables when Privy refuses the signer or its policy, and quotes Privy", () => {
    const { message } = privyFailure(new Error("Invalid policy ids"));
    expect(message).toContain("SIP_SOLANA_PRIVY_SIGNER_ID");
    expect(message).toContain("SIP_SOLANA_PRIVY_POLICY_ID");
    expect(message).toContain("Invalid policy ids");
  });

  it("never tells the owner to turn on TEE, nor blames the seat's variables, for a wallet's record", () => {
    // Both come from the wallet in the record Privy's signer methods read; this Privy app runs TEE execution.
    for (const [, error, kind] of CASES) {
      if (kind !== "wallet-record") continue;
      const { message } = privyFailure(error);
      expect(message).not.toMatch(/turn on TEE/i);
      expect(message).not.toContain("SIP_SOLANA_PRIVY");
    }
  });

  it("shows an unrecognised failure as Privy wrote it, and says so when Privy wrote nothing", () => {
    expect(privyFailure(new Error("Something new")).message).toContain("Something new");
    expect(privyFailure(undefined).message).toBe("Privy did not say why.");
    expect(privyFailure(new Error("")).message).toBe("Privy did not say why.");
  });
});
