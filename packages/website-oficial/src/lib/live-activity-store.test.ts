// The loaded history: merged, paged and bounded, without duplicating or losing a row.

import { describe, expect, it } from "vitest";

import { MAX_STORED_ENTRIES, appendOlder, mergeHead, newestSignature } from "@/lib/live-activity-store";

const row = (signature: string, note = "first") => ({ signature, note });
const signaturesOf = (rows: readonly { signature: string }[]): string[] => rows.map((entry) => entry.signature);

describe("mergeHead", () => {
  it("puts a poll's new rows on top of what is held", () => {
    const held = [row("c"), row("b"), row("a")];
    expect(signaturesOf(mergeHead(held, { entries: [row("e"), row("d")], gap: false }))).toEqual(["e", "d", "c", "b", "a"]);
  });

  it("keeps one row per signature, the fresher copy winning", () => {
    const held = [row("b", "first"), row("a", "first")];
    const merged = mergeHead(held, { entries: [row("b", "read again")], gap: false });
    expect(signaturesOf(merged)).toEqual(["b", "a"]);
    expect(merged[0]!.note).toBe("read again");
  });

  it("a page that repeats a signature within itself still stores it once", () => {
    expect(signaturesOf(mergeHead([], { entries: [row("a"), row("a"), row("b")], gap: false }))).toEqual(["a", "b"]);
  });

  it("A GAP REPLACES THE HEAD: a hole nobody can see is worse than a page that reloaded", () => {
    const held = [row("c"), row("b"), row("a")];
    const merged = mergeHead(held, { entries: [row("z"), row("y")], gap: true });
    expect(signaturesOf(merged)).toEqual(["z", "y"]);
    expect(signaturesOf(merged)).not.toContain("c");
  });

  it("an empty poll changes nothing", () => {
    const held = [row("b"), row("a")];
    expect(signaturesOf(mergeHead(held, { entries: [], gap: false }))).toEqual(["b", "a"]);
  });
});

describe("appendOlder", () => {
  it("adds an older page underneath, without disturbing the head", () => {
    const held = [row("d"), row("c")];
    expect(signaturesOf(appendOlder(held, [row("b"), row("a")]))).toEqual(["d", "c", "b", "a"]);
  });

  it("a page that overlaps what is held does not duplicate it, and the held copy stays", () => {
    const held = [row("c", "held"), row("b", "held")];
    const paged = appendOlder(held, [row("b", "older page"), row("a", "older page")]);
    expect(signaturesOf(paged)).toEqual(["c", "b", "a"]);
    expect(paged[1]!.note).toBe("held");
  });
});

describe("the cap", () => {
  const many = (count: number, prefix = "s") => Array.from({ length: count }, (_, index) => row(`${prefix}${index}`));

  it(`keeps at most ${MAX_STORED_ENTRIES} rows, dropping the oldest`, () => {
    const merged = mergeHead(many(MAX_STORED_ENTRIES, "old"), { entries: many(10, "new"), gap: false });
    expect(merged).toHaveLength(MAX_STORED_ENTRIES);
    expect(signaturesOf(merged).slice(0, 10)).toEqual(signaturesOf(many(10, "new")));
    expect(signaturesOf(merged)).not.toContain(`old${MAX_STORED_ENTRIES - 1}`);
  });

  it("bounds an older page too", () => {
    expect(appendOlder(many(MAX_STORED_ENTRIES, "held"), many(20, "older"))).toHaveLength(MAX_STORED_ENTRIES);
  });
});

describe("newestSignature", () => {
  it("is what the next poll asks `until`, and null before anything is held", () => {
    expect(newestSignature([row("c"), row("b")])).toBe("c");
    expect(newestSignature([])).toBeNull();
  });
});
