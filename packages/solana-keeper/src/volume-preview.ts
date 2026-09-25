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
import { connectionReader, measureSince, readTransaction, type LedgerReader } from "./measure-window.js";
import { measurementStart } from "./settle-decision.js";
import { settledEventsFrom, type SettledEvent } from "./settled-event.js";

const sol = (lamports: bigint): string => {
  const whole = lamports / 1_000_000_000n;
  const frac = (lamports % 1_000_000_000n).toString().padStart(9, "0");
  return `${whole}.${frac}`;
};

/**
 * The last preview per link, reused while the span has not moved: the same start,
 * the same newest signature and the same rate give the same sentence, and a
 * losing PROFIT span can rest for hundreds of transactions, each a read.
 */
export type PreviewBook = Map<string, { readonly key: string; readonly text: string }>;

/** The preview sentence for one link of a PROFIT vault. */
export async function previewVolume(args: {
  readonly connection: Connection;
  readonly program: anchor.Program;
  readonly link: ManagedLink;
  readonly vault: VaultState;
  readonly book?: PreviewBook;
}): Promise<string> {
  const { connection, program, link, vault, book } = args;
  const from = measurementStart(link);
  const lead = "PROFIT vault: the profit keeper settles it, and this keeper only previews what VOLUME mode would charge";
  const [newest] = await connection.getSignaturesForAddress(link.wallet, { limit: 1 }, "confirmed");
  if (newest === undefined || BigInt(newest.slot) <= from) return `${lead}. Nothing unsettled since slot ${from}.`;
  const key = `${from}:${newest.signature}:${vault.volumeBps}:${vault.maxContribution}`;
  const cached = book?.get(link.linkAddress.toBase58());
  if (cached !== undefined && cached.key === key) return cached.text;
  const { text, through } = await measurePreview(connection, program, link, vault, from, lead);
  // KEPT ONLY WHEN IT SAW THE NEWEST SIGNATURE. The walk reads finalized history
  // and the newest signature is confirmed: a preview that stopped short of it
  // would otherwise be served after that transaction finalizes, without it.
  if (book !== undefined && through !== null && through >= BigInt(newest.slot)) book.set(link.linkAddress.toBase58(), { key, text });
  return text;
}

async function measurePreview(
  connection: Connection,
  program: anchor.Program,
  link: ManagedLink,
  vault: VaultState,
  from: bigint,
  lead: string,
): Promise<{ readonly text: string; readonly through: bigint | null }> {
  const measured = await measureSince(connectionReader(connection), link.wallet, from, program.programId, tradeNotional);
  if (!measured.frontierReached || measured.unfetchable > 0 || measured.chainBreaks > 0) {
    return { text: `${lead}. The span since slot ${from} could not be read completely this sweep.`, through: null };
  }
  const trades = measured.volumeTrades ?? [];
  const lamports = trades.reduce((sum, trade) => sum + trade.lamports, 0n);
  const owed = (lamports * BigInt(vault.volumeBps)) / 10_000n;
  const text =
    `${lead}. Since slot ${from} (finalized, through slot ${measured.lastSlot}): ${trades.length} trade(s), ` +
    `${sol(lamports)} SOL of volume; at this vault's stored volume rate of ${vault.volumeBps} bps that would owe ` +
    `${sol(owed)} SOL, before the cap of ${sol(vault.maxContribution)} SOL per settlement.`;
  // A CUT PREFIX SAYS NOTHING ABOUT WHAT CAME AFTER IT, so it is never kept.
  return { text, through: measured.prefixCut ? null : measured.lastSlot };
}

/** How many of the link's newest signatures are searched for its last settle. */
export const LAST_SETTLE_SEARCH = 20;
/** Pages of the wallet's history read to get back to the last settle's start. */
export const LAST_WINDOW_PAGES = 5;

/**
 * The LAST SETTLED window of a link, measured by the volume rule: what the profit
 * keeper charged it, and what VOLUME mode would have. Null for a link that never
 * settled, or whose last settle or window could not be read.
 *
 * WHY IT EXISTS. The profit keeper settles a winning span within a minute, so the
 * unsettled-span preview above is usually empty by the time anyone looks: the
 * owner's round trip of 2026-09-25 was settled 19 s after the sell. The last
 * settled window does not move until the next settle, so it is computed once per
 * settle (kept by nonce) and says what the wallet's latest trading came to.
 *
 * THE SETTLE IS FOUND BY ITS OWN EVENT. The newest Settled event, logged by
 * sip-vault itself (settledEventsFrom), for this wallet, this link epoch and the
 * nonce the link consumed last; its window is [sessionStartSlot, sessionEndSlot].
 */
export async function previewLastSettled(args: {
  readonly connection: Connection;
  readonly program: anchor.Program;
  readonly link: ManagedLink;
  readonly vault: VaultState;
  readonly book?: PreviewBook;
}): Promise<string | null> {
  const { connection, program, link, vault, book } = args;
  if (link.settlementNonce === 0n) return null;
  const bookKey = `last:${link.linkAddress.toBase58()}`;
  const key = `${link.epoch}:${link.settlementNonce}:${vault.volumeBps}:${vault.maxContribution}`;
  const cached = book?.get(bookKey);
  if (cached !== undefined && cached.key === key) return cached.text;

  const programId = program.programId.toBase58();
  const wanted = link.settlementNonce - 1n;
  let event: SettledEvent | null = null;
  for (const info of await connection.getSignaturesForAddress(link.linkAddress, { limit: LAST_SETTLE_SEARCH }, "finalized")) {
    if (info.err !== null) continue;
    const tx = await readTransaction(connection, info.signature, "finalized");
    const found = settledEventsFrom(tx?.meta?.logMessages ?? [], programId).find(
      (e) => e.wallet === link.wallet.toBase58() && e.linkEpoch === link.epoch && e.settlementNonce === wanted,
    );
    if (found !== undefined) {
      event = found;
      break;
    }
  }
  if (event === null) return null;

  // THE WINDOW'S OWN SIGNATURES, and the anchor below its start: the wallet's
  // history back to the start, less everything above the window's end.
  const window: { readonly signature: string; readonly slot: number }[] = [];
  let before: string | undefined;
  for (let page = 0; page < LAST_WINDOW_PAGES; page++) {
    const signatures = await connection.getSignaturesForAddress(
      link.wallet,
      before === undefined ? { limit: 1_000 } : { before, limit: 1_000 },
      "finalized",
    );
    for (const info of signatures) if (BigInt(info.slot) <= event.sessionEndSlot) window.push({ signature: info.signature, slot: info.slot });
    const last = signatures[signatures.length - 1];
    if (signatures.length < 1_000 || last === undefined || BigInt(last.slot) <= event.sessionStartSlot) break;
    before = last.signature;
  }
  const reader: LedgerReader = {
    signatures: async (_wallet, options) => {
      const start = options.before === undefined ? 0 : window.findIndex((entry) => entry.signature === options.before) + 1;
      return window.slice(start, start + options.limit);
    },
    transaction: (signature, commitment) => connectionReader(connection).transaction(signature, commitment),
  };
  const measured = await measureSince(reader, link.wallet, event.sessionStartSlot, program.programId, tradeNotional);
  if (!measured.frontierReached || measured.unfetchable > 0 || measured.chainBreaks > 0 || measured.prefixCut) return null;
  const trades = measured.volumeTrades ?? [];
  const lamports = trades.reduce((sum, trade) => sum + trade.lamports, 0n);
  const owed = (lamports * BigInt(vault.volumeBps)) / 10_000n;
  const paid = owed < vault.maxContribution ? owed : vault.maxContribution;
  const text =
    `Last settlement (nonce ${event.settlementNonce}, slots ${event.sessionStartSlot}..${event.sessionEndSlot}): ` +
    `${trades.length} trade(s), ${sol(lamports)} SOL of volume. In VOLUME mode at ${vault.volumeBps} bps it would have owed ` +
    `${sol(owed)} SOL (${sol(paid)} paid under the cap); it was charged ${sol(event.paid)} SOL in ` +
    `${event.mode === 1 ? "VOLUME" : "PROFIT"} mode at ${event.bps} bps.`;
  book?.set(bookKey, { key, text });
  return text;
}
