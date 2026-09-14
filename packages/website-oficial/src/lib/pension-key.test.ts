// The pension key is the external Solana wallet, never an embedded or an EVM one.
// Addresses are placeholders; nothing here is a real account.

import type { User } from "@privy-io/react-auth";
import { describe, expect, it } from "vitest";

import { pensionKeyOf } from "@/lib/pension-key";

const EXTERNAL = "PensionKeyP1aceho1der111111111111111111111";
const LINKED = "LinkedKeyP1aceho1der1111111111111111111111";
const EMBEDDED = "EmbeddedP1aceho1der11111111111111111111111";

function user(wallet: Record<string, unknown> | undefined, linkedAccounts: Record<string, unknown>[] = []): User {
  return { id: "did:privy:placeholder", createdAt: new Date(0), wallet, linkedAccounts, mfaMethods: [] } as unknown as User;
}

describe("pensionKeyOf", () => {
  it("is the Solana wallet the user signed in with", () => {
    expect(pensionKeyOf(user({ address: EXTERNAL, chainType: "solana", walletClientType: "phantom" }))).toBe(EXTERNAL);
  });

  it("skips Privy's embedded wallets, either generation, and falls back to a linked external Solana wallet", () => {
    const embedded = { address: EMBEDDED, chainType: "solana", walletClientType: "privy" };
    const linked = { type: "wallet", address: LINKED, chainType: "solana", walletClientType: "backpack" };
    expect(pensionKeyOf(user(embedded, [{ ...embedded, type: "wallet" }, linked]))).toBe(LINKED);
    expect(pensionKeyOf(user({ ...embedded, walletClientType: "privy-v2" }))).toBeNull();
  });

  it("is never an EVM wallet, and null when there is no wallet at all", () => {
    expect(pensionKeyOf(user({ address: "0x0000000000000000000000000000000000000001", chainType: "ethereum", walletClientType: "metamask" }))).toBeNull();
    expect(pensionKeyOf(user(undefined, [{ type: "email", address: "someone@example.invalid" }]))).toBeNull();
  });
});
