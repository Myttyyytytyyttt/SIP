// Address -> Privy wallet id, plus whether this app may actually sign for it.
//
// `signTransaction` takes Privy's wallet ID, while everything on chain — the
// factory logs, `activeVaultOf`, `msg.sender` — speaks addresses. This is the
// join between the two, and it is also the only place that can answer a question
// the chain cannot: has this wallet actually granted us a signer?
//
// That question matters because the two failure modes look identical from the
// outside. A wallet linked on chain but never signed over to us is a user we
// CANNOT settle for; discovering that at signing time means one failed attempt
// per tick, forever, against a wallet that will never work. Resolving it here
// turns it into a fact the supervisor can report once and skip.

import { getAddress, type Address } from "viem";
import { PrivyClient } from "@privy-io/node";

export interface PrivyWallet {
  readonly address: Address;
  readonly walletId: string;
  /** True when our signer id appears on the wallet's additional signers. */
  readonly signable: boolean;
}

export interface PrivyWalletIndexInput {
  readonly appId: string;
  readonly appSecret: string;
  /**
   * The key quorum id registered as a signer. When omitted every wallet reads as
   * signable, which is only correct if this app owns them outright.
   */
  readonly signerId?: string;
}

/**
 * One pass over the app's wallets. Paginated by the SDK's async iterator, so a
 * large app costs several requests rather than one enormous one.
 */
export async function buildPrivyWalletIndex(
  input: PrivyWalletIndexInput,
): Promise<Map<string, PrivyWallet>> {
  const privy = new PrivyClient({ appId: input.appId, appSecret: input.appSecret });
  const index = new Map<string, PrivyWallet>();

  for await (const wallet of privy.wallets().list({ chain_type: "ethereum" })) {
    const raw = (wallet as { address?: string; id?: string; additional_signers?: unknown }).address;
    const walletId = (wallet as { id?: string }).id;
    if (typeof raw !== "string" || typeof walletId !== "string") continue;

    let signable = true;
    if (input.signerId !== undefined) {
      const signers = (wallet as { additional_signers?: { signer_id?: string }[] }).additional_signers;
      signable = Array.isArray(signers)
        ? signers.some((signer) => signer?.signer_id === input.signerId)
        : false;
    }

    const address = getAddress(raw);
    index.set(address.toLowerCase(), { address, walletId, signable });
  }

  return index;
}
