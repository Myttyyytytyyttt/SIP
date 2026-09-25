// The volume rule (src/measure-volume.ts) over REAL mainnet transactions, decoded
// by web3.js through the keeper's own readTransaction (test/volume-fixtures.ts).
//
// THE VECTOR IS THE OWNER'S. His four Axiom trades of 2026-09-23 (pump.fun,
// transaction version 1) and our settle of 2026-09-19 are the numbers
// reports/VOLUME_KEEPER_PLAN_2026-09-25.md put in front of him, to the lamport.
// Each rule has a case here that changes its answer when the rule is removed.

import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { SIP_PROGRAM_ID } from "../src/idl.js";
import { tradeNotional, type TradeNotional } from "../src/measure-volume.js";
import { FIXTURES, fixtureTransaction } from "./volume-fixtures.js";

const measure = async (name: string, as?: string): Promise<TradeNotional> => {
  const { tx, wallet } = await fixtureTransaction(name);
  return tradeNotional(tx, as === undefined ? wallet : new PublicKey(as), SIP_PROGRAM_ID);
};

/** The owner's four trades of 2026-09-23, in the order he made them, with what each traded. */
const OWNER_TRADES = [
  ["owner-buy-1", 1_010_000_000n],
  ["owner-sell-1", 1_010_896_197n],
  ["owner-buy-2", 959_647_432n],
  ["owner-sell-2", 1_077_776_111n],
] as const;

describe("the owner's four trades of 2026-09-23", () => {
  for (const [name, lamports] of OWNER_TRADES) {
    it(`${name} traded ${lamports} lamports`, async () => {
      expect(await measure(name)).toEqual({ counted: true, lamports });
    });
  }

  it("add up to 4.058319740 SOL, the figure in the report", async () => {
    let total = 0n;
    for (const [name] of OWNER_TRADES) {
      const traded = await measure(name);
      if (traded.counted) total += traded.lamports;
    }
    expect(total).toBe(4_058_319_740n);
  });

  // THE FEE AND THE RENT, each pinned by what it is worth. Without the fee put
  // back, every trade moves by 1 005 000 lamports; without the rent taken out, the
  // first buy counts the 1 513 840 lamports its new token account cost.
  it("puts back the 1 005 000-lamport network fee the wallet paid on each trade", async () => {
    const { tx } = await fixtureTransaction("owner-sell-1");
    expect(tx.meta?.fee).toBe(1_005_000);
    const lamportsIn = BigInt(tx.meta!.postBalances[0]!) - BigInt(tx.meta!.preBalances[0]!);
    expect(await measure("owner-sell-1")).toEqual({ counted: true, lamports: lamportsIn + 1_005_000n });
  });

  it("takes out the rent of the token account the first buy opened", async () => {
    const { tx } = await fixtureTransaction("owner-buy-1");
    const lamportsOut = BigInt(tx.meta!.preBalances[0]!) - BigInt(tx.meta!.postBalances[0]!);
    expect(lamportsOut - 1_005_000n - 1_513_840n).toBe(1_010_000_000n);
    expect(await measure("owner-buy-1")).toEqual({ counted: true, lamports: 1_010_000_000n });
  });

  it("is version 1, which is what the walk reads it as", async () => {
    const { tx } = await fixtureTransaction("owner-buy-1");
    expect(tx.version).toBe(1);
  });
});

describe("what is not volume", () => {
  it("our own settle is an external flow", async () => {
    expect(await measure("owner-settle-2026-09-19")).toEqual({ counted: false, skip: "flow" });
  });

  it("a tip account paid inside the owner's buy did not sign it, so its 0.01 SOL is nobody's volume", async () => {
    expect(await measure("owner-buy-1", "DZfEurFKFtSbdWZsKSDTqpqsQgvXxmESpvRtXkAdgLwM")).toEqual({ counted: false, skip: "not-signed" });
  });

  it("a wallet the transaction does not name traded nothing in it", async () => {
    expect(await measure("owner-buy-1", "11111111111111111111111111111112")).toEqual({ counted: false, skip: "not-named" });
  });

  // THE TRAPS, each a real mainnet transaction found on 2026-09-25 (skipped when
  // the fixture set does not carry one).
  const traps: readonly (readonly [string, string])[] = [
    ["wrap", "no-sol-leg"],
    ["unwrap", "no-sol-leg"],
    ["memo-transfer", "no-counter-leg"],
    ["failed-swap", "failed"],
    ["usdc-to-token-swap", "no-sol-leg"],
  ];
  for (const [name, skip] of traps) {
    it.skipIf(FIXTURES[name] === undefined)(`${name}: ${skip}`, async () => {
      expect(await measure(name)).toEqual({ counted: false, skip });
    });
  }
});
