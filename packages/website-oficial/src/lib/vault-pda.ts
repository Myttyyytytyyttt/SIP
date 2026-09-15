/**
 * THE BROWSER'S OWN ADDRESSES: ["vault", owner], ["link", wallet] and ["config"],
 * derived with @solana/kit (already a dependency, through providers.tsx), never
 * taken from the server.
 *
 * The page compares what the build route answered with these before any wallet
 * signs: a consent naming another vault, or a create for another address, is
 * refused. Seeds come from @sip/solana-core/client, which pins them to the IDL;
 * vault-flows.test.ts pins these derivations to the core's web3.js ones.
 */

import { CONFIG_SEED, LINK_SEED, SIP_PROGRAM_ID, VAULT_SEED } from "@sip/solana-core/client";
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";

const PROGRAM = address(SIP_PROGRAM_ID);

async function derive(seeds: (string | ReturnType<ReturnType<typeof getAddressEncoder>["encode"]>)[]): Promise<string> {
  const [pda] = await getProgramDerivedAddress({ programAddress: PROGRAM, seeds });
  return pda;
}

const keyBytes = (key: string) => getAddressEncoder().encode(address(key));

/** ["vault", owner]. Throws for a key that is not base58 of 32 bytes. */
export const deriveVaultAddress = (owner: string): Promise<string> => derive([VAULT_SEED, keyBytes(owner)]);

/** ["link", wallet]. */
export const deriveLinkAddress = (wallet: string): Promise<string> => derive([LINK_SEED, keyBytes(wallet)]);

/** ["config"]. */
export const deriveConfigAddress = (): Promise<string> => derive([CONFIG_SEED]);
