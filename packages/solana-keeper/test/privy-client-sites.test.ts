// Where the keeper builds a Privy client: in one place, pinnedPrivyClient
// (src/privy-signer.ts).
//
// The factory pins the host the app secret goes to, the log level and one
// attempt per request. A client built anywhere else would take
// PRIVY_API_BASE_URL and PRIVY_API_LOG from the environment and re-send on a
// 5xx, and nothing at runtime would say so. So the source is read: every .ts and
// .mts file under src/ and bin/.

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

const sources = ["src", "bin"]
  .flatMap((directory) => sourceFiles(join(PACKAGE, directory)))
  .map((path) => ({ path: relative(PACKAGE, path), text: readFileSync(path, "utf8") }));

const source = (path: string): string => {
  const found = sources.find((candidate) => candidate.path === path);
  if (found === undefined) throw new Error(`${path} was not read`);
  return found.text;
};

describe("where a Privy client is built", () => {
  it("finds `new PrivyClient(` exactly once in src/ and bin/, inside pinnedPrivyClient", () => {
    expect(sources.length).toBeGreaterThan(20);
    const found = sources.flatMap(({ path, text }) => [...text.matchAll(/new\s+PrivyClient\s*\(/g)].map((match) => ({ path, index: match.index ?? -1 })));
    expect(found.map((site) => site.path)).toEqual(["src/privy-signer.ts"]);

    const signer = source("src/privy-signer.ts");
    const start = signer.indexOf("export function pinnedPrivyClient(");
    const end = signer.indexOf("\n}\n", start);
    expect(start).toBeGreaterThan(-1);
    expect(found[0]!.index).toBeGreaterThan(start);
    expect(found[0]!.index).toBeLessThan(end);
  });

  it("builds nothing from the SDK's inner PrivyAPI, which the factory does not pin", () => {
    // A construction or an import, not a mention: config.ts cites client.js by path in a comment.
    const inner = /new\s+PrivyAPI\s*\(|(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']@privy-io\/node\/client/;
    expect(sources.filter(({ text }) => inner.test(text)).map(({ path }) => path)).toEqual([]);
  });

  it("takes the client from pinnedPrivyClient at the policy CLI's client and at bin/ready.mts", () => {
    for (const path of ["src/privy-policy-client.ts", "bin/ready.mts"]) expect(source(path), path).toMatch(/pinnedPrivyClient\(\{/);
  });
});
