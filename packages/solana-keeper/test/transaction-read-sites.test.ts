// Where the keeper reads a transaction: in one place, readTransaction
// (src/measure-window.ts).
//
// That function carries the version contract: it asks for
// MAX_SUPPORTED_TRANSACTION_VERSION and turns the node's -32015 refusal into a
// null instead of a throw. A read anywhere else picks its own number, and 0 is
// what everyone copies: on 2026-09-23 the owner's Axiom trades turned out to be
// version 1, and bin/backfill-settlements.mts still asked for 0, so a version 1
// transaction touching the program would have been retried three times and then
// reported as a hole to re-run, which no re-run fills. So the source is read:
// every .ts and .mts file under src/, bin/ and scripts/, the three directories
// tsconfig type-checks as this package's code.
//
// THE WAYS OUT, listed before the matching: a web3.js Connection method that
// fetches a transaction, and a raw JSON-RPC body naming the method. The bench's
// chain stub names it too, because it SERVES it; that is the one exception.

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.m?ts$/.test(entry.name) ? [path] : [];
  });
}

const sources = ["src", "bin", "scripts"]
  .flatMap((directory) => sourceFiles(join(PACKAGE, directory)))
  .map((path) => ({ path: relative(PACKAGE, path), text: readFileSync(path, "utf8") }));

const CONNECTION_READ = /\.(?:getTransaction|getTransactions|getParsedTransaction|getParsedTransactions|getConfirmedTransaction)\s*\(/g;
const RAW_METHOD = /["'`](?:getTransaction|getParsedTransaction|getConfirmedTransaction)["'`]/g;

const sitesOf = (pattern: RegExp) =>
  sources.flatMap(({ path, text }) => [...text.matchAll(pattern)].map((match) => ({ path, index: match.index ?? -1 })));

describe("where the keeper reads a transaction", () => {
  it("finds a Connection transaction read exactly once in src/, bin/ and scripts/, inside readTransaction", () => {
    expect(sources.length).toBeGreaterThan(20);
    const found = sitesOf(CONNECTION_READ);
    expect(found.map((site) => site.path)).toEqual(["src/measure-window.ts"]);

    const window = sources.find((candidate) => candidate.path === "src/measure-window.ts")!.text;
    const start = window.indexOf("export async function readTransaction(");
    const end = window.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(-1);
    expect(found[0]!.index).toBeGreaterThan(start);
    expect(found[0]!.index).toBeLessThan(end);
  });

  it("names the raw RPC method only in the bench's chain stub, which serves it", () => {
    expect(sitesOf(RAW_METHOD).map((site) => site.path)).toEqual(["src/bench/chain-stub.ts"]);
  });

  it("the backfill reads through readTransaction", () => {
    const backfill = sources.find((candidate) => candidate.path === "bin/backfill-settlements.mts")!.text;
    expect(backfill).toMatch(/readTransaction\(connection, entry\.signature, "finalized"\)/);
  });
});
