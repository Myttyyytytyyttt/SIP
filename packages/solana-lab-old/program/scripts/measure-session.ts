// The M4 measurement, as a module the keeper drill calls — RH's cash formula
// over a wallet's transaction history, from any RPC (a local validator
// included; getSignaturesForAddress works there identically).
//
//   profit = (cashEnd − cashStart) − deposits + withdrawals     … in lamports
//
// Deposits/withdrawals are PURE transfers (System/ComputeBudget only): moving
// your own money is not profit or loss. Everything else — DEX programs, memo-
// tagged flows, unknown programs — affects cash and therefore counts toward
// profit. The balance CHAIN (each tx's postBalance must equal the next one's
// preBalance) is the completeness oracle: it proves no transaction between
// the first and last was missed.

import { Connection, PublicKey } from "@solana/web3.js";

const PURE = new Set([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
]);

export interface SessionMeasurement {
  readonly txCount: number;
  readonly chainBreaks: number;
  readonly cashDelta: bigint;
  readonly deposits: bigint;
  readonly withdrawals: bigint;
  readonly profitLamports: bigint;
  readonly firstSlot: bigint;
  readonly lastSlot: bigint;
}

export async function measureCashSession(
  connection: Connection,
  wallet: PublicKey,
  limit = 50,
): Promise<SessionMeasurement> {
  const infos = await connection.getSignaturesForAddress(wallet, { limit }, "confirmed");
  infos.reverse(); // oldest first

  let firstPre: bigint | null = null;
  let lastPost = 0n;
  let prevPost: bigint | null = null;
  let chainBreaks = 0;
  let deposits = 0n;
  let withdrawals = 0n;
  let txCount = 0;
  let firstSlot = 0n;
  let lastSlot = 0n;

  for (const info of infos) {
    if (info.err !== null) continue;
    const tx = await connection.getTransaction(info.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx || !tx.meta) continue;

    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined,
    });
    const allKeys = keys.staticAccountKeys.concat(
      keys.accountKeysFromLookups?.writable ?? [],
      keys.accountKeysFromLookups?.readonly ?? [],
    );
    const index = allKeys.findIndex((k) => k.equals(wallet));
    if (index < 0) continue;

    const pre = BigInt(tx.meta.preBalances[index]!);
    const post = BigInt(tx.meta.postBalances[index]!);
    if (prevPost !== null && pre !== prevPost) chainBreaks += 1;
    prevPost = post;
    if (firstPre === null) {
      firstPre = pre;
      firstSlot = BigInt(tx.slot);
    }
    lastPost = post;
    lastSlot = BigInt(tx.slot);
    txCount += 1;

    const programs = new Set<string>();
    for (const ix of tx.transaction.message.compiledInstructions) {
      programs.add(allKeys[ix.programIdIndex]!.toBase58());
    }
    for (const inner of tx.meta.innerInstructions ?? []) {
      for (const ix of inner.instructions) programs.add(allKeys[ix.programIdIndex]!.toBase58());
    }

    if ([...programs].every((p) => PURE.has(p))) {
      const delta = post - pre;
      if (delta > 0n) deposits += delta;
      else withdrawals += -delta;
    }
  }

  const cashDelta = firstPre === null ? 0n : lastPost - firstPre;
  return {
    txCount,
    chainBreaks,
    cashDelta,
    deposits,
    withdrawals,
    profitLamports: cashDelta - deposits + withdrawals,
    firstSlot,
    lastSlot,
  };
}
