// What one transaction TRADED, in lamports: the notional a VOLUME vault is
// charged on (the owner's rule of 2026-09-25, reports/VOLUME_KEEPER_PLAN_2026-09-25.md §1).
//
// A TRANSACTION COUNTS WHEN ALL FOUR HOLD:
//   1. the trading wallet SIGNED it — a stranger's credit is not the trader's volume;
//   2. it SUCCEEDED — a failed swap pays its fee and buys nothing;
//   3. it is not an external flow or one of our own settles (isExternalFlowTx);
//   4. the wallet's SOL position and another token it owns moved in OPPOSITE
//      directions — a buy or a sell, not a wrap, an unwrap or a transfer with a Memo.
//
// ITS NOTIONAL is how far the wallet's SOL position moved: its own lamports plus
// the wSOL its token accounts hold, with the network fee put back when the wallet
// paid it, and the rent of the wallet's token accounts opened or closed in the
// transaction taken out. Both legs of a round trip count: a buy of 1 SOL and its
// sell for 1.1 SOL are 2.1 SOL of volume.
//
// WHAT IT LEAVES IN, AND SAYS SO. On a buy, the platform's fee and any tip the
// wallet paid are inside what left it; on a sell, what arrived is already net of
// them. Over the owner's four trades of 2026-09-23 that put the figure 0.12 %
// under what the pump.fun curve moved. A swap with no SOL leg (USDC to a token)
// counts as nothing, and so does a buy and sell of one token inside one
// transaction. Each of these charges less, never more.
//
// PURE, AND NEVER CALLED BY THE PROFIT KEEPER. It reads one transaction the walk
// already fetched and returns a number; measureSince calls it only when a volume
// keeper passes it in (measure-window.ts), so a defect here cannot reach a PROFIT
// settle.

import type { PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { isExternalFlowTx, isFeePayer, isSignedByWallet } from "./measure-window.js";

/** Wrapped SOL. Its token amount IS lamports, so a wallet's wSOL is part of its SOL position. */
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

/** Why a transaction was not counted as volume, in the order the rules are checked. */
export type VolumeSkip =
  | "no-meta"
  | "not-named"
  | "failed"
  | "not-signed"
  | "flow"
  | "no-sol-leg"
  | "no-counter-leg";

export type TradeNotional =
  | { readonly counted: true; readonly lamports: bigint }
  | { readonly counted: false; readonly skip: VolumeSkip };

/**
 * A volume probe: what one transaction of the walk traded for the wallet. The one
 * shape measureSince takes (measure-window.ts); tradeNotional is the production one.
 */
export type VolumeProbe = (tx: VersionedTransactionResponse, wallet: PublicKey, settleProgramId: string | undefined) => TradeNotional;

interface OwnedTokenAccount {
  readonly mint: string;
  pre: bigint;
  post: bigint;
}

/** The notional of one transaction for `wallet`, or why it is not volume. See the head of this file. */
export const tradeNotional: VolumeProbe = (tx, wallet, settleProgramId) => {
  const meta = tx.meta;
  if (!meta) return { counted: false, skip: "no-meta" };
  const message = tx.transaction.message;
  const keys = message.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses ?? undefined });
  let index = -1;
  for (let i = 0; i < keys.length; i++) {
    if (keys.get(i)!.equals(wallet)) {
      index = i;
      break;
    }
  }
  if (index < 0) return { counted: false, skip: "not-named" };
  // 2 BEFORE 1 ONLY IN THE ORDER OF THE CHECKS: both refuse, and "failed" is the
  // more useful name for a transaction the wallet signed and that did nothing.
  if (meta.err !== null) return { counted: false, skip: "failed" };
  if (!isSignedByWallet(message, wallet)) return { counted: false, skip: "not-signed" };

  const programs = new Set<string>();
  for (const ix of message.compiledInstructions) programs.add(keys.get(ix.programIdIndex)!.toBase58());
  for (const inner of meta.innerInstructions ?? []) {
    for (const ix of inner.instructions) programs.add(keys.get(ix.programIdIndex)!.toBase58());
  }
  if (isExternalFlowTx(programs, settleProgramId)) return { counted: false, skip: "flow" };

  // THE WALLET'S TOKEN ACCOUNTS, BY ACCOUNT, from the token balances the node
  // reports with their owner. An account missing on one side did not exist there:
  // opened in this transaction, or closed by it.
  const owner = wallet.toBase58();
  const owned = new Map<number, OwnedTokenAccount>();
  const take = (balances: typeof meta.preTokenBalances, side: "pre" | "post"): void => {
    for (const balance of balances ?? []) {
      if (balance.owner !== owner) continue;
      const entry = owned.get(balance.accountIndex) ?? { mint: balance.mint, pre: 0n, post: 0n };
      entry[side] = BigInt(balance.uiTokenAmount.amount);
      owned.set(balance.accountIndex, entry);
    }
  };
  take(meta.preTokenBalances, "pre");
  take(meta.postTokenBalances, "post");

  // THE SOL POSITION. The fee goes back in only when the wallet paid it; the
  // rent of an account the wallet owns comes out when that account is opened
  // (it had no lamports before) or closed (it has none after). A wSOL account's
  // lamports are its rent plus the wSOL it holds, and the wSOL is counted as SOL
  // already, so only the rest is rent.
  let position = BigInt(meta.postBalances[index]!) - BigInt(meta.preBalances[index]!);
  if (isFeePayer(message, wallet)) position += BigInt(meta.fee);
  const tokenMoves = new Map<string, bigint>();
  for (const [accountIndex, account] of owned) {
    const isWsol = account.mint === WSOL_MINT;
    if (isWsol) position += account.post - account.pre;
    else tokenMoves.set(account.mint, (tokenMoves.get(account.mint) ?? 0n) + (account.post - account.pre));
    const preLamports = BigInt(meta.preBalances[accountIndex] ?? 0);
    const postLamports = BigInt(meta.postBalances[accountIndex] ?? 0);
    if (preLamports === 0n && postLamports > 0n) position += postLamports - (isWsol ? account.post : 0n);
    else if (preLamports > 0n && postLamports === 0n) position -= preLamports - (isWsol ? account.pre : 0n);
  }

  if (position === 0n) return { counted: false, skip: "no-sol-leg" };
  // OPPOSITE DIRECTIONS: SOL out and a token in, or a token out and SOL in.
  const opposite = [...tokenMoves.values()].some((moved) => (position < 0n ? moved > 0n : moved < 0n));
  if (!opposite) return { counted: false, skip: "no-counter-leg" };
  return { counted: true, lamports: position < 0n ? -position : position };
};
