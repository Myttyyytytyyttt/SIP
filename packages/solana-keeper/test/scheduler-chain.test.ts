// The scheduler's chain (src/scheduler-chain.ts) over the bench's stubbed chain
// (src/bench/chain-stub.ts), through a real @solana/web3.js Connection whose
// transport is the stub: the listing asked with its context (and the legacy
// listing NOT asked with it — its requests stay byte for byte), the fingerprint
// batch, and the dry invest decision that never reaches Jupiter.

import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BenchChain } from "../src/bench/chain-stub.js";
import { benchKey, buildFleet } from "../src/bench/fleet.js";
import { discoverLinks, discoverLinksPreferringV2, discoverLinksWithContext } from "../src/discovery.js";
import { accountDiscriminator, idl } from "../src/idl.js";
import { createSchedulerChain } from "../src/scheduler-chain.js";

const programId = new PublicKey(idl.address);
const DISC = accountDiscriminator("TradingLink");

interface Sent {
  readonly method: string;
  readonly params: readonly unknown[];
}

function stubbed(links: number, options: { readonly speaksGpaV2?: boolean } = {}) {
  const chain = new BenchChain({ programId, crank: benchKey("crank"), ...options });
  const fleet = buildFleet({ links, hotRatio: 0, hotTxCount: 0, programId, seed: 3 });
  chain.setFleet(fleet);
  const sent: Sent[] = [];
  const fetch = (async (_input: unknown, init?: { readonly body?: unknown }) => {
    const payload: unknown = JSON.parse(String(init?.body ?? "{}"));
    const answer = (call: { id?: unknown; method?: unknown; params?: unknown }) => {
      const params = Array.isArray(call.params) ? call.params : [];
      sent.push({ method: String(call.method), params });
      const result = chain.handle(String(call.method), params);
      return result.error === undefined ? { jsonrpc: "2.0", id: call.id ?? null, result: result.result ?? null } : { jsonrpc: "2.0", id: call.id ?? null, error: result.error };
    };
    const body = Array.isArray(payload) ? payload.map((one) => answer(one as never)) : answer(payload as never);
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const connection = new Connection("http://127.0.0.1:1", { commitment: "confirmed", fetch });
  const refuse = async (): Promise<never> => {
    throw new Error("signs nothing");
  };
  const program = new anchor.Program(idl as anchor.Idl, new anchor.AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse }, { commitment: "confirmed" }));
  return { chain, fleet, connection, program, sent, fetch };
}

afterEach(() => vi.restoreAllMocks());

describe("the scheduler's listing carries its context slot; the legacy listing's requests do not change", () => {
  it("V1 with its context lists exactly what discoverLinks lists, at the stub's slot", async () => {
    const { connection } = stubbed(5);
    const plain = await discoverLinks(connection, programId, DISC);
    const withContext = await discoverLinksWithContext(connection, programId, DISC);
    expect(withContext.links.map((l) => l.linkAddress.toBase58())).toEqual(plain.map((l) => l.linkAddress.toBase58()));
    expect(withContext.contextSlot).toBeGreaterThan(0);
  });

  it("the scheduler's chain lists V1 by default, and V2 first under gpa-v2 — both with a context slot — falling back to V1 with one", async () => {
    const v1 = stubbed(4);
    const plainChain = createSchedulerChain({ connection: v1.connection, program: v1.program, discriminator: DISC, gpaV2: false, rpc: v1.fetch });
    const listed = await plainChain.list();
    expect(listed).toMatchObject({ method: "v1", requests: 1 });
    expect(listed.links).toHaveLength(4);
    expect(listed.contextSlot).toBeGreaterThan(0);
    expect(v1.sent.map((s) => s.method)).toEqual(["getProgramAccounts"]);
    expect(v1.sent[0]!.params[1]).toMatchObject({ withContext: true });

    const v2 = stubbed(4, { speaksGpaV2: true });
    const v2Chain = createSchedulerChain({ connection: v2.connection, program: v2.program, discriminator: DISC, gpaV2: true, rpc: v2.fetch });
    const paged = await v2Chain.list();
    expect(paged.method).toBe("v2");
    expect(paged.links).toHaveLength(4);
    expect(paged.contextSlot).toBeGreaterThan(0);
    expect(v2.sent.every((s) => s.method === "getProgramAccountsV2" && (s.params[1] as { withContext?: boolean }).withContext === true)).toBe(true);

    const fallback = stubbed(4);
    const fallbackChain = createSchedulerChain({ connection: fallback.connection, program: fallback.program, discriminator: DISC, gpaV2: true, rpc: fallback.fetch });
    const fell = await fallbackChain.list();
    expect(fell).toMatchObject({ method: "v1-fallback" });
    expect(fell.contextSlot).toBeGreaterThan(0);
  });

  it("the legacy keeper's two listings send no withContext, V1 or V2", async () => {
    const v1 = stubbed(3);
    await discoverLinks(v1.connection, programId, DISC);
    const v2 = stubbed(3, { speaksGpaV2: true });
    const report = await discoverLinksPreferringV2(v2.connection, programId, DISC, v2.fetch);
    expect(report.contextSlot).toBeUndefined();
    for (const sent of [...v1.sent, ...v2.sent]) expect(JSON.stringify(sent.params), sent.method).not.toContain("withContext");
  });
});

describe("the fingerprint batch and the dry invest decision", () => {
  it("reads each wallet and its wSOL ATA, a hundred accounts a request, at the batch's lowest context slot", async () => {
    const { connection, program, sent, fetch } = stubbed(2);
    const chain = createSchedulerChain({ connection, program, discriminator: DISC, gpaV2: false, rpc: fetch });
    const wallets = Array.from({ length: 120 }, (_, i) => benchKey(`w${i}`).toBase58());
    const read = await chain.fingerprints(wallets);
    expect(sent.filter((s) => s.method === "getMultipleAccounts")).toHaveLength(3);
    expect(read.byWallet.size).toBe(120);
    expect(read.slot).toBeGreaterThan(0);
    for (const value of read.byWallet.values()) expect(value).toEqual({ lamports: expect.any(BigInt), wsol: expect.any(BigInt) });
  });

  it("decides each vault's invest half dry from one snapshot, never asks Jupiter, and rests only on an at-rest outcome", async () => {
    const { connection, program, fleet, fetch, chain: stub } = stubbed(3);
    // ONE VAULT WITH SOL TO WRAP: its dry turn would act ("DRY RUN — would wrap"), so it may not rest.
    const accounts = (stub as unknown as { accounts: Map<string, { lamports: number }> }).accounts;
    const funded = fleet[0]!.vault.toBase58();
    accounts.set(funded, { ...accounts.get(funded)!, lamports: accounts.get(funded)!.lamports + 50_000_000_000 });
    const chain = createSchedulerChain({ connection, program, discriminator: DISC, gpaV2: false, rpc: fetch });
    const outside = vi.spyOn(globalThis, "fetch");
    const vaults = [...new Set(fleet.map((l) => l.vault.toBase58()))];
    const verdicts = await chain.investAtRest(vaults, { crankLamports: 5_000_000_000n, protocolPaused: false });
    expect(outside).not.toHaveBeenCalled();
    expect([...verdicts.keys()].sort()).toEqual([...vaults].sort());
    expect(verdicts.get(funded)).toMatchObject({ rests: false, outcome: "INVESTED", detail: expect.stringContaining("DRY RUN — would wrap") });
    for (const vault of vaults.filter((v) => v !== funded)) expect(verdicts.get(vault)).toMatchObject({ rests: true, outcome: "IDLE" });
    const paused = await chain.investAtRest(vaults, { crankLamports: 5_000_000_000n, protocolPaused: true });
    for (const verdict of paused.values()) expect(verdict).toMatchObject({ rests: true });
  });

  it("asks the finalized height, and the statuses with their history, 256 a request", async () => {
    const calls: unknown[][] = [];
    const connection = {
      getBlockHeight: async (...args: unknown[]) => (calls.push(["getBlockHeight", ...args]), 777),
      getSignatureStatuses: async (signatures: string[], config: unknown) => {
        calls.push(["getSignatureStatuses", signatures.length, config]);
        return { context: { slot: 1 }, value: signatures.map((s) => (s === "landed" ? ({ err: null } as ConfirmedSignatureInfo) : null)) };
      },
    } as unknown as Connection;
    const chain = createSchedulerChain({ connection, program: { programId } as anchor.Program, discriminator: DISC, gpaV2: false, rpc: globalThis.fetch });
    expect(await chain.finalizedHeight()).toBe(777n);
    const statuses = await chain.signatureStatuses(["landed", ...Array.from({ length: 300 }, (_, i) => `s${i}`)]);
    expect(statuses[0]).toEqual({ err: null });
    expect(statuses.slice(1).every((s) => s === null)).toBe(true);
    expect(calls).toEqual([
      ["getBlockHeight", "finalized"],
      ["getSignatureStatuses", 256, { searchTransactionHistory: true }],
      ["getSignatureStatuses", 45, { searchTransactionHistory: true }],
    ]);
  });
});
