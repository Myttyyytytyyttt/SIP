// Waiting for a read's history before saying what changed (use-read-settled.ts):
// every read after the first commits its snapshot, then its head page with the
// same clock. The pure core, which is all the hook does besides one timer.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { READ_SETTLE_MS, historyKeyOf, readSettled, useReadSettled, type ReadMarks } from "@/components/live/use-read-settled";

/** A commit's data: its snapshot's clock, and a tag to tell two commits apart. */
const commit = (nowMs: number, tag: string) => ({ nowMs, tag });
/** A commit's marks. `history` is the rows' key: "old" until a head page brings rows, unless a case says otherwise. */
const marks = (nowMs: number, history: Partial<Omit<ReadMarks, "nowMs">> = {}): ReadMarks => ({ nowMs, activityPending: false, activityUnreadable: false, history: "old", ...history });

describe("readSettled", () => {
  it("takes the page's first paint as settled: there is nothing to wait for", () => {
    const first = commit(1_000, "first");
    const state = readSettled(null, first, marks(1_000), 0);
    expect(state.settled).toBe(first);
    expect(state.since).toBeNull();
  });

  it("holds the last settled view through a snapshot-only commit, and settles on the head page that follows", () => {
    const before = commit(1_000, "read 1");
    const snapshot = commit(21_000, "read 2, snapshot");
    const head = commit(21_000, "read 2, history");
    let state = readSettled(null, before, marks(1_000), 0);
    state = readSettled(state, snapshot, marks(21_000), 50);
    // New balances over old rows: nothing is said off this half.
    expect(state.settled).toBe(before);
    expect(state.latest).toBe(snapshot);
    expect(state.since).toBe(50);
    state = readSettled(state, head, marks(21_000, { history: "new" }), 400);
    expect(state.settled).toBe(head);
    expect(state.since).toBeNull();
  });

  /**
   * A SOCKET NOTIFICATION BETWEEN THE TWO COMMITS (review, 10-09): a new `data`
   * with the same clock and the same rows. Taken as the head page, it settled
   * the snapshot alone, and a conversion timed off an older settlement read
   * "Not done since…" until the real head page came.
   */
  it("does not take a push between a snapshot and its history for the head page", () => {
    const before = commit(1_000, "read 1");
    const snapshot = commit(21_000, "read 2, snapshot");
    const pushed = commit(21_000, "a trade was noticed");
    const head = commit(21_000, "read 2, history");
    let state = readSettled(null, before, marks(1_000), 0);
    state = readSettled(state, snapshot, marks(21_000), 50);
    state = readSettled(state, pushed, marks(21_000), 200);
    expect(state.settled).toBe(before);
    expect(state.latest).toBe(pushed);
    expect(state.since).toBe(50);
    // The head page's commit changes the rows' key: that one settles.
    state = readSettled(state, head, marks(21_000, { history: "new" }), 400);
    expect(state.settled).toBe(head);
    expect(state.since).toBeNull();
  });

  it("still settles a push past the cap, on the push", () => {
    let state = readSettled(readSettled(null, commit(1_000, "a"), marks(1_000), 0), commit(21_000, "b"), marks(21_000), 100);
    const pushed = commit(21_000, "pushed late");
    state = readSettled(state, pushed, marks(21_000), 100 + READ_SETTLE_MS);
    expect(state.settled).toBe(pushed);
    expect(state.since).toBeNull();
  });

  it("settles on its own after READ_SETTLE_MS when no second commit comes — and not a moment before", () => {
    const before = commit(1_000, "read 1");
    const snapshot = commit(21_000, "read 2, no history");
    let state = readSettled(readSettled(null, before, marks(1_000), 0), snapshot, marks(21_000), 100);
    // The same commit seen again, before the cap: unchanged, the same object back.
    expect(readSettled(state, snapshot, marks(21_000), 100 + READ_SETTLE_MS - 1)).toBe(state);
    state = readSettled(state, snapshot, marks(21_000), 100 + READ_SETTLE_MS);
    expect(state.settled).toBe(snapshot);
    expect(state.since).toBeNull();
  });

  it("counts the cap from the first unsettled snapshot when another read lands before the first settled", () => {
    let state = readSettled(null, commit(1_000, "a"), marks(1_000), 0);
    state = readSettled(state, commit(21_000, "b"), marks(21_000), 100);
    state = readSettled(state, commit(41_000, "c"), marks(41_000), 2_000);
    expect(state.since).toBe(100);
    expect(readSettled(state, state.latest, state.marks, 100 + READ_SETTLE_MS).since).toBeNull();
  });

  it("settles at once when the history's own state moves: pending to loaded, pending to unreadable", () => {
    const first = commit(1_000, "drawn before the history");
    const pending = readSettled(null, first, marks(1_000, { activityPending: true }), 0);
    const failed = commit(1_000, "the history failed");
    const state = readSettled(pending, failed, marks(1_000, { activityUnreadable: true }), 10);
    expect(state.settled).toBe(failed);
    expect(state.since).toBeNull();
    // A new snapshot that comes WITH its history's change has nothing left to wait for either.
    const both = readSettled(pending, commit(21_000, "snapshot and history"), marks(21_000), 20);
    expect(both.since).toBeNull();
  });

  it("with nothing waited on, settles any other change at once: a push, an older page, a failure noted on the same snapshot", () => {
    const first = commit(1_000, "read 1");
    const pushed = commit(1_000, "a wallet changed");
    const state = readSettled(readSettled(null, first, marks(1_000), 0), pushed, marks(1_000), 5);
    expect(state.settled).toBe(pushed);
  });
});

describe("historyKeyOf", () => {
  const rows = (...signatures: string[]) => signatures.map((signature) => ({ signature }));

  it("is the same for the same rows in new arrays — what a push hands over", () => {
    const one = { rows: rows("b", "a"), hiddenRows: rows(), settlementRows: rows("s") };
    expect(historyKeyOf({ rows: [...one.rows], hiddenRows: [], settlementRows: [...one.settlementRows] })).toBe(historyKeyOf(one));
  });

  it("changes when a page brings a newer row, an older one, or a settlement", () => {
    const one = { rows: rows("b", "a"), hiddenRows: rows(), settlementRows: rows("s") };
    const key = historyKeyOf(one);
    expect(historyKeyOf({ ...one, rows: rows("c", "b", "a") })).not.toBe(key);
    expect(historyKeyOf({ ...one, rows: rows("b", "a", "0") })).not.toBe(key);
    expect(historyKeyOf({ ...one, settlementRows: rows("t", "s") })).not.toBe(key);
    expect(historyKeyOf({ ...one, hiddenRows: rows("h") })).not.toBe(key);
  });
});

describe("useReadSettled", () => {
  it("hands back the data it is given on the page's first paint, settled", () => {
    const data = commit(1_000, "first");
    let seen: { readonly data: unknown; readonly settled: boolean } | null = null;
    function Probe() {
      seen = useReadSettled(data, { activityPending: false, activityUnreadable: false, history: "" });
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toEqual({ data, settled: true });
  });
});
