// Who is this keeper responsible for? Ask the chain, not a database.
//
// THE SOLANA ANSWER IS BETTER THAN THE EVM ONE. On Robinhood Chain, discovery
// replays VaultFactory's TradingAccountLinked/Unlinked LOGS in order and then
// confirms each candidate against activeVaultOf — a history that can be
// truncated by a node whose head lags, which is exactly the failure
// keeper-supervisor.mts documents at length.
//
// Here, every link is an ACCOUNT: the TradingLink PDA. getProgramAccounts
// returns the complete CURRENT set in one call — state, not history. There is
// no watermark to advance, no rescan margin, no "a node clamped my toBlock and
// I stepped over a user forever". An unlinked wallet's account is CLOSED, so it
// simply stops being returned.
//
// The cost is that getProgramAccounts is heavy and some RPCs throttle or
// paginate it; that is a provider problem with a provider answer (a keyed
// endpoint), not a correctness one.

import { Connection, PublicKey } from "@solana/web3.js";

/** Mirrors state.rs TradingLink: disc(8) wallet(32) vault(32) epoch(8) nonce(8) frontier(8) bump(1) reserved(32). */
export const TRADING_LINK_SPACE = 129;

export interface ManagedLink {
  readonly linkAddress: PublicKey;
  readonly wallet: PublicKey;
  readonly vault: PublicKey;
  readonly epoch: bigint;
  readonly settlementNonce: bigint;
  readonly frontierSlot: bigint;
}

const u64 = (data: Buffer, offset: number): bigint => data.readBigUInt64LE(offset);

/**
 * Every trading link this program currently knows about.
 *
 * The dataSize filter is the whole selector: only TradingLink accounts are 129
 * bytes, so vaults, policies and the config never enter the result. The
 * discriminator is checked too, because a future account type could share the
 * size and silently decode into nonsense.
 */
export async function discoverLinks(
  connection: Connection,
  programId: PublicKey,
  discriminator: Buffer,
): Promise<ManagedLink[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ dataSize: TRADING_LINK_SPACE }],
  });

  const links: ManagedLink[] = [];
  for (const { pubkey, account } of accounts) {
    const data = account.data;
    if (!data.subarray(0, 8).equals(discriminator)) continue;
    links.push({
      linkAddress: pubkey,
      wallet: new PublicKey(data.subarray(8, 40)),
      vault: new PublicKey(data.subarray(40, 72)),
      epoch: u64(data, 72),
      settlementNonce: u64(data, 80),
      frontierSlot: u64(data, 88),
    });
  }
  return links;
}
