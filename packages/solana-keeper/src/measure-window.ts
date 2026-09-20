// Measures a wallet's cash profit over ONE BOUNDED WINDOW: strictly after a
// frontier slot, up to the newest FINALIZED transaction.
//
// Ported from Nuvem's solana-lab keeper (keeper/src/measure-window.ts). The
// settle marker is now sip-vault's program id, and the walk now reads finalized
// history only and proves it reached the frontier instead of assuming it.
//
// The drill's measure-session.ts walks a fixed count of recent transactions,
// which is right for a one-shot demo and wrong for a keeper: a tester trading
// on Axiom keeps trading, so every tick must look at the UNSETTLED span only.
// This walks backwards from the newest signature and stops at the frontier,
// which is also what keeps the RPC cost proportional to new activity rather
// than to account age.
//
// The formula is RH's, unchanged: profit = cashΔ − deposits + withdrawals, in
// lamports. Pure System/ComputeBudget transfers are external flows; everything
// else (Jupiter, pump.fun, Raydium, anything) is trading and counts.

import { SolanaJSONRPCErrorCode } from "@solana/web3.js";
import type { Connection, Finality, PublicKey, VersionedMessage, VersionedTransactionResponse } from "@solana/web3.js";

// Programs whose presence NEVER means trading: the System/ComputeBudget pair,
// plus the Ed25519 precompile that a settle carries for its attestation. A
// transaction touching ONLY these (optionally plus our own program) moved the
// wallet's lamports for a reason that is not a trade.
const NON_TRADING = new Set([
  "11111111111111111111111111111111",
  "ComputeBudget111111111111111111111111111111",
  "Ed25519SigVerify111111111111111111111111111",
]);

/**
 * EXCLUSIVITY, not presence. A transaction is an external flow only when EVERY
 * program it touches is non-trading (optionally our own settle program).
 *
 * Keying on the mere PRESENCE of our program id was a laundering hole: a wallet
 * exported to Axiom could append a 1-lamport wrap_sol to a real Jupiter trade
 * and have the WHOLE transaction reclassified as flow — erasing a loss from
 * P&L, or a win from the skim. A real settle is {Ed25519, sip-vault, System}; a
 * trade bundled with a sip-vault instruction still carries Jupiter/Raydium/Token
 * in its program set, so exclusivity keeps it trading. Asserted at image-build
 * time (keeper --preflight), so a regression fails the Docker build.
 */
export function isExternalFlowTx(programs: Iterable<string>, settleProgramId?: string): boolean {
  for (const p of programs) {
    if (!NON_TRADING.has(p) && p !== settleProgramId) return false;
  }
  return true;
}

/**
 * The commitment every read of the window is made at: signatures, the window's
 * transactions and the anchor below it.
 *
 * FINALIZED, BECAUSE SETTLED SLOTS ARE NEVER READ AGAIN. A settle moves the
 * frontier to the window's last slot, and the next walk stops at that slot, so
 * a transaction the walk did not see at or below it is never measured by
 * anyone. At confirmed a slot can still be missing a transaction a slower node
 * has not indexed, or belong to a fork that is dropped; at finalized it is what
 * the chain will always say.
 */
export const WALK_COMMITMENT: Finality = "finalized";

/** Signatures per page: the RPC's own maximum, so pages are few and cheap. */
export const SIGNATURE_PAGE_LIMIT = 1_000;

/**
 * Pages walked before a turn gives up on reaching the frontier: 20 000
 * signatures. It bounds what a griefer can make one turn cost, not what a turn
 * reads — see MAX_SIGNATURES for that. It is also the one backlog no turn
 * drains: a prefix starts at the frontier, so a walk that never reaches it has
 * nothing to settle, and the span is INCOMPLETE every sweep, because nothing but
 * a landed settle moves the frontier.
 */
export const MAX_SIGNATURE_PAGES = 20;

/**
 * How many transactions one settlement measures: the oldest 300 above the
 * frontier, and the rest of the slot the 300th sits in. A larger span is settled
 * a prefix at a time, oldest first, and nothing above the prefix is read — see
 * oldestCompletePrefix.
 */
export const MAX_SIGNATURES = 300;

/**
 * The oldest complete stretch of a span, which is what one settlement measures:
 * the oldest `limit` signatures, and every other signature in the slot the
 * newest of them sits in.
 *
 * A BACKLOG DRAINS FROM ITS OLD END. The frontier moves only when a settle lands,
 * to the window's end slot (settle.rs), and the walk used to refuse every span
 * above the read limit without reading it. So a link stayed wedged for good once
 * 300 signatures sat above its frontier: after a pause, after a VOLUME detour, or
 * after anyone at all sent its wallet 300 zero-lamport transfers for about
 * 0.0015 SOL of fees. settle_v2 accepts any window that starts at or above the
 * frontier and ends above its start, so the oldest part of a span settles on its
 * own, and the next sweep measures from where it ended.
 *
 * A SLOT IS NEVER SPLIT. The settle moves the frontier to the prefix's last slot
 * S, and the next walk stops at the first signature at or below S, so a signature
 * in S left out of this prefix would never be read by anyone. Every collected
 * signature at or below S is in, however many that makes; the walk collected
 * them all, because it reached the frontier. Taken by slot rather than by
 * position, so an endpoint that orders a slot's signatures its own way changes
 * nothing about which ones are in.
 *
 * `signaturesNewestFirst` is the walk's collection, in getSignaturesForAddress's
 * order; the prefix comes back oldest first. `endSlot` is S, or null for an empty
 * span, and `prefixCut` says signatures newer than S remain for a later
 * settlement.
 */
export function oldestCompletePrefix<T extends { readonly slot: number }>(
  signaturesNewestFirst: readonly T[],
  limit: number = MAX_SIGNATURES,
): { readonly prefix: T[]; readonly endSlot: number | null; readonly prefixCut: boolean } {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`a prefix holds at least one signature, so its limit must be a positive integer, not ${limit}`);
  }
  const oldestFirst = [...signaturesNewestFirst].reverse();
  if (oldestFirst.length === 0) return { prefix: [], endSlot: null, prefixCut: false };
  let endSlot = oldestFirst[0]!.slot;
  for (const info of oldestFirst.slice(0, limit)) {
    if (info.slot > endSlot) endSlot = info.slot;
  }
  const prefix = oldestFirst.filter((info) => info.slot <= endSlot);
  return { prefix, endSlot, prefixCut: prefix.length < oldestFirst.length };
}

/**
 * Where the walk reads the ledger. A Connection in production (connectionReader);
 * a fake ledger in tests, which is how a walk is tested without a network.
 *
 * NO `until`, BY TYPE. Paging back to the last settle's own signature looks like
 * the cheap way to stop, and it skips trades: a window (F, S] is settled by a
 * transaction that lands at a slot above S, the program moves the frontier to S,
 * and a trade made at a slot between S and that settle is OLDER than the settle
 * signature — so a walk that stops there never sees it, and no balance-chain
 * break reveals it, because the walk starts after it. The walk stops on SLOT,
 * and this interface cannot carry anything else.
 */
export interface LedgerReader {
  signatures(
    wallet: PublicKey,
    options: { readonly before?: string; readonly limit: number },
    commitment: Finality,
  ): Promise<readonly { readonly signature: string; readonly slot: number }[]>;
  transaction(signature: string, commitment: Finality): Promise<VersionedTransactionResponse | null>;
}

/**
 * The highest transaction message version this keeper asks the RPC for, and the
 * highest its own client can decode.
 *
 * `maxSupportedTransactionVersion: 0` DOES NOT MEAN "give me what you can". It
 * is a contract with the node, and a transaction ABOVE the number given is not
 * degraded and is not returned as null: the node answers JSON-RPC error -32015,
 * and web3.js turns that into a thrown SolanaJSONRPCError. So one such
 * transaction anywhere in a window did not cost that transaction — it killed
 * the whole walk, at the first one, before anything above it was read.
 *
 * THAT IS NOT HYPOTHETICAL AND IT IS NOT RARE. Of 84 good transactions measured
 * against the SPYx pool on 2026-09-20, 71 were version 1, all from one bot. The
 * exposure that matters is not the pool but the SETTLE path: a linked wallet
 * that trades against any such venue could not be measured at all, and the
 * measurement is what a user's contribution is computed from. A wallet like that
 * would have reported an error every sweep, forever, and saved nothing.
 *
 * 1, BECAUSE 1 IS WHAT THIS CLIENT UNDERSTANDS. @solana/web3.js 1.99 builds a
 * MessageV1 from a version 1 response and a MessageV0 from a version 0 one
 * (versionedMessageFromResponse); a version 2 response would be handed to the
 * LEGACY Message constructor, which is quietly wrong and worse than an error. So
 * the number asked for is exactly the number that can be decoded faithfully, and
 * raising it is a decision to make when the library can decode more — not before.
 */
export const MAX_SUPPORTED_TRANSACTION_VERSION = 1;

/**
 * Whether an error is the node refusing a transaction NEWER than the version
 * asked for, rather than anything else that can go wrong in a read.
 *
 * TOLD APART ON PURPOSE. Swallowing every error here would turn a throttled or
 * dead endpoint into "the chain holds transactions we cannot decode", which is a
 * claim about the USER when the truth is about our RPC — the same confusion the
 * unfetchable counter exists to prevent. Only this one error is absorbed;
 * everything else still throws and still reaches the sweep's error path.
 *
 * The code is the library's own. The message is checked too because a pooled or
 * proxied endpoint can re-wrap the error and lose the code, and the node's words
 * name the very parameter that caused it.
 */
export function isUnsupportedTransactionVersion(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { readonly code?: unknown }).code === SolanaJSONRPCErrorCode.JSON_RPC_SERVER_ERROR_UNSUPPORTED_TRANSACTION_VERSION) return true;
  return error instanceof Error && /maxSupportedTransactionVersion/i.test(error.message);
}

/**
 * THE ONE PLACE THIS PACKAGE READS A TRANSACTION. Both readers go through it —
 * the walk's (connectionReader, below) and the settle's own receipt
 * (settle-tick.ts) — so the version contract cannot be right in one and wrong in
 * the other, which is exactly how it was.
 *
 * A version even this client cannot decode comes back as NULL, the same answer a
 * throttling RPC gives. That is deliberate: null is counted as `unfetchable`,
 * which makes the measurement INCOMPLETE and refuses the settle in words an
 * operator can act on, instead of throwing this link — and every link behind it
 * in the sweep — off the turn. A window is never measured from a transaction
 * nobody read.
 */
export async function readTransaction(
  connection: Connection,
  signature: string,
  commitment: Finality,
): Promise<VersionedTransactionResponse | null> {
  try {
    // Written as a literal at the call site: the config object is what selects
    // web3.js's VERSIONED overload, and a variable would resolve to the legacy
    // one and type the answer as a transaction that cannot be versioned.
    return await connection.getTransaction(signature, { maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION, commitment });
  } catch (error) {
    if (!isUnsupportedTransactionVersion(error)) throw error;
    return null;
  }
}

export function connectionReader(connection: Connection): LedgerReader {
  return {
    signatures: (wallet, options, commitment) =>
      connection.getSignaturesForAddress(
        wallet,
        options.before === undefined ? { limit: options.limit } : { before: options.before, limit: options.limit },
        commitment,
      ),
    transaction: (signature, commitment) => readTransaction(connection, signature, commitment),
  };
}

export interface WindowMeasurement {
  readonly txCount: number;
  /**
   * Transactions in the window that are OUR OWN SETTLES: every program they
   * touch is non-trading or sip-vault, and sip-vault is among them. The
   * zero-base loop guard needs it: a window holding only the previous settle
   * measures a profit of zero and must not be settled again.
   */
  readonly settleTxCount: number;
  /**
   * Transactions in the window THE TRADING WALLET SIGNED ITSELF, failed ones
   * included and our own settles not: the one count the zero-base cadence reads
   * (ZERO_BASE_MIN_TXS, settle-decision.ts). Every other count here — txCount,
   * settleTxCount, the prefix and the walk's bounds — still takes every
   * transaction that names the wallet.
   *
   * SIGNED, NOT NAMED. Anyone can name a wallet: a stranger's zero-lamport
   * transfer lands in its history for a fraction of a cent. While every such
   * transfer counted, 100 of them made a losing span zero-settle, and its losses
   * were forgotten before the next win could net against them. Only the wallet's
   * key signs as the wallet, so this count moves with the trader's own activity
   * alone. Our own settles are signed by the wallet too, through its Privy seat,
   * and never count: settling is not trading, and one zero settle must not bring
   * the next one closer.
   */
  readonly walletSignedTxCount: number;
  /** Trading transactions (not external flows) that succeeded. A failed swap pays its fee and trades nothing. */
  readonly successfulTradeCount: number;
  readonly chainBreaks: number;
  /**
   * Transactions the RPC would not return. NOT the same as a chain break: a
   * break says the chain has a hole, this says WE could not see. Any non-zero
   * value makes the measurement unusable, and saying which it is decides
   * whether an operator looks at the user's wallet or at their RPC plan. The
   * anchor counts too: without it the window's first balance is unchecked.
   */
  readonly unfetchable: number;
  readonly cashDelta: bigint;
  readonly deposits: bigint;
  readonly withdrawals: bigint;
  readonly profitLamports: bigint;
  readonly firstSlot: bigint;
  /**
   * The slot this window ends at, which a settle makes the new frontier: the
   * newest slot the walk read, every signature in it included. `from` when
   * nothing was read.
   */
  readonly lastSlot: bigint;
  /** Signatures the walk collected strictly above the frontier, read or not. */
  readonly signaturesAbove: number;
  /**
   * True only when the walk SAW a finalized signature at or below the frontier.
   * Nothing is attested without it: a walk that ran out of history, or out of
   * pages, measured a window whose oldest part it never saw.
   */
  readonly frontierReached: boolean;
  /** True when the walk stopped at MAX_SIGNATURE_PAGES full pages without reaching the frontier. */
  readonly pagesExhausted: boolean;
  /**
   * True when this window is only the oldest complete prefix of its span
   * (oldestCompletePrefix): more than MAX_SIGNATURES signatures sat above the
   * frontier, the walk read the oldest of them through the end of lastSlot, and
   * every signature newer than lastSlot waits for the next settlement. False for
   * a walk that did not reach the frontier, which reads nothing.
   */
  readonly prefixCut: boolean;
}

export async function measureSince(
  reader: LedgerReader,
  wallet: PublicKey,
  /**
   * The watermark to measure from. ZERO IS NOT "the beginning of time": a
   * freshly linked wallet has frontier_slot 0, and walking a real trader's
   * whole history from there both runs past the walk's limits (which reports
   * INCOMPLETE forever, the same deadlock) and would take a skim on profit
   * earned BEFORE they joined. Callers pass the link's `epoch` — the slot the
   * link was created — in that case; see settle-decision.ts.
   */
  from: bigint,
  /**
   * The sip-vault program id. A transaction that invokes it from this wallet
   * is OUR OWN SETTLE — the wallet pushing savings to the vault — and savings
   * are not trading losses. Without this, every settle sits in the next window
   * as a phantom loss the user's next profit must overcome first, so the
   * keeper systematically under-settles by 20% of the previous settle,
   * forever. Classified as an EXTERNAL FLOW (like deposits/withdrawals) rather
   * than skipped, because skipping would break the balance-chain oracle: the
   * settle really did change the balance, and the chain must show it.
   */
  settleProgram?: PublicKey,
): Promise<WindowMeasurement> {
  // Collect signatures newest-first until one sits at or below the frontier.
  const collected: { signature: string; slot: number }[] = [];
  let anchor: string | null = null;
  let before: string | undefined;
  let pages = 0;
  let pagesExhausted = false;

  walk: for (;;) {
    if (pages === MAX_SIGNATURE_PAGES) {
      pagesExhausted = true;
      break;
    }
    const page = await reader.signatures(
      wallet,
      before === undefined ? { limit: SIGNATURE_PAGE_LIMIT } : { before, limit: SIGNATURE_PAGE_LIMIT },
      WALK_COMMITMENT,
    );
    pages += 1;
    for (const info of page) {
      // REACHED MEANS SEEN. The first signature at or below the frontier is the
      // proof that everything above it was collected, and it becomes the
      // anchor the balance chain starts from. Signatures in the frontier's own
      // slot are settled already, so they end the walk too.
      if (BigInt(info.slot) <= from) {
        anchor = info.signature;
        break walk;
      }
      // FAILED TRANSACTIONS ARE WALKED, NOT SKIPPED — and this is the single
      // most consequential line in the file.
      //
      // A failed Solana transaction still charges its fee payer, and a trading
      // wallet IS the fee payer for its own swaps. Skipping them left a balance
      // drop the walk never saw, so the next successful transaction's preBalance
      // no longer matched the previous postBalance, the completeness oracle
      // recorded a break, and settle refused to attest. Because only a
      // successful settle advances the frontier, that failed transaction stayed
      // inside the window forever: the wallet became permanently unsettleable.
      //
      // Failures are ROUTINE here, not exceptional: 38 of 100 recent Raydium
      // CLMM transactions on mainnet failed when this was measured. Every real
      // trading wallet reaches that state within a day. The scripted drill that
      // validated this system produced no failures, which is exactly why it
      // never surfaced.
      //
      // Walking them keeps the chain intact and puts their fee where it belongs:
      // inside cashDelta, as a cost of trading, which is what it is.
      collected.push({ signature: info.signature, slot: info.slot });
    }
    // A SHORT PAGE IS THE END OF HISTORY, NOT THE FRONTIER. An empty page used
    // to end the walk as if it had arrived, so an endpoint whose history stops
    // above the frontier — a pruned node the pool failed over to, or a start
    // not finalized yet — produced a "complete" window missing its oldest part.
    if (page.length < SIGNATURE_PAGE_LIMIT) break;
    // A FULL PAGE ONLY MEANS "LOOK AGAIN". The old walk declared itself
    // truncated after its third full page even when the frontier signature was
    // the very next one.
    before = page[page.length - 1]!.signature;
  }

  const frontierReached = anchor !== null;
  const signaturesAbove = collected.length;
  const measurement = {
    txCount: 0,
    settleTxCount: 0,
    walletSignedTxCount: 0,
    successfulTradeCount: 0,
    chainBreaks: 0,
    unfetchable: 0,
    cashDelta: 0n,
    deposits: 0n,
    withdrawals: 0n,
    profitLamports: 0n,
    firstSlot: 0n,
    lastSlot: from,
    signaturesAbove,
    frontierReached,
    pagesExhausted,
    prefixCut: false,
  };
  // NOTHING IS READ THAT CANNOT BE ATTESTED. A walk that did not reach the
  // frontier is refused whatever its transactions say, so not one of them is
  // fetched.
  if (anchor === null) return measurement;

  // ONLY THE OLDEST COMPLETE PREFIX IS READ. A span above the read limit used to
  // be refused here before a single transaction was fetched, and nothing ever
  // settled part of one, so the refusal repeated every sweep and the link never
  // saved again. Now its oldest MAX_SIGNATURES signatures, and the rest of their
  // last slot, are measured as a window of their own, and the next sweep walks
  // back to the frontier that window's settle leaves and takes the next prefix.
  // Nothing above the prefix is fetched: the next sweep reads it from its own
  // anchor anyway.
  const { prefix, endSlot, prefixCut } = oldestCompletePrefix(collected);

  let unfetchable = 0;
  let firstPre: bigint | null = null;
  let lastPost = 0n;
  let prevPost: bigint | null = null;
  let chainBreaks = 0;
  let deposits = 0n;
  let withdrawals = 0n;
  let txCount = 0;
  let settleTxCount = 0;
  let walletSignedTxCount = 0;
  let successfulTradeCount = 0;
  let firstSlot = 0n;
  const settleProgramId = settleProgram?.toBase58();

  // THE ANCHOR SEEDS THE CHAIN. Each walk used to start its chain at null, so
  // the first transaction of a window was checked against nothing, and a hole
  // just above the frontier was invisible. The anchor is the newest finalized
  // transaction at or below the frontier; its post balance is the wallet's
  // balance when the window opens, and the window's first pre balance must
  // equal it. An anchor the RPC would not return, or returned without the
  // wallet among its keys, is counted as unfetchable, never skipped: a skipped
  // anchor is a window whose first balance nobody checked.
  const anchorTx = await reader.transaction(anchor, WALK_COMMITMENT);
  const anchorBalances = anchorTx === null ? null : walletBalances(anchorTx, wallet);
  if (anchorBalances === null) unfetchable += 1;
  else prevPost = anchorBalances.post;

  for (const entry of prefix) {
    const tx = await reader.transaction(entry.signature, WALK_COMMITMENT);
    if (!tx || !tx.meta) {
      // A NULL IS NOT AN ABSENCE. live-route.ts documents the same hazard in
      // its own error text: a throttling RPC returns null WITHOUT erroring. So
      // skipping here silently dropped a real balance-changing transaction from
      // the walk, the chain registered a break, and the keeper reported
      // INCOMPLETE — a claim about the USER'S TRADING when the truth was that
      // its own RPC was rate limited. Counted and surfaced instead, so the
      // caller can tell "we could not read" from "the chain has a hole".
      unfetchable += 1;
      continue;
    }
    const balances = walletBalances(tx, wallet);
    if (balances === null) continue;
    const { pre, post, programs } = balances;

    if (prevPost !== null && pre !== prevPost) chainBreaks += 1;
    prevPost = post;
    if (firstPre === null) {
      firstPre = pre;
      firstSlot = BigInt(tx.slot);
    }
    lastPost = post;
    txCount += 1;

    const isExternalFlow = isExternalFlowTx(programs, settleProgramId);
    const ownSettle = isExternalFlow && settleProgramId !== undefined && programs.has(settleProgramId);
    if (isExternalFlow) {
      const delta = post - pre;
      if (delta > 0n) deposits += delta;
      else withdrawals += -delta;
      if (ownSettle) settleTxCount += 1;
    } else if (tx.meta.err === null) {
      successfulTradeCount += 1;
    }
    // THE CADENCE COUNTS WHAT THE WALLET SIGNED, AND NOTHING WE SENT. A failed
    // transaction the wallet signed counts: the trader acted, and paid its fee.
    // Our own settle does not, although the wallet signed it too.
    if (!ownSettle && isSignedByWallet(tx.transaction.message, wallet)) walletSignedTxCount += 1;
  }

  const cashDelta = firstPre === null ? 0n : lastPost - firstPre;
  return {
    ...measurement,
    txCount,
    settleTxCount,
    walletSignedTxCount,
    successfulTradeCount,
    chainBreaks,
    unfetchable,
    cashDelta,
    deposits,
    withdrawals,
    profitLamports: cashDelta - deposits + withdrawals,
    firstSlot,
    // THE PREFIX'S LAST SLOT, NOT THE LAST TRANSACTION'S. Every signature the walk
    // collected at or below it was read, and none above it, so it is the one end a
    // settle can move the frontier to without skipping or rereading anything.
    lastSlot: endSlot === null ? from : BigInt(endSlot),
    prefixCut,
  };
}

/**
 * Whether the wallet signed a transaction: it is one of the message's STATIC
 * account keys, at an index below header.numRequiredSignatures. Every message
 * version puts its signers there, fee payer first: legacy, v0 and v1 alike.
 *
 * STATIC KEYS ONLY. A v0 message can load the wallet from an address lookup
 * table, and a loaded key follows every static key and never signs, so a wallet
 * named only through a table did not sign, whatever its balance did. The
 * signature list is not read: a response gives it as bare strings, with no key
 * beside any of them.
 */
function isSignedByWallet(message: VersionedMessage, wallet: PublicKey): boolean {
  const index = message.staticAccountKeys.findIndex((key) => key.equals(wallet));
  return index >= 0 && index < message.header.numRequiredSignatures;
}

/**
 * The wallet's balance before and after one transaction, and every program the
 * transaction touched, inner instructions included. Null when there is no meta
 * or the transaction does not name the wallet.
 */
function walletBalances(
  tx: VersionedTransactionResponse,
  wallet: PublicKey,
): { readonly pre: bigint; readonly post: bigint; readonly programs: ReadonlySet<string> } | null {
  if (!tx.meta) return null;
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta.loadedAddresses ?? undefined,
  });
  let index = -1;
  for (let i = 0; i < keys.length; i++) {
    if (keys.get(i)!.equals(wallet)) {
      index = i;
      break;
    }
  }
  if (index < 0) return null;

  const programs = new Set<string>();
  for (const ix of tx.transaction.message.compiledInstructions) {
    programs.add(keys.get(ix.programIdIndex)!.toBase58());
  }
  for (const inner of tx.meta.innerInstructions ?? []) {
    for (const ix of inner.instructions) programs.add(keys.get(ix.programIdIndex)!.toBase58());
  }
  return { pre: BigInt(tx.meta.preBalances[index]!), post: BigInt(tx.meta.postBalances[index]!), programs };
}
