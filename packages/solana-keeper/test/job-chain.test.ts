// A worker job's own view of the chain (src/job-chain.ts): after a takeover,
// every read carries minContextSlot ≥ the slot at which the job's wait cleared,
// and an answer from behind it is a refusal, never a state to plan from (ADR
// §3.6 step 4, §4.9 row 10: "after a takeover every balance read carries
// minContextSlot"). And the job's one fresh read of its vault.

import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { configAddress } from "../src/accounts.js";
import { accountDiscriminator, idl } from "../src/idl.js";
import { MIN_CONTEXT_NOT_REACHED, MIN_CONTEXT_RETRIES, MIN_CONTEXT_RETRY_MS, byLinkAddress, createJobChain, minContextFetch } from "../src/job-chain.js";

type Rpc = { method: string; params: unknown[]; id: number; jsonrpc: string };

/** A transport that records every request body and answers from `answer`. */
function transport(answer: (request: Rpc) => unknown) {
  const bodies: unknown[] = [];
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    const one = (request: Rpc) => ({ jsonrpc: "2.0", id: request.id, result: answer(request) });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetcher, bodies };
}

const post = (fetcher: typeof fetch, body: unknown) => fetcher("http://rpc", { method: "POST", body: JSON.stringify(body) });

describe("minContextFetch: the takeover's floor on every read", () => {
  it("changes NOTHING before a floor is set: the same body, the same answer", async () => {
    const t = transport(() => ({ context: { slot: 1 }, value: 5 }));
    const fetcher = minContextFetch(t.fetcher, () => null);
    const body = { jsonrpc: "2.0", id: 1, method: "getBalance", params: ["x", { commitment: "confirmed" }] };
    const answer = await (await post(fetcher, body)).json();
    expect(t.bodies).toEqual([body]);
    expect(answer).toEqual({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: 5 } });
  });

  it("merges minContextSlot into a method's config, appends one where there is none, and never lowers one asked for", async () => {
    const t = transport(() => ({ context: { slot: 900 }, value: null }));
    const fetcher = minContextFetch(t.fetcher, () => 500n);
    await post(fetcher, { jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [["a", "b"], { encoding: "base64", commitment: "confirmed" }] });
    await post(fetcher, { jsonrpc: "2.0", id: 2, method: "getBlockHeight", params: [] });
    await post(fetcher, { jsonrpc: "2.0", id: 3, method: "getSignaturesForAddress", params: ["w", { limit: 1, minContextSlot: 800 }] });
    expect(t.bodies.map((body) => (body as Rpc).params)).toEqual([
      [["a", "b"], { encoding: "base64", commitment: "confirmed", minContextSlot: 500 }],
      [{ minContextSlot: 500 }],
      ["w", { limit: 1, minContextSlot: 800 }],
    ]);
  });

  it("leaves a method that takes no minContextSlot as it is — and refuses its answer when it comes from behind the floor", async () => {
    const t = transport((request) => (request.id === 1 ? { context: { slot: 499 }, value: { amount: "7" } } : { context: { slot: 500 }, value: { amount: "8" } }));
    // NOT ASKED AGAIN HERE (retries 0): the refusal itself is what this test reads; the next describe asks again.
    const fetcher = minContextFetch(t.fetcher, () => 500n, { retries: 0 });
    const stale = await (await post(fetcher, { jsonrpc: "2.0", id: 1, method: "getTokenAccountBalance", params: ["ata", { commitment: "confirmed" }] })).json();
    expect((t.bodies[0] as Rpc).params).toEqual(["ata", { commitment: "confirmed" }]);
    expect(stale).toMatchObject({ id: 1, error: { code: MIN_CONTEXT_NOT_REACHED } });
    expect(JSON.stringify(stale)).not.toContain('"amount"');
    const fresh = await (await post(fetcher, { jsonrpc: "2.0", id: 2, method: "getTokenAccountBalance", params: ["ata"] })).json();
    expect(fresh).toMatchObject({ result: { value: { amount: "8" } } });
  });

  it("handles a batch element by element", async () => {
    const t = transport((request) => ({ context: { slot: request.id === 1 ? 10 : 900 }, value: request.id }));
    const fetcher = minContextFetch(t.fetcher, () => 500n, { retries: 0 });
    const answers = (await (await post(fetcher, [
      { jsonrpc: "2.0", id: 1, method: "getTokenSupply", params: ["m"] },
      { jsonrpc: "2.0", id: 2, method: "getAccountInfo", params: ["k", { encoding: "base64" }] },
    ])).json()) as unknown[];
    expect((t.bodies[0] as Rpc[])[1]!.params).toEqual(["k", { encoding: "base64", minContextSlot: 500 }]);
    expect(answers[0]).toMatchObject({ id: 1, error: { code: MIN_CONTEXT_NOT_REACHED } });
    expect(answers[1]).toMatchObject({ id: 2, result: { value: 2 } });
  });
});

describe("minContextFetch: a refusal at the floor is asked again before the turn sees it", () => {
  /** A node behind the floor for the first `behind` answers, then caught up: the node's own -32016, or an answer from an old slot. */
  function lagging(behind: number, how: "server" | "stale", method = "getSlot") {
    const bodies: unknown[] = [];
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Rpc;
      bodies.push(body);
      const late = bodies.length <= behind;
      const out =
        late && how === "server"
          ? { jsonrpc: "2.0", id: body.id, error: { code: MIN_CONTEXT_NOT_REACHED, message: "Minimum context slot has not been reached", data: { contextSlot: 499 } } }
          : { jsonrpc: "2.0", id: body.id, result: method === "getSlot" ? 600 : { context: { slot: late ? 499 : 600 }, value: { amount: "8" } } };
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { fetcher, bodies };
  }

  it("asks the node's own -32016 again, a second apart, and answers the first reply from a node that has caught up", async () => {
    const t = lagging(2, "server");
    const sleeps: number[] = [];
    const fetcher = minContextFetch(t.fetcher, () => 500n, { sleep: async (ms) => void sleeps.push(ms) });
    const answer = await (await post(fetcher, { jsonrpc: "2.0", id: 7, method: "getSlot", params: [{ commitment: "finalized" }] })).json();
    expect(answer).toEqual({ jsonrpc: "2.0", id: 7, result: 600 });
    expect(t.bodies).toHaveLength(3);
    expect(t.bodies.every((body) => JSON.stringify((body as Rpc).params) === JSON.stringify([{ commitment: "finalized", minContextSlot: 500 }]))).toBe(true);
    expect(sleeps).toEqual([MIN_CONTEXT_RETRY_MS, MIN_CONTEXT_RETRY_MS]);
  });

  it("asks again an answer that comes back from behind the floor, and never hands the turn its stale state", async () => {
    const t = lagging(1, "stale", "getTokenAccountBalance");
    const fetcher = minContextFetch(t.fetcher, () => 500n, { sleep: async () => undefined });
    const answer = await (await post(fetcher, { jsonrpc: "2.0", id: 1, method: "getTokenAccountBalance", params: ["ata"] })).json();
    expect(answer).toMatchObject({ result: { context: { slot: 600 } } });
    expect(t.bodies).toHaveLength(2);
  });

  it("gives up after MIN_CONTEXT_RETRIES more, and only then does the refusal reach the turn", async () => {
    const t = lagging(100, "server");
    const fetcher = minContextFetch(t.fetcher, () => 500n, { sleep: async () => undefined });
    const answer = await (await post(fetcher, { jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: ["k"] })).json();
    expect(answer).toMatchObject({ error: { code: MIN_CONTEXT_NOT_REACHED } });
    expect(t.bodies).toHaveLength(1 + MIN_CONTEXT_RETRIES);
    const stale = lagging(100, "stale", "getTokenAccountBalance");
    const refused = await (await post(minContextFetch(stale.fetcher, () => 500n, { sleep: async () => undefined }), { jsonrpc: "2.0", id: 2, method: "getTokenAccountBalance", params: ["ata"] })).json();
    expect(refused).toMatchObject({ id: 2, error: { code: MIN_CONTEXT_NOT_REACHED } });
    expect(JSON.stringify(refused)).not.toContain('"amount"');
    expect(stale.bodies).toHaveLength(1 + MIN_CONTEXT_RETRIES);
  });

  it("never repeats a request that carries a send, and repeats nothing before a floor is set", async () => {
    const send = lagging(100, "server", "sendTransaction");
    const sent = await (await post(minContextFetch(send.fetcher, () => 500n, { sleep: async () => undefined }), { jsonrpc: "2.0", id: 1, method: "sendTransaction", params: ["AQID", { encoding: "base64" }] })).json();
    expect(sent).toMatchObject({ error: { code: MIN_CONTEXT_NOT_REACHED } });
    expect(send.bodies).toHaveLength(1);
    const unset = lagging(100, "server");
    await post(minContextFetch(unset.fetcher, () => null, { sleep: async () => undefined }), { jsonrpc: "2.0", id: 1, method: "getSlot", params: [] });
    expect(unset.bodies).toHaveLength(1);
  });
});

describe("createJobChain: the job's Connection carries its floor", () => {
  it("sends minContextSlot on the settle and invest turns' own reads once the job requires a slot, and not before", async () => {
    const t = transport((request) => (request.method === "getBalance" ? { context: { slot: 2_000 }, value: 1 } : 1));
    const chain = createJobChain({ transport: t.fetcher, rpcUrl: "http://rpc", wallet: { publicKey: PublicKey.default, signTransaction: async (tx) => tx, signAllTransactions: async (txs) => txs } });
    await chain.connection.getBalance(PublicKey.default, "confirmed");
    chain.requireSlot(1_500n);
    chain.requireSlot(1_000n); // a lower floor never loosens it
    expect(chain.requiredSlot).toBe(1_500n);
    await chain.connection.getBalance(PublicKey.default, "confirmed");
    const params = t.bodies.map((body) => (body as Rpc).params.at(-1));
    expect(params[0]).toEqual({ commitment: "confirmed" });
    expect(params[1]).toEqual({ commitment: "confirmed", minContextSlot: 1_500 });
  });

  it("places the plan floor from ONE answer: the finalized bank's height and slot from getEpochInfo, never two reads", async () => {
    let blockHeight: number | undefined = 6_100;
    const t = transport((request) => {
      if (request.method !== "getEpochInfo") throw new Error(`unexpected ${request.method}`);
      return { epoch: 1_042, slotIndex: 7, slotsInEpoch: 432_000, absoluteSlot: 450_000_123, blockHeight, transactionCount: 1 };
    });
    const chain = createJobChain({ transport: t.fetcher, rpcUrl: "http://rpc", wallet: { publicKey: PublicKey.default, signTransaction: async (tx) => tx, signAllTransactions: async (txs) => txs } });
    expect(await chain.finalizedPoint()).toEqual({ height: 6_100n, slot: 450_000_123n });
    expect(t.bodies).toHaveLength(1);
    expect((t.bodies[0] as Rpc).params).toEqual([{ commitment: "finalized" }]);
    blockHeight = undefined;
    await expect(chain.finalizedPoint()).rejects.toThrow(/no blockHeight/);
  });

  it("reads the vault, its config, the crank and its links in ONE request, keeping only the links that still name this vault", async () => {
    const program = new anchor.Program(idl, new anchor.AnchorProvider({} as never, { publicKey: PublicKey.default } as never, {}));
    const vault = Keypair.generate().publicKey;
    const other = Keypair.generate().publicKey;
    const keeper = Keypair.generate().publicKey;
    const linkBytes = (owner: PublicKey) => {
      const data = Buffer.alloc(129);
      accountDiscriminator("TradingLink").copy(data, 0);
      Keypair.generate().publicKey.toBuffer().copy(data, 8);
      owner.toBuffer().copy(data, 40);
      data.writeBigUInt64LE(5n, 72);
      return data;
    };
    // THE ACCOUNTS AS THE PROGRAM LAYS THEM OUT, encoded by the IDL's own coder (state.rs's field names, snake or camel as Anchor reads them).
    const vaultData = await program.coder.accounts.encode("vault", {
      owner: Keypair.generate().publicKey,
      bump: 255,
      version: 2,
      paused: false,
      skimBps: 2_000,
      lifetimeSaved: new anchor.BN(0),
      createdAt: new anchor.BN(0),
      skimMode: 1,
      volumeBps: 20,
      policyNonce: new anchor.BN(3),
      maxContribution: new anchor.BN(1),
      walletReserve: new anchor.BN(1),
      reserved: new Array(37).fill(0),
    });
    const configData = await program.coder.accounts.encode("protocolConfig", {
      authority: PublicKey.default,
      attester: keeper,
      bump: 254,
      keeper,
      pendingAuthority: PublicKey.default,
      paused: true,
      version: 1,
      reserved: new Array(64).fill(0),
    });
    const links = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    const accounts = new Map<string, { data: Buffer; owner: PublicKey; lamports: number }>([
      [vault.toBase58(), { data: vaultData, owner: program.programId, lamports: 5 }],
      [configAddress(program.programId).toBase58(), { data: configData, owner: program.programId, lamports: 5 }],
      [keeper.toBase58(), { data: Buffer.alloc(0), owner: PublicKey.default, lamports: 77_000 }],
      [links[0]!.toBase58(), { data: linkBytes(vault), owner: program.programId, lamports: 1 }],
      [links[1]!.toBase58(), { data: linkBytes(other), owner: program.programId, lamports: 1 }],
    ]);
    const t = transport((request) => {
      if (request.method !== "getMultipleAccounts") throw new Error(`unexpected ${request.method}`);
      return {
        context: { slot: 1 },
        value: (request.params[0] as string[]).map((address) => {
          const account = accounts.get(address);
          return account === undefined ? null : { data: [account.data.toString("base64"), "base64"], executable: false, lamports: account.lamports, owner: account.owner.toBase58(), rentEpoch: 0 };
        }),
      };
    });
    const chain = createJobChain({ transport: t.fetcher, rpcUrl: "http://rpc", wallet: { publicKey: PublicKey.default, signTransaction: async (tx) => tx, signAllTransactions: async (txs) => txs }, crankHint: () => keeper });
    const read = await chain.readVault(vault, links);
    expect(t.bodies).toHaveLength(1);
    expect(read.vault?.skimMode).toBe(1);
    expect(read.config?.paused).toBe(true);
    expect(read.crankLamports).toBe(77_000n);
    // THE ONE STILL TIED TO THIS VAULT: another vault's link and a closed one are not this job's.
    expect(read.links.map((link) => link.linkAddress.toBase58())).toEqual([links[0]!.toBase58()]);
  });

  it("orders links by address, as the job settles them", () => {
    const keys = [Keypair.generate().publicKey, Keypair.generate().publicKey, Keypair.generate().publicKey];
    const links = keys.map((linkAddress) => ({ linkAddress, wallet: linkAddress, vault: linkAddress, epoch: 0n, settlementNonce: 0n, frontierSlot: 0n }));
    expect([...links].sort(byLinkAddress).map((link) => link.linkAddress.toBase58())).toEqual(keys.map((key) => key.toBase58()).sort());
  });
});
