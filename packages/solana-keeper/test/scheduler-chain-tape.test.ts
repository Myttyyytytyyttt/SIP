// The price tape costs no extra call (ADR §5.2.3): with SIP_SOLANA_PRICE_TAPE on,
// the scheduler's snapshot reads the program account and Pyth's SOL/USD in ONE
// getMultipleAccounts where it used to make one getAccountInfo; off — the
// default, and every legacy keeper — the snapshot makes exactly the calls it
// always made, in the same order.

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, type Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { readChainSnapshot } from "../src/chain-state.js";
import { idl } from "../src/idl.js";
import { PYTH_SOL_USD_FEED } from "../src/pyth.js";
import { createSchedulerChain } from "../src/scheduler-chain.js";

const programId = new PublicKey(idl.address);

/** A connection that records each call and its account keys, and answers "no account" to every one. */
function recording() {
  const calls: { method: string; keys: string[] }[] = [];
  const connection = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop !== "string" || prop === "then") return undefined;
        return async (...args: unknown[]) => {
          const first = args[0];
          const keys = Array.isArray(first) ? first.map((key: PublicKey) => key.toBase58()) : first instanceof PublicKey ? [first.toBase58()] : [];
          calls.push({ method: prop, keys });
          switch (prop) {
            case "getAccountInfo":
              return { executable: true, owner: programId, lamports: 1, data: Buffer.alloc(36), rentEpoch: 0 };
            case "getMultipleAccountsInfoAndContext":
              return { context: { slot: 77 }, value: [{ executable: true, owner: programId, lamports: 1, data: Buffer.alloc(36), rentEpoch: 0 }, null] };
            case "getAccountInfoAndContext":
              return { context: { slot: 77 }, value: null };
            default:
              throw new Error(`unexpected RPC call: ${prop}`);
          }
        };
      },
    },
  ) as Connection;
  const refuse = async (): Promise<never> => Promise.reject(new Error("no"));
  const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse }, {}));
  return { connection, program, calls };
}

describe("the snapshot's first request", () => {
  it("off: one getAccountInfo for the program, as always, and no `also`", async () => {
    const r = recording();
    const snapshot = await readChainSnapshot(r.connection, r.program);
    expect(r.calls.map((c) => c.method)).toEqual(["getAccountInfo", "getAccountInfoAndContext"]);
    expect(r.calls[0]!.keys).toEqual([programId.toBase58()]);
    expect(snapshot).not.toHaveProperty("also");
    expect(snapshot.programDeployed).toBe(true);
    // And the scheduler's chain without the tape is that same read.
    const s = recording();
    await createSchedulerChain({ connection: s.connection, program: s.program, discriminator: Buffer.alloc(8), gpaV2: false, rpc: fetch }).snapshot();
    expect(s.calls.map((c) => c.method)).toEqual(["getAccountInfo", "getAccountInfoAndContext"]);
  });

  it("on: the program and Pyth's SOL/USD in ONE getMultipleAccounts, the same number of calls, the account returned as `also`", async () => {
    const r = recording();
    const snapshot = await createSchedulerChain({ connection: r.connection, program: r.program, discriminator: Buffer.alloc(8), gpaV2: false, rpc: fetch, priceTape: true }).snapshot();
    expect(r.calls.map((c) => c.method)).toEqual(["getMultipleAccountsInfoAndContext", "getAccountInfoAndContext"]);
    expect(r.calls[0]!.keys).toEqual([programId.toBase58(), PYTH_SOL_USD_FEED.toBase58()]);
    expect(snapshot.programDeployed).toBe(true);
    expect(snapshot.also).toEqual({ info: null, slot: 77 });
  });

  it("on, a read that fails: the program is unreadable as before, and `also` is null", async () => {
    const r = recording();
    const failing = new Proxy(r.connection as object, {
      get: (target, prop) => (prop === "getMultipleAccountsInfoAndContext" ? async () => Promise.reject(new Error("503")) : (target as Record<string | symbol, unknown>)[prop]),
    }) as Connection;
    const snapshot = await readChainSnapshot(failing, r.program, { alsoRead: Keypair.generate().publicKey });
    expect(snapshot.programDeployed).toBeNull();
    expect(snapshot.also).toBeNull();
    expect(snapshot.errors[0]).toMatch(/program account unreadable/);
  });
});
