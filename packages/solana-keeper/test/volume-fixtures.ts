// Real mainnet transactions, served to the keeper's OWN reader through a
// Connection whose fetch answers from test/fixtures/volume-mainnet.json.
//
// THE REAL DECODER, NOT A HAND-BUILT RESPONSE. Each fixture is the node's
// getTransaction answer verbatim, so web3.js turns it into a
// VersionedTransactionResponse exactly as it does in production, version 1
// messages included (the owner's Axiom trades are version 1). A test that built
// the response by hand would test the shape its author believed in.

import { readFileSync } from "node:fs";
import { Connection, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { readTransaction } from "../src/measure-window.js";

interface Fixture {
  readonly signature: string;
  readonly wallet: string;
  readonly result: { readonly slot: number; readonly [key: string]: unknown };
}

const FILE = JSON.parse(readFileSync(new URL("./fixtures/volume-mainnet.json", import.meta.url), "utf8")) as {
  readonly fixtures: Readonly<Record<string, Fixture>>;
};

export const FIXTURES: Readonly<Record<string, Fixture>> = FILE.fixtures;

export function fixture(name: string): Fixture {
  const found = FIXTURES[name];
  if (found === undefined) throw new Error(`no volume fixture named ${name}`);
  return found;
}

/** A Connection that answers getTransaction from the fixtures, by signature, and refuses every other method. */
export function fixtureConnection(): Connection {
  const bySignature = new Map(Object.values(FIXTURES).map((entry) => [entry.signature, entry.result]));
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { readonly id: unknown; readonly method: string; readonly params: readonly unknown[] };
    if (request.method !== "getTransaction") throw new Error(`the fixture connection answers getTransaction only, not ${request.method}`);
    const result = bySignature.get(String(request.params[0])) ?? null;
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return new Connection("http://fixtures.invalid", { commitment: "finalized", fetch });
}

/** One fixture, decoded by web3.js through the keeper's own readTransaction. */
export async function fixtureTransaction(name: string): Promise<{ readonly tx: VersionedTransactionResponse; readonly wallet: PublicKey }> {
  const entry = fixture(name);
  const tx = await readTransaction(fixtureConnection(), entry.signature, "finalized");
  if (tx === null) throw new Error(`the fixture ${name} decoded to null`);
  return { tx, wallet: new PublicKey(entry.wallet) };
}
