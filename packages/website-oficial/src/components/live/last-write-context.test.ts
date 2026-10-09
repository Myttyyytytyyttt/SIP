// WHAT WAS JUST SIGNED, AND WHETHER THE PAGE SHOWS IT YET (10-09, plan B4).
//
// A landed signature is "updating your pension" only while an update may yet
// bring it: shown means the snapshot was read at or past its slot (or, with no
// slot, its signature is among the rows); past a minute or two whole updates it
// is the still "not on this page yet", and after a quarter of an hour nothing.
// Never a state no signal backs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  LastWriteContext,
  SYNC_CAP_MS,
  SYNC_LATE_HIDE_MS,
  START_BUYING_WRITER,
  pageShows,
  ruleCardWrite,
  stageWrite,
  syncDueAt,
  syncStateOf,
  syncWords,
  syncingFor,
  useWriteJudge,
  useWriteSyncing,
  type LastWrite,
  type LastWriteValue,
  type PageRead,
  type WriteSync,
} from "@/components/live/last-write-context";
import type { WriteProgress } from "@/hooks/use-vault-actions";
import { LIVE_COPY } from "@/lib/live-copy";

const AT = Date.UTC(2026, 9, 9, 14, 32, 0);

const write = (overrides: Partial<LastWrite> = {}): LastWrite => ({
  pensionKey: "owner",
  kind: "rule",
  writer: "vault",
  signature: "sigRule",
  slot: 5_000,
  at: AT,
  ...overrides,
});

const page = (overrides: Partial<PageRead> = {}): PageRead => ({ readId: 7, slot: 4_999, rows: [], ...overrides });

const landed = (signature: string): WriteProgress => ({
  phase: "finished",
  kind: "rule",
  result: { ok: true, signature, explorerUrl: null, slot: 5_000, unitsConsumed: null },
});

describe("whether the page shows a write", () => {
  it("does once the snapshot on screen was read at or past the slot it landed in — not before", () => {
    expect(pageShows(write(), page({ slot: 4_999 }))).toBe(false);
    expect(pageShows(write(), page({ slot: 5_000 }))).toBe(true);
    expect(pageShows(write(), page({ slot: 5_100 }))).toBe(true);
  });

  it("goes by the signature among the rows only when a slot is missing on either side", () => {
    const rows = [{ signature: "sigRule" }];
    expect(pageShows(write({ slot: null }), page({ rows }))).toBe(true);
    expect(pageShows(write(), page({ slot: null, rows }))).toBe(true);
    expect(pageShows(write({ slot: null }), page({ rows: [{ signature: "other" }] }))).toBe(false);
    // With both slots known the slot decides: a history ahead of an older snapshot does not make its figures new.
    expect(pageShows(write(), page({ slot: 4_000, rows }))).toBe(false);
  });
});

describe("the verdict", () => {
  const judge = (input: { readonly page?: Partial<PageRead>; readonly readIdAt?: number; readonly after?: number; readonly write?: Partial<LastWrite> }) =>
    syncStateOf(write(input.write), { page: page(input.page), readIdAt: input.readIdAt ?? 7, now: AT + (input.after ?? 0) });

  it("is 'syncing' from the landing while an update may yet bring it", () => {
    expect(judge({})).toBe("syncing");
    expect(judge({ after: SYNC_CAP_MS - 1, page: { readId: 8 } })).toBe("syncing");
  });

  it("has nothing to say once the page shows it", () => {
    expect(judge({ page: { slot: 5_000 } })).toBeNull();
    expect(judge({ page: { slot: 5_000, readId: 20 }, after: SYNC_CAP_MS * 3 })).toBeNull();
  });

  it("is 'late' after two whole updates that did not bring it, or a minute — whichever comes first", () => {
    expect(judge({ page: { readId: 9 } })).toBe("late");
    expect(judge({ after: SYNC_CAP_MS })).toBe("late");
  });

  it("counts updates from when this page first saw the write, not from zero", () => {
    expect(judge({ page: { readId: 40 }, readIdAt: 39 })).toBe("syncing");
    expect(judge({ page: { readId: 41 }, readIdAt: 39 })).toBe("late");
  });

  it("says nothing once the still line has stood a quarter of an hour", () => {
    expect(judge({ after: SYNC_LATE_HIDE_MS - 1 })).toBe("late");
    expect(judge({ after: SYNC_LATE_HIDE_MS })).toBeNull();
  });

  it("comes due by time at the cap while syncing, at the end of the still line once late", () => {
    expect(syncDueAt({ write: write(), state: "syncing" })).toBe(AT + SYNC_CAP_MS);
    expect(syncDueAt({ write: write(), state: "late" })).toBe(AT + SYNC_LATE_HIDE_MS);
  });
});

describe("who says it", () => {
  it("a success line says 'updating' only for its own landed write, and only while syncing", () => {
    const syncing: WriteSync = { write: write(), state: "syncing" };
    expect(syncingFor(syncing, landed("sigRule"))).toBe(true);
    expect(syncingFor(syncing, landed("another"))).toBe(false);
    expect(syncingFor({ ...syncing, state: "late" }, landed("sigRule"))).toBe(false);
    expect(syncingFor(null, landed("sigRule"))).toBe(false);
    expect(syncingFor(syncing, { phase: "idle" })).toBe(false);
    expect(syncingFor(syncing, { phase: "running", kind: "rule", step: "confirming", built: null })).toBe(false);
    expect(syncingFor(syncing, { phase: "finished", kind: "rule", result: { ok: false, kind: "expired", message: "x" } })).toBe(false);
  });

  it("the rule card speaks for a rule or a basket signed anywhere — but not for the first-buy card's own approval", () => {
    expect(ruleCardWrite(write({ kind: "rule", writer: "vault" }))).toBe(true);
    expect(ruleCardWrite(write({ kind: "policy", writer: "policy" }))).toBe(true);
    expect(ruleCardWrite(write({ kind: "policy", writer: START_BUYING_WRITER }))).toBe(false);
    for (const kind of ["create", "link", "createLink", "withdraw", "withdrawToken"] as const) expect(ruleCardWrite(write({ kind })), kind).toBe(false);
  });

  it("the next step speaks for the write that moves its stage on, and no other", () => {
    expect(stageWrite("no_vault", write({ kind: "create" }))).toBe(true);
    expect(stageWrite("no_vault", write({ kind: "rule" }))).toBe(false);
    for (const kind of ["link", "createLink", "importLink"] as const) {
      expect(stageWrite("not_linked", write({ kind })), kind).toBe(true);
      expect(stageWrite("no_trading_wallet", write({ kind })), kind).toBe(true);
    }
    expect(stageWrite("not_linked", write({ kind: "withdraw" }))).toBe(false);
    expect(stageWrite("waiting_first_settlement", write({ kind: "link" }))).toBe(false);
    expect(stageWrite("active", write({ kind: "create" }))).toBe(false);
  });

  it("in the host's words while syncing, then the still line with when it landed — dated when not today", () => {
    const sync: WriteSync = { write: write(), state: "syncing" };
    expect(syncWords(sync, LIVE_COPY.syncing.signed, AT)).toBe(LIVE_COPY.syncing.signed);
    expect(syncWords({ ...sync, state: "late" }, LIVE_COPY.syncing.signed, AT + 60_000)).toBe("Signed at 14:32 UTC · not on this page yet");
    expect(syncWords({ ...sync, state: "late" }, LIVE_COPY.syncing.signed, AT + 86_400_000)).toBe("Signed yesterday, 14:32 UTC · not on this page yet");
  });
});

describe("the page's judge and the modal's reader", () => {
  const value = (held: LastWrite | null, sync: WriteSync | null = null): LastWriteValue => ({ write: held, sync, report: vi.fn() });

  function Judge(props: PageRead & { readonly pensionKey: string }) {
    const sync = useWriteJudge(props);
    return createElement("output", null, sync === null ? "none" : sync.state);
  }
  const judged = (held: LastWrite | null, at: Partial<PageRead> & { readonly pensionKey?: string } = {}): string =>
    renderToStaticMarkup(
      createElement(LastWriteContext.Provider, { value: value(held) }, createElement(Judge, { ...page(at), pensionKey: at.pensionKey ?? "owner" })),
    ).replace(/<[^>]*>/g, "");

  it("judges the last write to THIS pension, from its first sight of it", () => {
    const fresh = write({ at: Date.now() });
    expect(judged(fresh)).toBe("syncing");
    expect(judged(fresh, { slot: 6_000 })).toBe("none");
    expect(judged(write({ at: Date.now() - SYNC_CAP_MS }))).toBe("late");
    // Another pension key's write is never said on this one.
    expect(judged(fresh, { pensionKey: "someone-else" })).toBe("none");
  });

  it("judges nothing outside a host, or with nothing signed", () => {
    expect(renderToStaticMarkup(createElement(Judge, { ...page(), pensionKey: "owner" }))).toBe("<output>none</output>");
    expect(judged(null)).toBe("none");
  });

  it("hands a modal's card the page's verdict on its own write, and nothing without a live page judging", () => {
    function Reader({ progress }: { readonly progress: WriteProgress }) {
      return createElement("output", null, String(useWriteSyncing(progress)));
    }
    const read = (sync: WriteSync | null, progress: WriteProgress): string =>
      renderToStaticMarkup(createElement(LastWriteContext.Provider, { value: value(write(), sync) }, createElement(Reader, { progress }))).replace(/<[^>]*>/g, "");
    expect(read({ write: write(), state: "syncing" }, landed("sigRule"))).toBe("true");
    expect(read(null, landed("sigRule"))).toBe("false");
    expect(renderToStaticMarkup(createElement(Reader, { progress: landed("sigRule") }))).toBe("<output>false</output>");
  });
});

describe("where the record is kept and fed", () => {
  const source = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  it("every landing is noted by the one write path, with the writer's key and the slot it landed in", () => {
    const actions = source("../../hooks/use-vault-actions.ts");
    expect(actions).toMatch(/if \(result\.ok\) noteWrite\?\.\(\{ pensionKey: screen\.pensionKey, kind, writer: key, signature: result\.signature, slot: result\.slot, at: Date\.now\(\) \}\);/);
  });

  it("is kept above the page and the wallets modal both, and judged only by the live body", () => {
    expect(source("../wallets-host.tsx")).toMatch(/<LastWriteHost>/);
    expect(source("./LiveBody.tsx")).toMatch(/const sync = useWriteJudge\(/);
    for (const path of ["../dashboard-main.tsx", "../site-header.tsx", "../pension-panel.tsx", "../savings-rule-panel.tsx"]) {
      expect(source(path), path).not.toMatch(/useWriteJudge|LastWriteContext/);
    }
  });
});
