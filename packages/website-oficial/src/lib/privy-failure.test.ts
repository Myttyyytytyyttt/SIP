// Privy's failures, classified from the messages its 3.36.0 bundle actually throws, so the page says
// something someone can act on and never a blank.

import { base58Encode } from "@sip/solana-core/client";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { privyFailure, redactSecrets, type PrivyFailureKind } from "@/lib/privy-failure";

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

describe("redactSecrets: no key-shaped text reaches the page", () => {
  // Generated on the spot; never a real key.
  const pair = Keypair.generate();
  const key = base58Encode(pair.secretKey);

  it("takes a whole Solana key out of an unrecognised failure, and out of a refused one", () => {
    const other = privyFailure(new Error(`Could not import ${key}: bad input`)).message;
    expect(other).not.toContain(key);
    expect(other).toContain("[redacted]");
    expect(other).toContain("bad input");
    const refusedMessage = privyFailure(new Error(`Invalid policy ids for ${key}`)).message;
    expect(refusedMessage).not.toContain(key.slice(0, 43));
  });

  it("takes out a key clipped by a truncated message, down to 43 characters", () => {
    expect(redactSecrets(`input was ${key.slice(0, 43)}`)).toBe("input was [redacted]");
    expect(redactSecrets(`input was ${key.slice(0, 42)}`)).toContain(key.slice(0, 42));
  });

  it("takes out hex of 41 characters or more, with or without 0x, and keeps an EVM address", () => {
    const hex = Buffer.from(pair.secretKey.slice(0, 32)).toString("hex");
    expect(redactSecrets(`key 0x${hex}`)).toBe("key [redacted]");
    expect(redactSecrets(`key ${hex.slice(0, 41)}`)).toBe("key [redacted]");
    const address = "0x52908400098527886E0F7030069857D2E4169EE7";
    expect(redactSecrets(`account ${address}`)).toBe(`account ${address}`);
  });

  it("takes out a key file's list of numbers", () => {
    expect(redactSecrets(`parsed [${[...pair.secretKey].join(", ")}] badly`)).toBe("parsed [redacted] badly");
  });

  it("classifies on the redacted text exactly as before", () => {
    for (const [, error, kind] of CASES) expect(privyFailure(error).kind).toBe(kind);
    expect(privyFailure(new Error(`Address to add signers too is not associated with current user. ${key}`)).kind).toBe("propagating");
  });
});
