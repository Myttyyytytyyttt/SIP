// What a PROFIT vault's unsettled span would be charged on in VOLUME mode: the
// volume keeper's read-only preview, shown on its /status row for a vault it does
// not settle. It lets the owner watch the volume measurement on a real wallet
// before any vault is in VOLUME mode.
//
// NEVER ATTESTED. It walks the same finalized span the profit keeper will settle,
// with the same completeness checks, and returns a sentence; nothing is signed or
// sent from it, and the profit keeper never calls it.

import type * as anchor from "@coral-xyz/anchor";
import type { Connection } from "@solana/web3.js";
import type { VaultState } from "./accounts.js";
import type { ManagedLink } from "./discovery.js";
import { tradeNotional } from "./measure-volume.js";
import { connectionReader, measureSince } from "./measure-window.js";
import { measurementStart } from "./settle-decision.js";

const sol = (lamports: bigint): string => {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, "0");
  return `${whole}.${frac}`;
};

/** The preview sentence for one link of a PROFIT vault. */
export async function previewVolume(args: {
  readonly connection: Connection;
  readonly program: anchor.Program;
  readonly link: ManagedLink;
  readonly vault: VaultState;
}): Promise<string> {
  const { connection, program, link, vault } = args;
  const from = measurementStart(link);
  const lead = "PROFIT vault: the profit keeper settles it, and this keeper only previews what VOLUME mode would charge";
  const [newest] = await connection.getSignaturesForAddress(link.wallet, { limit: 1 }, "confirmed");
  if (newest === undefined || BigInt(newest.slot) <= from) return `${lead}. Nothing unsettled since slot ${from}.`;
  const measured = await measureSince(connectionReader(connection), link.wallet, from, program.programId, tradeNotional);
  if (!measured.frontierReached || measured.unfetchable > 0 || measured.chainBreaks > 0) {
    return `${lead}. The span since slot ${from} could not be read completely this sweep.`;
  }
  const trades = measured.volumeTrades ?? [];
  const lamports = trades.reduce((sum, trade) => sum + trade.lamports, 0n);
  const owed = (lamports * BigInt(vault.volumeBps)) / 10_000n;
  return (
    `${lead}. Since slot ${from} (finalized, through slot ${measured.lastSlot}): ${trades.length} trade(s), ` +
    `${sol(lamports)} SOL of volume; at this vault's stored volume rate of ${vault.volumeBps} bps that would owe ` +
    `${sol(owed)} SOL, before the cap of ${sol(vault.maxContribution)} SOL per settlement.`
  );
}
