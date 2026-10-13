// The takeover rule (src/worker-takeover.ts; ADR §3.6, safety §2.2 amendments
// 3–5): what a job does with the earlier fences' intents before it plans, the
// plan floor it then waits for, and the outbox a landed leg owes its history.
// Over the in-memory model of the store (test/memory-dispatch-store.ts) and a
// chain the test answers for.

import { Keypair, type VersionedTransactionResponse } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { IntentDraft } from "../src/dispatch-store.js";
import { USDC_MINT } from "../src/invest-decision.js";
import {
  FINALITY_SECONDS,
  investmentFromReceipt,
  resolvePriorIntents,
  secondsUntilFinalizedPasses,
  readFromSlot,
  waitForPlanFloor,
  type SeenStatus,
  type TakeoverChain,
} from "../src/worker-takeover.js";
import { MemoryDb, MemoryDispatchStore } from "./memory-dispatch-store.js";

const VAULT = Keypair.generate().publicKey.toBase58();

/** A chain whose heights and statuses the test sets. */
function chain(state: { finalized: bigint; confirmed: bigint; slot?: bigint; statuses?: Record<string, SeenStatus> }): TakeoverChain & { asked: string[][] } {
  const asked: string[][] = [];
  return {
    asked,
    finalizedHeight: async () => state.finalized,
    confirmedHeight: async () => state.confirmed,
    finalizedPoint: async () => ({ height: state.finalized, slot: state.slot ?? state.finalized + 20_000_000n }),
    statuses: async (signatures) => {
      asked.push([...signatures]);
      return signatures.map((signature) => state.statuses?.[signature] ?? null);
    },
  };
}

/** A vault an earlier holder (fence 1) gated `drafts` on, then lost; a successor now holds it at fence 2. */
async function takenOver(drafts: readonly Partial<IntentDraft>[], world: "live" | "shadow" = "live") {
  const db = new MemoryDb();
  db.addVault(VAULT);
  const old = new MemoryDispatchStore(db, "worker-old", world);
  const [first] = await old.claim(1);
  for (const draft of drafts) {
    const answer = await old.gateOneStatement({
      vault: VAULT,
      fence: first!.fence,
      kind: "wrap",
      link: null,
      blockhash: "bh",
      lastValidBlockHeight: 1_000n,
      planClearedHeight: null,
      signature: null,
      idempotencyKey: null,
      amountRaw: 1n,
      ...draft,
    });
    if (answer.kind !== "gated") throw new Error(`setup gate: ${answer.kind}`);
  }
  // THE OLD HOLDER DIES: its lease runs out and a successor claims.
  db.advance(46_000);
  const store = new MemoryDispatchStore(db, "worker-new", world);
  const [claimed] = await store.claim(1);
  return { db, store, claimed: claimed! };
}

const noHistory = async (): Promise<boolean> => {
  throw new Error("no leg here");
};

describe("resolvePriorIntents: the takeover rule", () => {
  it("is clear at once, with no floor, on a vault no earlier fence ever gated on — and asks the chain nothing", async () => {
    const db = new MemoryDb();
    db.addVault(VAULT);
    const store = new MemoryDispatchStore(db, "w");
    const [claimed] = await store.claim(1);
    const c = chain({ finalized: 1n, confirmed: 1n });
    const verdict = await resolvePriorIntents(store, claimed!, { ...c, finalizedHeight: async () => { throw new Error("not asked"); } }, noHistory);
    expect(verdict).toEqual({ kind: "clear", planFloor: null, resolved: 0 });
  });

  it("WAITS while an earlier send can still land — finalized height at or under its last valid one — and plans nothing", async () => {
    const { store, claimed, db } = await takenOver([{ lastValidBlockHeight: 1_000n, signature: "sig-in-flight" }]);
    const verdict = await resolvePriorIntents(store, claimed, chain({ finalized: 1_000n, confirmed: 990n }), noHistory);
    expect(verdict.kind).toBe("wait");
    if (verdict.kind !== "wait") return;
    // DUE ONCE THE FINALIZED HEIGHT SHOULD HAVE PASSED IT: 11 blocks at 0.4 s, then finality.
    expect(verdict.dueInSeconds).toBe(secondsUntilFinalizedPasses(1_000n, 990n));
    expect(verdict.dueInSeconds).toBe(Math.ceil(11 * 0.4 + FINALITY_SECONDS));
    expect(verdict.detail).toContain("can still land");
    expect(db.intents[0]).toMatchObject({ state: "intent", resolvedAt: null });
  });

  it("expires one the FINALIZED height has passed — at its last valid height — and then plans above it", async () => {
    const { store, claimed, db } = await takenOver([{ lastValidBlockHeight: 1_000n }]);
    const verdict = await resolvePriorIntents(store, claimed, chain({ finalized: 1_001n, confirmed: 1_040n }), noHistory);
    expect(verdict).toEqual({ kind: "clear", planFloor: 1_000n, resolved: 1 });
    expect(db.intents[0]).toMatchObject({ state: "expired", resolvedHeight: 1_000n });
  });

  it("NEVER expires on the confirmed height alone (amendment 3): confirmed past it, finalized not, is still a wait", async () => {
    const { store, claimed } = await takenOver([{ lastValidBlockHeight: 1_000n }]);
    expect((await resolvePriorIntents(store, claimed, chain({ finalized: 1_000n, confirmed: 1_100n }), noHistory)).kind).toBe("wait");
  });

  it("resolves a signed send by its status — landed or failed — at the confirmed height capped at its last valid one", async () => {
    const { store, claimed, db } = await takenOver([
      { signature: "sig-landed", lastValidBlockHeight: 1_000n },
      { signature: "sig-reverted", lastValidBlockHeight: 1_000n },
      { signature: "sig-processed", lastValidBlockHeight: 2_000n },
    ]);
    const c = chain({
      finalized: 900n,
      confirmed: 950n,
      statuses: {
        "sig-landed": { err: null, confirmationStatus: "finalized" },
        "sig-reverted": { err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" },
        // PROCESSED IS NOT AN ANSWER: a fork can drop it.
        "sig-processed": { err: null, confirmationStatus: "processed" },
      },
    });
    const verdict = await resolvePriorIntents(store, claimed, c, noHistory);
    expect(c.asked).toEqual([["sig-landed", "sig-reverted", "sig-processed"]]);
    expect(verdict.kind).toBe("wait");
    expect(db.intents.map((row) => [row.state, row.resolvedHeight])).toEqual([
      ["landed", 950n],
      ["failed", 950n],
      ["intent", null],
    ]);
  });

  it("makes a settle WITHOUT a signature wait out its blockhash, whatever its link's nonce says (amendment 5)", async () => {
    const link = Keypair.generate().publicKey.toBase58();
    const { store, claimed, db } = await takenOver([{ kind: "settle", link, lastValidBlockHeight: 1_000n, idempotencyKey: "k".repeat(64) }]);
    expect((await resolvePriorIntents(store, claimed, chain({ finalized: 999n, confirmed: 1_020n }), noHistory)).kind).toBe("wait");
    expect(db.intents[0]!.resolvedAt).toBeNull();
    expect(await resolvePriorIntents(store, claimed, chain({ finalized: 1_001n, confirmed: 1_020n }), noHistory)).toMatchObject({ kind: "clear", planFloor: 1_000n });
  });

  it("writes a landed LEG's history row BEFORE resolving it (the outbox, S-9); a row it cannot write leaves the leg open and the job waiting", async () => {
    const leg = { kind: "invest" as const, signature: "sig-leg", lastValidBlockHeight: 1_000n };
    const landed = { finalized: 900n, confirmed: 950n, statuses: { "sig-leg": { err: null, confirmationStatus: "confirmed" as const } } };

    const failing = await takenOver([leg]);
    const tried: string[] = [];
    const down = await resolvePriorIntents(failing.store, failing.claimed, chain(landed), async (intent) => (tried.push(intent.signature!), false));
    expect(tried).toEqual(["sig-leg"]);
    expect(down).toMatchObject({ kind: "wait", dueInSeconds: FINALITY_SECONDS });
    expect(failing.db.intents[0]!.resolvedAt).toBeNull();

    const working = await takenOver([leg]);
    const order: string[] = [];
    const resolve = working.store.resolveIntent.bind(working.store);
    working.store.resolveIntent = async (...args) => (order.push("resolve"), resolve(...args));
    const verdict = await resolvePriorIntents(working.store, working.claimed, chain(landed), async () => (order.push("history"), true));
    expect(order).toEqual(["history", "resolve"]);
    expect(verdict).toMatchObject({ kind: "clear", planFloor: 950n, resolved: 1 });
  });

  it("treats an open SHADOW row as a send that may still land: waited out by height, never asked about by signature", async () => {
    const { store, claimed, db } = await takenOver([{ lastValidBlockHeight: 1_000n }], "shadow");
    const c = chain({ finalized: 1_000n, confirmed: 1_000n });
    expect((await resolvePriorIntents(store, claimed, c, noHistory)).kind).toBe("wait");
    expect(c.asked).toEqual([]);
    expect(await resolvePriorIntents(store, claimed, chain({ finalized: 1_001n, confirmed: 1_001n }), noHistory)).toMatchObject({ kind: "clear", planFloor: 1_000n });
    // A SHADOW ROW STAYS 'shadow' WHEN IT IS RESOLVED.
    expect(db.intents[0]).toMatchObject({ state: "shadow", resolvedHeight: 1_000n });
  });
});

describe("waitForPlanFloor: no plan until the finalized height is ABOVE the floor", () => {
  it("returns at once with nothing to wait for", async () => {
    expect(await waitForPlanFloor(chain({ finalized: 5n, confirmed: 5n, slot: 77n }), null, { deadlineAt: 0, mayAct: () => null })).toMatchObject({ kind: "cleared", height: 5n, slot: 77n, finalizedSlot: 77n });
  });

  it("polls until the finalized height passes the floor — equal is not above — reading height and slot from ONE answer each time", async () => {
    let finalized = 1_000n;
    let now = 0;
    const reads: string[] = [];
    const c = { finalizedPoint: async () => (reads.push("point"), { height: finalized, slot: finalized + 3_242n }) };
    const wait = await waitForPlanFloor(c, 1_000n, {
      deadlineAt: 60_000,
      mayAct: () => null,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
        finalized += 1n;
      },
    });
    // JUST PAST THE FLOOR: the wait cleared at this very bank, so its slot is the read floor.
    expect(wait).toEqual({ kind: "cleared", height: 1_001n, slot: 4_243n, finalizedSlot: 4_243n, waitedMs: 2_000 });
    expect(reads).toEqual(["point", "point"]);
  });

  it("a floor passed long ago asks reads to reach the slot at which it was passed, not the newest finalized slot", async () => {
    // FINALIZED AT HEIGHT 6_100, SLOT 9_000; THE FLOOR IS 5_100. The block at height 5_101 is at least
    // 999 slots before slot 9_000 — so at or below 8_001 — and every earlier intent acted at or below 5_100.
    const wait = await waitForPlanFloor({ finalizedPoint: async () => ({ height: 6_100n, slot: 9_000n }) }, 5_100n, { deadlineAt: 0, mayAct: () => null });
    expect(wait).toEqual({ kind: "cleared", height: 6_100n, slot: 8_001n, finalizedSlot: 9_000n, waitedMs: 0 });
    expect(readFromSlot(5_100n, { height: 5_101n, slot: 9_000n })).toBe(9_000n);
    expect(readFromSlot(null, { height: 6_100n, slot: 9_000n })).toBe(9_000n);
    // NEVER BELOW THE CLEARING BLOCK'S SLOT, whatever the skipped slots: a chain with none puts it exactly there.
    for (const skipped of [0n, 7n, 400n]) {
      const slotOf = (height: bigint) => height * 2n + (height > 5_500n ? skipped : 0n);
      expect(readFromSlot(5_100n, { height: 6_100n, slot: slotOf(6_100n) }) >= slotOf(5_101n)).toBe(true);
    }
    expect(readFromSlot(5_100n, { height: 6_100n, slot: 6_100n })).toBe(5_101n);
  });

  it("gives up at the deadline, and stops the moment the job may no longer act", async () => {
    let now = 0;
    const stuck = { finalizedPoint: async () => ({ height: 10n, slot: 1n }) };
    expect(await waitForPlanFloor(stuck, 10n, { deadlineAt: 5_000, mayAct: () => null, now: () => now, sleep: async (ms) => void (now += ms) })).toEqual({ kind: "late", floor: 10n, finalized: 10n });
    expect(await waitForPlanFloor(stuck, 10n, { deadlineAt: 5_000, mayAct: () => "lease lost" })).toEqual({ kind: "blocked", reason: "lease lost" });
  });
});

describe("investmentFromReceipt: a landed leg's history row from its own receipt", () => {
  const vault = Keypair.generate().publicKey;
  const target = Keypair.generate().publicKey.toBase58();
  const balance = (accountIndex: number, mint: string, owner: string, amount: string) => ({ accountIndex, mint, owner, uiTokenAmount: { amount, decimals: 6, uiAmount: null, uiAmountString: amount } });
  const receipt = (pre: unknown[], post: unknown[], err: unknown = null) =>
    ({ slot: 333, meta: { err, preTokenBalances: pre, postTokenBalances: post } }) as unknown as VersionedTransactionResponse;

  it("reads what the vault's USDC lost and what its one other mint gained, at the receipt's slot", () => {
    const row = investmentFromReceipt(
      receipt(
        [balance(2, USDC_MINT.toBase58(), vault.toBase58(), "9000000"), balance(3, target, vault.toBase58(), "10"), balance(4, USDC_MINT.toBase58(), "pool", "1")],
        [balance(2, USDC_MINT.toBase58(), vault.toBase58(), "4000000"), balance(3, target, vault.toBase58(), "510"), balance(4, USDC_MINT.toBase58(), "pool", "5000001")],
      ),
      vault,
      "sig-leg",
    );
    expect(row).toEqual({ vaultAddr: vault.toBase58(), target, spentRaw: 5_000_000n, receivedRaw: 500n, txRef: "sig-leg", height: 333n });
  });

  it("says nothing for a reverted receipt, or one that does not show both halves of one purchase", () => {
    const usdc = (amount: string) => balance(2, USDC_MINT.toBase58(), vault.toBase58(), amount);
    expect(investmentFromReceipt(receipt([usdc("9")], [usdc("4")], { InstructionError: [0, "x"] }), vault, "s")).toBeNull();
    expect(investmentFromReceipt(receipt([usdc("9")], [usdc("4")]), vault, "s")).toBeNull();
    expect(investmentFromReceipt(receipt([usdc("9"), balance(3, target, vault.toBase58(), "0")], [usdc("9"), balance(3, target, vault.toBase58(), "5")]), vault, "s")).toBeNull();
  });
});

describe("secondsUntilFinalizedPasses", () => {
  it("is finality alone once the height is behind, and grows by a block's time per block ahead", () => {
    expect(secondsUntilFinalizedPasses(10n, 50n)).toBe(Math.ceil(0.4 + FINALITY_SECONDS));
    expect(secondsUntilFinalizedPasses(1_150n, 1_000n)).toBe(Math.ceil(151 * 0.4 + FINALITY_SECONDS));
    // ≤ ≈ 75 s for a whole blockhash life (ADR §3.6).
    expect(secondsUntilFinalizedPasses(1_150n, 1_000n)).toBeLessThanOrEqual(75);
  });
});


