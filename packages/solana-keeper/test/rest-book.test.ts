// The `rest-skip` cut (C4): a link resting on its own settle skips the walk.
//
// THE CLAIM UNDER TEST IS AN EQUALITY. With the RestBook, a turn returns exactly
// what it returns without it — outcome, detail and every other field — and asks
// the chain for no more than it did; a link resting on its own settle asks for
// one call where it asked for three. The deterministic cases pin each way a memo
// must be refused (a new signature, a moved link, a settle the walk could not see
// finalized yet, a cut prefix); the property at the end runs the same turns over
// random histories, both ways, and compares every result.
//
// THE CHAIN IS A SMALL WORLD, not a fixture (test/settle-world.ts): a wallet's
// ledger that grows as trades, a stranger's transfers and our own settles land, a
// confirmed tip the probe reads, a finalized slot the walk reads up to, and a link
// whose frontier and nonce move when a settle lands. Every turn runs the real
// runSettleTick, dry, over a Proxy Connection that serves only what a turn asks
// for and records every call, as test/settle-tick.test.ts's chain does.

import { describe, expect, it } from "vitest";
import type { ManagedLink } from "../src/discovery.js";
import { MAX_SIGNATURES } from "../src/measure-window.js";
import { MODE_PROFIT, MODE_VOLUME } from "../src/program-scripts.js";
import { RestBook } from "../src/rest-book.js";
import { SettleWorld, WorldKeeper, rng } from "./settle-world.js";

type World = SettleWorld;

/** A dry-run keeper over `world`, with `restBook` or none (test/settle-world.ts). */
const keeperOf = (world: World, restBook: RestBook | undefined, mode: number = MODE_PROFIT): WorldKeeper =>
  new WorldKeeper(world, { ...(restBook === undefined ? {} : { restBook }), mode });

/** A world whose link settled once and rests on that settle, finalized: a trade, the settle of it, finality past both. */
function restingWorld(): World {
  const world = new SettleWorld();
  world.trade(1_000_000_000);
  world.finalizeTo(world.tip);
  expect(world.settleLands(200_000_000)).toBe(true);
  world.finalizeTo(world.tip);
  return world;
}

const restingDetail = (world: World) => `only our own settle since slot ${world.link.frontierSlot}; nothing to charge`;

describe("a link resting on its own settle", () => {
  it("costs the probe, getSlot and a page (+2 cold reads) on its first turn, then the probe alone, with the same outcome and detail", async () => {
    const world = restingWorld();
    const book = new RestBook();
    const keeper = keeperOf(world, book);

    const first = await keeper.turn();
    expect(first.result).toEqual({ outcome: "IDLE", detail: restingDetail(world) });
    expect(first.calls).toEqual(["getSignaturesForAddress", "getSlot", "getSignaturesForAddress", "getTransaction", "getTransaction"]);
    expect(book.status()).toEqual({ memos: 1, skips: 0, recorded: 1, invalidated: 0 });

    for (let sweep = 0; sweep < 3; sweep++) {
      const next = await keeper.turn();
      expect(next.result).toEqual(first.result);
      expect(next.calls).toEqual(["getSignaturesForAddress"]);
    }
    expect(book.status()).toEqual({ memos: 1, skips: 3, recorded: 1, invalidated: 0 });

    // WITHOUT THE BOOK, every sweep walks: 3 calls once the walk cache is warm.
    const today = keeperOf(world, undefined);
    await today.turn();
    expect((await today.turn()).calls).toEqual(["getSignaturesForAddress", "getSlot", "getSignaturesForAddress"]);
  });

  it("walks again on a new signature, and decides exactly as a keeper without the book", async () => {
    for (const land of [
      (world: World) => world.trade(400_000_000),
      (world: World) => world.trade(-400_000_000),
      (world: World) => world.transfer(),
    ]) {
      const world = restingWorld();
      const book = new RestBook();
      const keeper = keeperOf(world, book);
      await keeper.turn();
      land(world);
      world.finalizeTo(world.tip);
      const walked = await keeper.turn();
      const today = await keeperOf(world, undefined).turn();
      expect(walked.result).toEqual(today.result);
      expect(walked.calls.slice(0, 3)).toEqual(["getSignaturesForAddress", "getSlot", "getSignaturesForAddress"]);
      expect(book.status()).toMatchObject({ invalidated: 1, memos: 0 });
    }
  });

  it("walks again when the link moved under the same newest signature: a nonce, a frontier or an epoch", async () => {
    for (const move of [
      (link: ManagedLink): ManagedLink => ({ ...link, settlementNonce: link.settlementNonce + 1n }),
      (link: ManagedLink): ManagedLink => ({ ...link, frontierSlot: link.frontierSlot - 1n }),
      (link: ManagedLink): ManagedLink => ({ ...link, epoch: link.epoch + 1n }),
    ]) {
      const world = restingWorld();
      const book = new RestBook();
      const keeper = keeperOf(world, book);
      await keeper.turn();
      world.link = move(world.link);
      const walked = await keeper.turn();
      expect(walked.calls.length, "a moved link walks").toBeGreaterThan(1);
      expect(walked.result).toEqual((await keeperOf(world, undefined).turn()).result);
      expect(book.status().invalidated).toBe(1);
    }
  });

  it("records nothing while the probe's newest signature is not finalized, whatever the walk ended at", async () => {
    // OUR SETTLE CONFIRMED, NOT FINAL: the walk sees nothing above the frontier and waits.
    const pending = new SettleWorld();
    pending.trade(1_000_000_000);
    pending.finalizeTo(pending.tip);
    pending.settleLands(200_000_000);
    const pendingBook = new RestBook();
    const atPending = await keeperOf(pending, pendingBook).turn();
    expect(atPending.result.outcome).toBe("PENDING_FINALITY");
    expect(pendingBook.status().recorded).toBe(0);

    // OUR SETTLE FINAL, A TRADE ABOVE IT ONLY CONFIRMED: the walk reaches the loop
    // guard over the settle alone, but the probe saw the trade, so nothing is
    // remembered — the next turn must walk and find the trade once it is final.
    const above = restingWorld();
    above.trade(300_000_000);
    const book = new RestBook();
    const keeper = keeperOf(above, book);
    const guard = await keeper.turn();
    expect(guard.result).toEqual({ outcome: "IDLE", detail: restingDetail(above) });
    expect(book.status().recorded).toBe(0);
    above.finalizeTo(above.tip);
    const found = await keeper.turn();
    expect(found.result.outcome).toBe("SETTLED");
    expect(found.result.detail.startsWith("DRY RUN — would settle")).toBe(true);
  });

  it("never records a cut prefix, even one of nothing but our own settles", async () => {
    // MORE THAN MAX_SIGNATURES OF OUR OWN SETTLES ABOVE THE FRONTIER: the loop guard
    // does not apply to a cut prefix, so the span is decided — and remembered never.
    for (const mode of [MODE_PROFIT, MODE_VOLUME]) {
      const world = restingWorld();
      for (let i = 0; i < MAX_SIGNATURES; i++) world.ownSettle(1);
      world.finalizeTo(world.tip);
      const book = new RestBook();
      const keeper = keeperOf(world, book, mode);
      const first = await keeper.turn();
      expect(first.result.detail, `mode ${mode}`).toContain("backlog: settling the oldest 300");
      const second = await keeper.turn();
      expect(second.result).toEqual(first.result);
      expect(second.calls.length, "a cut prefix walks every turn").toBeGreaterThan(1);
      expect(book.status().recorded, `mode ${mode}`).toBe(0);
    }
  });

  it("forgets every memo on a restart, and a link pruned from the sweep: the first turn after either walks", async () => {
    const world = restingWorld();
    const book = new RestBook();
    await keeperOf(world, book).turn();
    expect(book.status().memos).toBe(1);

    // A RESTART IS A NEW BOOK.
    const restarted = await keeperOf(world, new RestBook()).turn();
    expect(restarted.calls).toContain("getSlot");

    // A PRUNE KEEPS ONLY THE LINKS THE SWEEP DISCOVERED, by link address.
    book.prune(new Set([world.link.linkAddress.toBase58()]));
    expect(book.status().memos).toBe(1);
    book.prune(new Set());
    expect(book.status().memos).toBe(0);
    const afterPrune = await keeperOf(world, book).turn();
    expect(afterPrune.calls).toContain("getSlot");
  });
});

describe("the memo changes no outcome (differential property over random histories)", () => {
  it("returns, turn for turn, exactly what a keeper without the book returns, and never asks for more", async () => {
    const HISTORIES = 120;
    const STEPS = 60;
    let skipped = 0;
    let savedCalls = 0;
    for (let seed = 1; seed <= HISTORIES; seed++) {
      const random = rng(seed);
      const world = new SettleWorld();
      const mode = random() < 0.75 ? MODE_PROFIT : MODE_VOLUME;
      const book = new RestBook();
      const withBook = keeperOf(world, book, mode);
      const without = keeperOf(world, undefined, mode);
      for (let step = 0; step < STEPS; step++) {
        const roll = random();
        if (roll < 0.08) world.trade(Math.round((random() - 0.4) * 1_000_000_000), random() < 0.2);
        else if (roll < 0.12) world.transfer(random() < 0.2);
        else if (roll < 0.24) world.settleLands(Math.round(random() * 100_000_000));
        else if (roll < 0.25) world.relink();
        else if (roll < 0.37) world.finalizeTo(world.finalized + 1 + Math.floor(random() * 4));
        else if (roll < 0.45) world.finalizeTo(world.tip);
        else {
          const a = await withBook.turn();
          const b = await without.turn();
          const where = `seed ${seed}, step ${step}`;
          expect(a.result, where).toEqual(b.result);
          expect(a.calls.length, where).toBeLessThanOrEqual(b.calls.length);
          savedCalls += b.calls.length - a.calls.length;
        }
      }
      skipped += book.status().skips;
      expect(withBook.calls.length, `seed ${seed}`).toBeLessThanOrEqual(without.calls.length);
    }
    // THE PROPERTY IS NOT VACUOUS: the histories rested on their own settles often
    // enough for the memo to answer, and each answer saved the walk's calls.
    expect(skipped).toBeGreaterThan(100);
    expect(savedCalls).toBeGreaterThanOrEqual(2 * skipped);
  });
});
