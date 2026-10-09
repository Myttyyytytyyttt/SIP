// A row's key is its transaction, never its place (G12): a new row above leaves
// every key below it alone, and one transaction's two events get two keys.

import { describe, expect, it } from "vitest";

import { keyBySignature } from "@/components/live/row-keys";

const keysOf = (signatures: readonly string[]): string[] => {
  const keyOf = keyBySignature();
  return signatures.map((signature) => keyOf(signature));
};

describe("keyBySignature", () => {
  it("gives one transaction's two events two keys", () => {
    expect(keysOf(["a", "a", "b"])).toEqual(["a:0", "a:1", "b:0"]);
  });

  it("changes no existing key when a new transaction arrives on top", () => {
    const before = keysOf(["b", "b", "c"]);
    const after = keysOf(["a", "b", "b", "c"]);
    expect(after.slice(1)).toEqual(before);
  });

  it("changes no existing key when older history is appended", () => {
    const before = keysOf(["a", "b"]);
    expect(keysOf(["a", "b", "c", "c"]).slice(0, 2)).toEqual(before);
  });

  it("counts afresh for each list, so two lists cannot share a counter by accident", () => {
    expect(keysOf(["a"])).toEqual(["a:0"]);
    expect(keysOf(["a"])).toEqual(["a:0"]);
  });
});
