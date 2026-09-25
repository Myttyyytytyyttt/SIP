// Where a VOLUME span starts being chargeable: the last time its owner changed
// the vault's mode or its volume rate (the owner's decision of 2026-09-25,
// reports/VOLUME_KEEPER_PLAN_2026-09-25.md §3).
//
// THE HOLE THIS CLOSES. set_policy_v2 rewrites the vault's mode at once and does
// not touch the TradingLink, so everything still unsettled above the frontier is
// charged in the NEW mode. A PROFIT span can stay unsettled for a long time — a
// losing streak rests until the wallet has signed ZERO_BASE_MIN_TXS transactions
// — and on a switch to VOLUME every trade in it would be charged as volume,
// although it was made under the profit rule. So a volume span charges only the
// trades AFTER the newest policy change that moved the mode or the volume rate.
// What came before is forgiven; nothing is charged twice or under a rule the
// trader did not have when trading.
//
// A PAUSE FORGIVES NOTHING. set_policy_v2 also writes `paused`, the cap and the
// reserve, and bumps the policy nonce every time; only a change of the mode or of
// volume_bps is a boundary, so pausing to trade and unpausing does not wipe a span.
//
// READ FROM THE OWNER'S OWN HISTORY. set_policy_v2 and create_vault_v2 are both
// signed by the vault's owner (the vault is a PDA of that key), so every policy
// this vault ever had is in getSignaturesForAddress(owner). The walk stops at the
// span's start unless a change sits above it; then it goes on to the newest policy
// at or below the start, the rule the span began under.
//
// WHEN IT CANNOT KNOW, IT FORGIVES. A change the walk cannot decode (the program
// reached through another program's CPI) or a start it cannot find within its
// pages counts as a boundary: that charges less, never more. A transaction it
// cannot READ is different: the answer would be a guess, so it throws, and nothing
// is attested this turn.

import type { Finality, PublicKey, VersionedTransactionResponse } from "@solana/web3.js";
import { idl } from "./idl.js";

/** What the walk reads: the owner's signatures and one transaction at a time. */
export interface OwnerHistoryReader {
  signatures(
    owner: PublicKey,
    options: { readonly before?: string; readonly limit: number },
    commitment: Finality,
  ): Promise<readonly { readonly signature: string; readonly slot: number; readonly err: unknown }[]>;
  transaction(signature: string, commitment: Finality): Promise<VersionedTransactionResponse | null>;
}

/**
 * CONFIRMED, NOT FINALIZED. The vault this turn attests against was read at
 * confirmed, so a change the chain has confirmed but not finalized is already
 * the policy the settle is built from, and the trades before it were not made
 * under it.
 */
export const POLICY_WALK_COMMITMENT: Finality = "confirmed";
export const OWNER_PAGE_LIMIT = 1_000;
/** Pages of the owner's history read before giving up: 5 000 signatures. */
export const MAX_OWNER_PAGES = 5;

/** One policy the owner wrote: the mode and volume rate, or null for a change this walk could not decode. */
export interface PolicyWrite {
  readonly slot: bigint;
  readonly signature: string;
  readonly rule: { readonly mode: number; readonly volumeBps: number } | null;
}

export interface PolicyBoundary {
  /** Trades at or below this slot are not charged; null charges the whole span. */
  readonly slot: bigint | null;
  readonly detail: string;
}

const discriminatorOf = (name: string): Buffer => {
  const ix = (idl.instructions as readonly { readonly name: string; readonly discriminator: readonly number[] }[]).find((i) => i.name === name);
  if (ix === undefined) throw new Error(`the exported IDL has no ${name} instruction`);
  return Buffer.from(ix.discriminator);
};
/** Both write the rule at the same offsets: mode u8 at 8, skim_bps u16 at 9, volume_bps u16 at 11. */
const POLICY_WRITERS = [discriminatorOf("set_policy_v2"), discriminatorOf("create_vault_v2")];
/** The vault is account 1 of both: [owner, vault, …]. */
const VAULT_ACCOUNT = 1;

/**
 * The policies one transaction writes to `vault`, in instruction order. Empty for
 * a failed transaction, which changed nothing.
 */
export function policyWrites(tx: VersionedTransactionResponse, programId: string, vault: PublicKey, signature: string): PolicyWrite[] {
  if (!tx.meta || tx.meta.err !== null) return [];
  const message = tx.transaction.message;
  const keys = message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined });
  const slot = BigInt(tx.slot);
  const writes: PolicyWrite[] = [];
  for (const ix of message.compiledInstructions) {
    if (keys.get(ix.programIdIndex)?.toBase58() !== programId) continue;
    const data = Buffer.from(ix.data);
    const writer = POLICY_WRITERS.some((disc) => data.length >= 13 && data.subarray(0, 8).equals(disc));
    if (!writer) continue;
    const named = ix.accountKeyIndexes[VAULT_ACCOUNT];
    if (named === undefined || !keys.get(named)?.equals(vault)) continue;
    writes.push({ slot, signature, rule: { mode: data.readUInt8(8), volumeBps: data.readUInt16LE(11) } });
  }
  // THE PROGRAM REACHED THROUGH ANOTHER PROGRAM. Its data is base58 here and this
  // walk does not decode it, so an inner sip-vault instruction that names the
  // vault is taken as a change of unknown content: a boundary.
  for (const inner of tx.meta.innerInstructions ?? []) {
    for (const ix of inner.instructions) {
      if (keys.get(ix.programIdIndex)?.toBase58() !== programId) continue;
      if (!ix.accounts.some((account) => keys.get(account)?.equals(vault))) continue;
      writes.push({ slot, signature, rule: null });
    }
  }
  return writes;
}

/**
 * The boundary for a span of `vault` that starts at `from`. See the head of this file.
 */
export async function findPolicyBoundary(args: {
  readonly reader: OwnerHistoryReader;
  readonly programId: string;
  readonly vault: PublicKey;
  readonly owner: PublicKey;
  readonly from: bigint;
}): Promise<PolicyBoundary> {
  const { reader, programId, vault, owner, from } = args;
  /** Newest first, as the walk meets them. */
  const above: PolicyWrite[] = [];
  let startRule: PolicyWrite["rule"] | undefined;
  let reachedStart = false;
  let before: string | undefined;
  walk: for (let page = 0; page < MAX_OWNER_PAGES; page++) {
    const signatures = await reader.signatures(
      owner,
      before === undefined ? { limit: OWNER_PAGE_LIMIT } : { before, limit: OWNER_PAGE_LIMIT },
      POLICY_WALK_COMMITMENT,
    );
    for (const info of signatures) {
      const atOrBelowStart = BigInt(info.slot) <= from;
      if (atOrBelowStart && !reachedStart) {
        reachedStart = true;
        // NO CHANGE ABOVE THE START: the span has had one rule throughout.
        if (above.length === 0) break walk;
      }
      if (info.err !== null && info.err !== undefined) continue;
      const tx = await reader.transaction(info.signature, POLICY_WALK_COMMITMENT);
      if (tx === null) {
        throw new Error(
          `the owner's transaction ${info.signature} could not be read, so whether it changed this vault's policy is unknown; nothing is attested`,
        );
      }
      const writes = policyWrites(tx, programId, vault, info.signature).reverse();
      if (!atOrBelowStart) {
        above.push(...writes);
      } else if (writes.length > 0) {
        // The last write of the newest policy transaction at or below the start.
        startRule = writes[0]!.rule;
        break walk;
      }
    }
    if (signatures.length < OWNER_PAGE_LIMIT) break;
    before = signatures[signatures.length - 1]!.signature;
  }
  if (!reachedStart && above.length === 0) {
    throw new Error(
      `the owner's history was not read back to slot ${from} within ${MAX_OWNER_PAGES * OWNER_PAGE_LIMIT} signatures, ` +
        "so a policy change inside the span cannot be ruled out; nothing is attested",
    );
  }
  if (above.length === 0) return { slot: null, detail: `no policy change since slot ${from}` };

  // OLDEST FIRST FROM THE RULE THE SPAN BEGAN UNDER. Unknown when the walk did not
  // find it, and then the first change counts: that forgives more, never less.
  let rule: PolicyWrite["rule"] = startRule ?? null;
  let boundary: PolicyWrite | null = null;
  for (const write of [...above].reverse()) {
    const changed = rule === null || write.rule === null || write.rule.mode !== rule.mode || write.rule.volumeBps !== rule.volumeBps;
    if (changed) boundary = write;
    rule = write.rule;
  }
  if (boundary === null) return { slot: null, detail: `the owner rewrote the policy since slot ${from} without changing the mode or the volume rate` };
  return {
    slot: boundary.slot,
    detail: `the owner changed the mode or the volume rate at slot ${boundary.slot} (${boundary.signature}); trades at or before it are not charged`,
  };
}

/**
 * The last boundary found per vault, reused while nothing new has reached the
 * owner's history: a volume span that waits for its cadence is decided every
 * sweep, and walking the owner's history each time would cost the same reads for
 * the same answer.
 */
export class PolicyBoundaryBook {
  readonly #byVault = new Map<string, { readonly key: string; readonly boundary: PolicyBoundary }>();

  async boundary(args: Parameters<typeof findPolicyBoundary>[0]): Promise<PolicyBoundary> {
    const [newest] = await args.reader.signatures(args.owner, { limit: 1 }, POLICY_WALK_COMMITMENT);
    const key = `${args.from}:${newest?.signature ?? "none"}`;
    const vault = args.vault.toBase58();
    const cached = this.#byVault.get(vault);
    if (cached !== undefined && cached.key === key) return cached.boundary;
    const boundary = await findPolicyBoundary(args);
    this.#byVault.set(vault, { key, boundary });
    return boundary;
  }
}
