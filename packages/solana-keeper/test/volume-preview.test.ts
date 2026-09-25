// The volume keeper's preview of a PROFIT vault (src/volume-preview.ts), over the
// owner's real trades served through a Connection, and its cache.

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { VaultState } from "../src/accounts.js";
import type { ManagedLink } from "../src/discovery.js";
import { idl } from "../src/idl.js";
import { previewVolume, type PreviewBook } from "../src/volume-preview.js";
import { FIXTURES } from "./volume-fixtures.js";

const ORDER = ["owner-settle-2026-09-19", "owner-buy-1", "owner-sell-1", "owner-buy-2", "owner-sell-2"];
const wallet = new PublicKey(FIXTURES["owner-buy-1"]!.wallet);
const START = BigInt(FIXTURES["owner-settle-2026-09-19"]!.result.slot);

/** A node over the owner's history; `pendingNewer` is a confirmed signature the finalized history does not hold yet. */
function node(pendingNewer?: { readonly signature: string; readonly slot: number }) {
  const finalized = [...ORDER].reverse().map((name) => ({ signature: FIXTURES[name]!.signature, slot: FIXTURES[name]!.result.slot }));
  const reads: string[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { readonly id: unknown; readonly method: string; readonly params: readonly unknown[] };
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200 });
    if (request.method === "getSignaturesForAddress") {
      const options = (request.params[1] ?? {}) as { readonly before?: string; readonly limit?: number; readonly commitment?: string };
      const list = options.commitment === "confirmed" && pendingNewer !== undefined ? [pendingNewer, ...finalized] : finalized;
      const start = options.before === undefined ? 0 : list.findIndex((e) => e.signature === options.before) + 1;
      return reply(list.slice(start, start + (options.limit ?? 1000)).map((e) => ({ ...e, err: null, memo: null, blockTime: null, confirmationStatus: "finalized" })));
    }
    if (request.method === "getTransaction") {
      reads.push(String(request.params[0]));
      return reply(Object.values(FIXTURES).find((entry) => entry.signature === request.params[0])?.result ?? null);
    }
    throw new Error(`unexpected ${request.method}`);
  };
  const connection = new Connection("http://preview.invalid", { commitment: "confirmed", fetch });
  const refuse = async (): Promise<never> => {
    throw new Error("signs nothing");
  };
  const program = new anchor.Program(idl, new anchor.AnchorProvider(connection, { publicKey: PublicKey.default, signTransaction: refuse, signAllTransactions: refuse }, {}));
  return { connection, program, reads };
}

const link: ManagedLink = { linkAddress: Keypair.generate().publicKey, wallet, vault: Keypair.generate().publicKey, epoch: START - 1n, settlementNonce: 2n, frontierSlot: START };
const vault: VaultState = {
  owner: Keypair.generate().publicKey,
  paused: false,
  skimMode: 0,
  skimBps: 2_500,
  volumeBps: 200,
  policyNonce: 1n,
  maxContribution: 60_000_000n,
  walletReserve: 50_000_000n,
};

describe("previewVolume", () => {
  it("says what the owner's four trades would owe in VOLUME mode at the vault's stored rate", async () => {
    const { connection, program } = node();
    const text = await previewVolume({ connection, program, link, vault });
    expect(text).toContain("4 trade(s), 4.058319740 SOL of volume");
    expect(text).toContain("at this vault's stored volume rate of 200 bps that would owe 0.081166394 SOL");
    expect(text).toContain("before the cap of 0.060000000 SOL per settlement");
  });

  it("walks once while the span has not moved", async () => {
    const { connection, program, reads } = node();
    const book: PreviewBook = new Map();
    const first = await previewVolume({ connection, program, link, vault, book });
    const after = reads.length;
    expect(await previewVolume({ connection, program, link, vault, book })).toBe(first);
    expect(reads.length).toBe(after);
  });

  it("does not keep a preview that stopped short of a confirmed signature the finalized walk has not reached", async () => {
    const newer = { signature: "confirmed-not-finalized", slot: Number(FIXTURES["owner-sell-2"]!.result.slot) + 10 };
    const { connection, program, reads } = node(newer);
    const book: PreviewBook = new Map();
    await previewVolume({ connection, program, link, vault, book });
    const after = reads.length;
    await previewVolume({ connection, program, link, vault, book });
    expect(reads.length).toBeGreaterThan(after);
  });
});
