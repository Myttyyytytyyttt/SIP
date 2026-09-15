/**
 * THE BROWSER'S OWN ADDRESSES: ["vault", owner], ["link", wallet], ["invest", vault],
 * ["config"] and associated token accounts, derived with @solana/kit (already a
 * dependency, through providers.tsx), never taken from the server.
 *
 * The page compares what the build route answered with these before any wallet
 * signs: a consent naming another vault, a create for another address, a token
 * account for someone else's vault, or a withdrawal into another account, is
 * refused. Seeds come from @sip/solana-core/client, which pins them to the IDL;
 * vault-flows.test.ts pins these derivations to the core's web3.js ones.
 */

import { ATA_PROGRAM, CONFIG_SEED, INVEST_SEED, LINK_SEED, SIP_PROGRAM_ID, VAULT_SEED } from "@sip/solana-core/client";
import { address, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";

const PROGRAM = address(SIP_PROGRAM_ID);
const ASSOCIATED_TOKEN_PROGRAM = address(ATA_PROGRAM);

type Seed = string | ReturnType<ReturnType<typeof getAddressEncoder>["encode"]>;

async function derive(seeds: Seed[], programAddress: Address = PROGRAM): Promise<string> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds });
  return pda;
}

const keyBytes = (key: string) => getAddressEncoder().encode(address(key));

/** ["vault", owner]. Throws for a key that is not base58 of 32 bytes. */
export const deriveVaultAddress = (owner: string): Promise<string> => derive([VAULT_SEED, keyBytes(owner)]);

/** ["link", wallet]. */
export const deriveLinkAddress = (wallet: string): Promise<string> => derive([LINK_SEED, keyBytes(wallet)]);

/** ["invest", vault]: the vault's investment policy. */
export const deriveInvestAddress = (vault: string): Promise<string> => derive([INVEST_SEED, keyBytes(vault)]);

/** ["config"]. */
export const deriveConfigAddress = (): Promise<string> => derive([CONFIG_SEED]);

/** The associated token account of (owner, mint) under `tokenProgram`: seeds [owner, token program, mint] under the Associated Token Account program. */
export const deriveAtaAddress = (owner: string, mint: string, tokenProgram: string): Promise<string> =>
  derive([keyBytes(owner), keyBytes(tokenProgram), keyBytes(mint)], ASSOCIATED_TOKEN_PROGRAM);
