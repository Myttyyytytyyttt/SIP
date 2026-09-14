// ./client stays browser-safe; ./server stays server-only; there is no "." entry.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMPORT = /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const ALLOWED_BARE = new Set(["@sip/solana-program/idl"]);

function resolveRelative(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      try {
        readFileSync(candidate);
        return candidate;
      } catch {
        // a directory
      }
    }
  }
  throw new Error(`cannot resolve ${specifier} from ${relative(ROOT, from)}`);
}

function reachable(entry: string): { files: string[]; bare: Set<string> } {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2]!;
      if (specifier.startsWith(".")) queue.push(resolveRelative(file, specifier));
      else bare.add(specifier);
    }
  }
  return { files: [...seen], bare };
}

describe("@sip/solana-core/client", () => {
  const { files, bare } = reachable(join(ROOT, "src/client/index.ts"));

  it("reaches the whole client tree and the shared validator", () => {
    const names = files.map((file) => relative(ROOT, file)).sort();
    expect(names).toContain("src/client/decoders.ts");
    expect(names).toContain("src/client/link-consent.ts");
    expect(names).toContain("src/shared/public-ws-url.mjs");
    expect(names.some((name) => name.startsWith("src/server/"))).toBe(false);
  });

  it("imports no package but the IDL JSON", () => {
    expect([...bare].filter((specifier) => !ALLOWED_BARE.has(specifier))).toEqual([]);
  });

  it.each([
    ["the web3 SDK", /@solana\/web3\.js/],
    ["a node: module", /["']node:/],
    ["server-only", /server-only/],
    ["Node's byte-array global", /\bBuffer\b/],
    ["process.env", /process\.env/],
  ])("never mentions %s", (_, pattern) => {
    for (const file of files) expect(readFileSync(file, "utf8"), relative(ROOT, file)).not.toMatch(pattern);
  });
});

describe("@sip/solana-core/server and the manifest", () => {
  it("opens the server entry with import \"server-only\"", () => {
    const firstStatement = readFileSync(join(ROOT, "src/server/index.ts"), "utf8")
      .split("\n")
      .find((line) => line.trim() !== "" && !line.trim().startsWith("//"));
    expect(firstStatement).toBe('import "server-only";');
  });

  it("exports ./client, ./server and ./public-ws-url, and no bare entry", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { exports: Record<string, unknown>; dependencies: Record<string, string> };
    expect(Object.keys(manifest.exports).sort()).toEqual(["./client", "./package.json", "./public-ws-url", "./server"]);
    expect(manifest.dependencies).not.toHaveProperty("@coral-xyz/anchor");
  });

  it("never reads process.env anywhere in the package source", () => {
    const { files } = reachable(join(ROOT, "src/server/index.ts"));
    for (const file of files) expect(readFileSync(file, "utf8"), relative(ROOT, file)).not.toMatch(/process\.env/);
  });
});
