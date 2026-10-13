// THE TAKEOVER RULE: what a worker job does with the earlier fences' intents
// before it plans anything (dispatcher ADR §3.6; safety §2.2 amendments 3–5;
// plan P3a Q3). And the outbox a landed leg owes its history (S-9).
//
// AT JOB START, every open intent of an earlier fence of this vault is looked at,
// oldest first:
//   * ONE WITH A SIGNATURE — every crank send, and a settle once Privy answered —
//     is asked about with getSignatureStatuses, history included: confirmed or
//     finalized without an error is LANDED, with one is FAILED (it landed and
//     changed nothing). A landed leg first gets its history row (the outbox,
//     below), then is resolved, so a worker that dies in between leaves it for
//     the next one, and tx_ref's UNIQUE makes the row exactly one.
//   * ANY OTHER, and one whose status says nothing yet, can still land until the
//     FINALIZED height passes its last valid block height (amendment 3: at the
//     confirmed height "not landed" is only likely). Past it, it is EXPIRED.
//   * A SETTLE WITHOUT A SIGNATURE WAITS LIKE THE REST. The ADR resolves one as
//     soon as the link's nonce has moved; the intent row does not record the
//     nonce it was planned from, so this rule cannot tell "moved by it" from
//     "moved before it", and takes the wait instead — always the safe direction
//     (amendment 5: a successor that plans while the old settle can land would
//     erase its carry), and at most one blockhash life plus finality.
// Anything still able to land ends the job UNCHANGED, due once the finalized
// height should have passed it (≤ ≈ 75 s), so the lease is not held while waiting.
//
// THEN THE PLAN FLOOR (PriorIntents.planFloor): no plan until the finalized
// height is ABOVE the last height at which any earlier intent could act. The
// store's gate refuses an intent whose plan_cleared_height is not above it, so a
// job that skipped this wait could not send anyway; this is the wait itself. A
// send that landed a moment ago is waited out to finality, about 13 s.
//
// AND THE SLOT EVERY LATER READ MUST REACH (ADR §3.6 step 4): the slot at which
// that wait cleared — where the finalized height first passed the floor — NOT the
// finalized slot of whenever this job happened to look. A floor passed long ago
// (any vault that has ever gated an intent has one) asked every read to come from
// the newest finalized slot, and a load-balanced endpoint whose node was behind
// it refused (-32016): in the 55-minute local shadow of 2026-10-13, 2 of the 13
// jobs on the owner's vault after its first intents ended THREW, 6 and 13 minutes
// after the one job that gated them. The slot is computed from ONE answer that
// names the finalized bank's height and slot together (getEpochInfo at finalized,
// TakeoverChain.finalizedPoint): blocks are at least a slot apart, so the block
// at height floor + 1 is at most (height − floor − 1) slots before that bank's
// slot, and
//   readFrom = slot − (height − floor − 1)
// is never below it. Every earlier intent acted at a height ≤ floor, so a node
// that has reached readFrom has seen all of it; a node behind it is refused, as
// before. Just past the floor, readFrom is the finalized slot itself.
//
// RESOLVED HEIGHTS ARE UPPER BOUNDS, NEVER GUESSES. A status carries a SLOT, and
// the floor is a block HEIGHT; the two differ by every skipped slot since
// genesis. So a landed or failed intent is resolved at the confirmed height read
// now, capped at its own last valid height — the block it landed in is at or
// below both — and an expired one at its last valid height.

import { PublicKey, type Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import { summarizeUpstreamError } from "@sip/solana-log";
import type { DispatchStore, HeldVault, IntentOutcome, OpenIntent } from "./dispatch-store.js";
import { USDC_MINT } from "./invest-decision.js";
import { readTransaction } from "./measure-window.js";
import type { InvestmentRow } from "./read-model.js";

/** ≈ 32 slots of finality at 0.37–0.40 s a slot (ADR §3.6, ASSUMED there), rounded up. */
export const FINALITY_SECONDS = 13;
/** One block's time for the arithmetic of "when will the finalized height pass this one" (ADR §3.6, ASSUMED there). */
export const SECONDS_PER_BLOCK = 0.4;
/** How often a job asks for the finalized height while it waits for its plan floor. */
export const PLAN_FLOOR_POLL_MS = 2_000;

/** What a status read says about one signature. */
export interface SeenStatus {
  readonly err: unknown;
  readonly confirmationStatus: "processed" | "confirmed" | "finalized" | null;
}

/** The chain reads the takeover makes, through the job's connection (src/job-chain.ts). */
export interface TakeoverChain {
  finalizedHeight(): Promise<bigint>;
  confirmedHeight(): Promise<bigint>;
  /**
   * The finalized bank's block height and slot, from ONE answer (getEpochInfo at
   * finalized): the pair the plan floor's read slot is computed from. Two reads
   * could come from two nodes, and a slot from a node behind the height's would
   * put that slot too low.
   */
  finalizedPoint(): Promise<{ readonly height: bigint; readonly slot: bigint }>;
  /** getSignatureStatuses with history, in order; null where the node knows nothing. */
  statuses(signatures: readonly string[]): Promise<readonly (SeenStatus | null)[]>;
}

/** The history row a landed leg owes, written by whoever resolves it (S-9); false when it could not be written. */
export type LegOutbox = (intent: Pick<OpenIntent, "vault" | "signature">) => Promise<boolean>;

export type TakeoverVerdict =
  /** Nothing earlier can still act: plan once the finalized height is above `planFloor` (null: no earlier intent at all). */
  | { readonly kind: "clear"; readonly planFloor: bigint | null; readonly resolved: number }
  /** Something earlier can still land, or owes a history row this job could not write: complete unchanged, due later. */
  | { readonly kind: "wait"; readonly dueInSeconds: number; readonly detail: string; readonly resolved: number };

/** What the takeover needs of the store. */
export type TakeoverStore = Pick<DispatchStore, "priorIntents" | "resolveIntent">;

/** Seconds until the finalized height should have passed `height`, from the confirmed height now. */
export function secondsUntilFinalizedPasses(height: bigint, confirmed: bigint): number {
  const blocks = height > confirmed ? Number(height - confirmed) : 0;
  return Math.ceil((blocks + 1) * SECONDS_PER_BLOCK + FINALITY_SECONDS);
}

const landedStatus = (status: SeenStatus | null): "landed" | "failed" | null => {
  if (status === null) return null;
  // PROCESSED IS NOT AN ANSWER: a fork can drop it, as the sender's own watch says.
  if (status.confirmationStatus !== "confirmed" && status.confirmationStatus !== "finalized") return null;
  return status.err === null || status.err === undefined ? "landed" : "failed";
};

/**
 * The takeover rule over every open intent of an earlier fence (the header).
 * Throws only what the store or the chain threw before anything was resolved
 * that it could not stand behind; the job's catch then ends it RETRY, and the
 * next claim runs this again from what is in the rows.
 */
export async function resolvePriorIntents(
  store: TakeoverStore,
  held: HeldVault,
  chain: TakeoverChain,
  outbox: LegOutbox,
): Promise<TakeoverVerdict> {
  const prior = await store.priorIntents(held);
  if (prior.open.length === 0) return { kind: "clear", planFloor: prior.planFloor, resolved: 0 };

  const signed = prior.open.filter((intent) => intent.signature !== null);
  const statuses = signed.length === 0 ? [] : await chain.statuses(signed.map((intent) => intent.signature!));
  const statusOf = new Map(signed.map((intent, index) => [intent.id, statuses[index] ?? null] as const));
  const finalized = await chain.finalizedHeight();
  let confirmed: bigint | null = null;
  const confirmedNow = async (): Promise<bigint> => (confirmed ??= await chain.confirmedHeight());

  let resolved = 0;
  const stillOpen: OpenIntent[] = [];
  let historyOwed = 0;
  for (const intent of prior.open) {
    const seen = landedStatus(statusOf.get(intent.id) ?? null);
    let outcome: IntentOutcome | null = null;
    let height: bigint | null = null;
    if (seen !== null) {
      // THE OUTBOX FIRST: a landed leg's row, then its resolution. A shadow row never sent anything.
      if (seen === "landed" && intent.kind === "invest" && intent.state !== "shadow" && !(await outbox(intent))) {
        historyOwed += 1;
        continue;
      }
      const now = await confirmedNow();
      outcome = seen;
      height = now < intent.lastValidBlockHeight ? now : intent.lastValidBlockHeight;
    } else if (finalized > intent.lastValidBlockHeight) {
      outcome = "expired";
      height = intent.lastValidBlockHeight;
    }
    if (outcome === null || height === null) {
      stillOpen.push(intent);
      continue;
    }
    await store.resolveIntent(intent.id, outcome, height);
    resolved += 1;
  }

  if (stillOpen.length > 0 || historyOwed > 0) {
    const latest = stillOpen.reduce((max, intent) => (intent.lastValidBlockHeight > max ? intent.lastValidBlockHeight : max), 0n);
    const dueInSeconds = stillOpen.length > 0 ? secondsUntilFinalizedPasses(latest, await confirmedNow()) : FINALITY_SECONDS;
    const parts = [
      ...(stillOpen.length > 0
        ? [
            `${stillOpen.length} transaction(s) an earlier holder sent can still land, until the finalized height passes ${latest}; ` +
              "nothing is planned before then",
          ]
        : []),
      ...(historyOwed > 0 ? [`${historyOwed} landed leg(s) whose history row could not be written yet; resolved once it is`] : []),
    ];
    return { kind: "wait", dueInSeconds, detail: parts.join("; "), resolved };
  }
  const after = await store.priorIntents(held);
  return { kind: "clear", planFloor: after.planFloor, resolved };
}

export type PlanFloorWait =
  /**
   * The finalized height passed the floor: plan at `height`, and read at least
   * `slot` from here on — the slot at which the wait cleared (the header), at
   * most the finalized `finalizedSlot` this read saw.
   */
  | { readonly kind: "cleared"; readonly height: bigint; readonly slot: bigint; readonly finalizedSlot: bigint; readonly waitedMs: number }
  /** The floor was not passed before the job had to stop waiting: complete unchanged, due again soon. */
  | { readonly kind: "late"; readonly floor: bigint; readonly finalized: bigint }
  /** The job may no longer act (its lease, its ceiling, a drain): stop. */
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * The slot a job's reads must reach once the finalized bank (`height`, `slot`) is
 * above `floor`: the slot at which the finalized height first passed it, never
 * above (the header). Null floor: the bank's own slot.
 */
export function readFromSlot(floor: bigint | null, point: { readonly height: bigint; readonly slot: bigint }): bigint {
  if (floor === null || point.height <= floor + 1n) return point.slot;
  return point.slot - (point.height - floor - 1n);
}

/**
 * Waits until the finalized height is ABOVE `floor` (null: no earlier intent —
 * nothing to wait for). Polls every PLAN_FLOOR_POLL_MS, gives up at `deadlineAt`,
 * and stops the moment mayAct says the job may not go on.
 */
export async function waitForPlanFloor(
  chain: Pick<TakeoverChain, "finalizedPoint">,
  floor: bigint | null,
  options: {
    readonly deadlineAt: number;
    readonly mayAct: () => string | null;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  },
): Promise<PlanFloorWait> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  for (;;) {
    const blocked = options.mayAct();
    if (blocked !== null) return { kind: "blocked", reason: blocked };
    const point = await chain.finalizedPoint();
    const finalized = point.height;
    if (floor === null || finalized > floor) {
      return { kind: "cleared", height: finalized, slot: readFromSlot(floor, point), finalizedSlot: point.slot, waitedMs: now() - started };
    }
    if (now() + PLAN_FLOOR_POLL_MS > options.deadlineAt) return { kind: "late", floor, finalized };
    await sleep(PLAN_FLOOR_POLL_MS);
  }
}

/**
 * A landed leg's history row, from its own receipt: what the vault's USDC account
 * lost is what was spent, and the one other mint whose vault-owned account grew
 * is what was bought and how much. Null when the receipt does not say both — a
 * row this cannot stand behind is not written.
 *
 * THE SAME COLUMNS THE SENDER WRITES (bin/keeper.mts from InvestResult.purchases):
 * the target mint, spent and received in raw units, the signature, and the slot.
 */
export function investmentFromReceipt(receipt: VersionedTransactionResponse, vault: PublicKey, signature: string): InvestmentRow | null {
  const meta = receipt.meta;
  if (meta === null || meta === undefined || meta.err !== null) return null;
  const owner = vault.toBase58();
  const usdc = USDC_MINT.toBase58();
  const amounts = new Map<string, { pre: bigint; post: bigint }>();
  const add = (balances: typeof meta.preTokenBalances, which: "pre" | "post"): void => {
    for (const balance of balances ?? []) {
      if (balance.owner !== owner) continue;
      const key = `${balance.accountIndex}:${balance.mint}`;
      const entry = amounts.get(key) ?? { pre: 0n, post: 0n };
      entry[which] = BigInt(balance.uiTokenAmount.amount);
      amounts.set(key, entry);
    }
  };
  add(meta.preTokenBalances, "pre");
  add(meta.postTokenBalances, "post");
  let spent = 0n;
  const bought: { mint: string; amount: bigint }[] = [];
  for (const [key, { pre, post }] of amounts) {
    const mint = key.slice(key.indexOf(":") + 1);
    if (mint === usdc) spent += pre - post;
    else if (post > pre) bought.push({ mint, amount: post - pre });
  }
  if (spent <= 0n || bought.length !== 1) return null;
  return { vaultAddr: owner, target: bought[0]!.mint, spentRaw: spent, receivedRaw: bought[0]!.amount, txRef: signature, height: BigInt(receipt.slot) };
}

/**
 * The outbox for a landed leg nobody wrote: its receipt read at "confirmed" and
 * the row recorded through `record` (the read model's INSERT … ON CONFLICT
 * (tx_ref) DO NOTHING, so a row the sender already wrote is not doubled).
 *
 * A RECEIPT THAT READS, BUT DOES NOT SAY A PURCHASE, IS NOT A REASON TO HOLD THE
 * VAULT: the leg landed and money moved; the row is skipped with a warning and
 * the intent is resolved, because a vault parked forever over a history row is
 * money that stops moving. A receipt that does not read at all, or a write that
 * fails, keeps the intent open, and the next claim tries again.
 */
export function legOutbox(
  connection: Connection,
  record: (row: InvestmentRow) => Promise<boolean>,
  warn: (message: string, fields: Record<string, unknown>) => void,
): LegOutbox {
  return async (intent) => {
    if (intent.signature === null) return false;
    let receipt: VersionedTransactionResponse | null;
    try {
      receipt = await readTransaction(connection, intent.signature, "confirmed");
    } catch (error) {
      warn("a landed leg's receipt could not be read; its history row waits", { signature: intent.signature, detail: summarizeUpstreamError(error) });
      return false;
    }
    if (receipt === null) return false;
    const row = investmentFromReceipt(receipt, new PublicKey(intent.vault), intent.signature);
    if (row === null) {
      warn("a landed leg's receipt names no single purchase for the vault; no history row is written for it", { signature: intent.signature, vault: intent.vault });
      return true;
    }
    return record(row);
  };
}
