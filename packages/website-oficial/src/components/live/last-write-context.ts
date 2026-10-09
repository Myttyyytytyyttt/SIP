"use client";

/**
 * WHAT WAS JUST SIGNED, AND WHETHER THE PAGE SHOWS IT YET (10-09, plan B4).
 *
 * A signature lands — the rule saved from the gear, the first buy approved on
 * its card, the vault created in the wallets modal — and the dashboard went on
 * drawing the old rule, the old stage, the Create button, until its next
 * update came round: seconds that read as "it did not work". Nothing on the
 * page said an update was on its way.
 *
 * ONE RECORD FOR THE PAGE. Every write the page signs runs through
 * useVaultWrite (use-vault-actions.ts), which notes each one that LANDS here:
 * its signature, the slot it landed in, when, what kind, and who signed it.
 * The record lives in LastWriteHost, which wallets-host.tsx mounts around the
 * whole dashboard, because the vault is created inside the wallets modal —
 * beside the page, not in it — and the live body would never see that write
 * otherwise.
 *
 * THE LIVE BODY JUDGES IT, ONCE (useWriteJudge): only it holds what the page
 * shows. Its verdict, by `syncStateOf`:
 *
 *   shown     the page's snapshot was read at or past the write's slot — or,
 *             with no slot on either side, its signature is among the rows.
 *             Nothing to say: the new rule, the new stage is on screen.
 *   syncing   neither yet: "Signed · updating your pension…", turning.
 *   late      two whole updates (`live.readId`) have landed since the page
 *             first saw the write, or a minute has passed, and it is still not
 *             shown: "Signed at 14:32 UTC · not on this page yet", the still
 *             clock of a wait — never "updating" with no update known to be
 *             bringing it. Gone after SYNC_LATE_HIDE_MS: a line is never left
 *             standing for good over a page that may well show it in a way
 *             this test cannot see.
 *
 * The verdict goes to the cards the live body draws as a prop, and back up to
 * the host, so the wallets modal's own success line can say the page is
 * updating too (useWriteSyncing). Outside a live page nothing judges, and
 * nothing is said: /wallets and the sample never claim an update.
 *
 * WHO SAYS IT — one mark per fact:
 *   the rule card     a rule or a basket signed anywhere but the first-buy
 *                     card, beside "Rate" (ruleCardWrite);
 *   the first-buy     its own approval, on its success line, and the card held
 *   card              up until the page shows it;
 *   the next step     a write that moves its stage — the vault created, a
 *                     wallet linked — in place of the button that would sign
 *                     it again (stageWrite);
 *   a success line    the write it is about, while it is syncing (TxProgress).
 */

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import type { WriteKind, WriteProgress } from "@/hooks/use-vault-actions";
import { whenLabel } from "@/lib/format";
import { LIVE_COPY } from "@/lib/live-copy";
import type { LiveStage } from "@/lib/live-types";

/** A landed signature, as useVaultWrite noted it. */
export interface LastWrite {
  /** The pension key whose vault it wrote to: a page for another key never says it. */
  readonly pensionKey: string;
  readonly kind: WriteKind;
  /** Who signed it: useVaultWrite's key ("vault", "policy", START_BUYING_WRITER, "link:<address>"…). */
  readonly writer: string;
  readonly signature: string;
  /** The slot it landed in; null when the confirmation named none. */
  readonly slot: number | null;
  /** When it landed, on this browser's clock. */
  readonly at: number;
}

export type SyncState = "syncing" | "late";

/** The live page's verdict on the last write, while it has one to say. */
export interface WriteSync {
  readonly write: LastWrite;
  readonly state: SyncState;
}

/** The first-buy card's writer (LiveStartBuying.tsx): its approval is said on that card, not on the rule card. */
export const START_BUYING_WRITER = "start-buying";

/** From "updating" to "not on this page yet": a minute after the landing… */
export const SYNC_CAP_MS = 60_000;
/** …or two whole updates since the page first saw it. */
export const SYNC_CAP_READS = 2;
/** And the still line goes after a quarter of an hour, as a wallet's own "no saving yet" does. */
export const SYNC_LATE_HIDE_MS = 15 * 60_000;

/** What the page has on screen, as the judge needs it. */
export interface PageRead {
  /** Whole updates since the live store mounted (LiveLiveness.readId). */
  readonly readId: number;
  /** The slot the snapshot on screen was read at (LiveDashboard.slot). */
  readonly slot: number | null;
  /** The vault's rows on screen, the hidden ones too: the fallback when a slot is missing. */
  readonly rows: readonly { readonly signature: string }[];
}

/**
 * WHETHER THE PAGE ALREADY SHOWS THE WRITE. A snapshot read at or past the
 * slot it landed in has it, whether or not an update was in flight when it
 * landed. With no slot on either side, only its signature among the rows says
 * so — a transaction the history does not list stays unproven, and the cap
 * ends the wait.
 */
export function pageShows(write: LastWrite, page: Pick<PageRead, "slot" | "rows">): boolean {
  if (write.slot !== null && page.slot !== null) return page.slot >= write.slot;
  return page.rows.some((row) => row.signature === write.signature);
}

/**
 * THE VERDICT: null when there is nothing to say (shown, or long past),
 * "syncing" while an update may yet bring it, "late" past the cap.
 * `readIdAt` is the update count when this page first saw the write.
 */
export function syncStateOf(write: LastWrite, input: { readonly page: PageRead; readonly readIdAt: number; readonly now: number }): SyncState | null {
  if (pageShows(write, input.page)) return null;
  const age = input.now - write.at;
  if (age >= SYNC_LATE_HIDE_MS) return null;
  if (input.page.readId - input.readIdAt >= SYNC_CAP_READS || age >= SYNC_CAP_MS) return "late";
  return "syncing";
}

/** When the verdict next changes by time alone: the cap while syncing, the end of the still line once late. */
export function syncDueAt(sync: WriteSync): number {
  return sync.write.at + (sync.state === "syncing" ? SYNC_CAP_MS : SYNC_LATE_HIDE_MS);
}

/** Whether a host's own write is the one the page is still updating for: its success line says so (TxProgress `syncing`). */
export function syncingFor(sync: WriteSync | null, progress: WriteProgress): boolean {
  return sync !== null && sync.state === "syncing" && progress.phase === "finished" && progress.result.ok && progress.result.signature === sync.write.signature;
}

/** The words of a syncing line: the host's own while it updates, the still "not on this page yet" with when it landed once late. */
export function syncWords(sync: WriteSync, syncing: string, nowMs: number): string {
  return sync.state === "syncing" ? syncing : LIVE_COPY.syncing.late(whenLabel(sync.write.at, nowMs));
}

/** A write the rule card speaks for: its rule or its basket — except the first-buy card's approval, which that card says itself. */
export function ruleCardWrite(write: LastWrite): boolean {
  return (write.kind === "rule" || write.kind === "policy") && write.writer !== START_BUYING_WRITER;
}

/** The writes that move each stage of the next-step card on, so its button would sign the same thing again. */
const STAGE_WRITES: Partial<Record<LiveStage, readonly WriteKind[]>> = {
  no_vault: ["create"],
  no_trading_wallet: ["createLink", "importLink", "link"],
  not_linked: ["link", "createLink", "importLink"],
};

/** Whether this write is the one that moves `stage` on. */
export function stageWrite(stage: LiveStage, write: LastWrite): boolean {
  return STAGE_WRITES[stage]?.includes(write.kind) ?? false;
}

// ── the host's record ────────────────────────────────────────────────────────

export interface LastWriteValue {
  readonly write: LastWrite | null;
  /** The live page's verdict on `write`, as it last reported it; null with no live page judging. */
  readonly sync: WriteSync | null;
  readonly report: (sync: WriteSync | null) => void;
}

/** Notes a landed write. Its own context, and stable: every writer reads it, and none re-renders when the record moves. */
const NoteWriteContext = createContext<((write: LastWrite) => void) | null>(null);

/** The record and the verdict. Exported so a test can hand a page or a card one; the app always takes it from LastWriteHost. */
export const LastWriteContext = createContext<LastWriteValue | null>(null);

const sameSync = (a: WriteSync | null, b: WriteSync | null): boolean => a === b || (a !== null && b !== null && a.write === b.write && a.state === b.state);

/** The record, for the whole dashboard (wallets-host.tsx). */
export function LastWriteHost({ children }: { readonly children?: ReactNode }) {
  const [write, setWrite] = useState<LastWrite | null>(null);
  const [sync, setSync] = useState<WriteSync | null>(null);
  const note = useCallback((next: LastWrite) => setWrite(next), []);
  const report = useCallback((next: WriteSync | null) => setSync((held) => (sameSync(held, next) ? held : next)), []);
  const value = useMemo<LastWriteValue>(() => ({ write, sync, report }), [write, sync, report]);
  return createElement(NoteWriteContext.Provider, { value: note }, createElement(LastWriteContext.Provider, { value }, children));
}

/** How a writer notes its landing (use-vault-actions.ts); null outside a host, where nothing is noted. */
export const useNoteWrite = (): ((write: LastWrite) => void) | null => useContext(NoteWriteContext);

/**
 * THE LIVE BODY'S VERDICT on the last write to this pension, worked out once
 * per render from what it shows, re-checked when the cap comes due, and
 * reported to the host for the modal's success lines. Null when there is
 * nothing to say.
 */
export function useWriteJudge(page: PageRead & { readonly pensionKey: string }): WriteSync | null {
  const store = useContext(LastWriteContext);
  const held = store?.write ?? null;
  const write = held !== null && held.pensionKey === page.pensionKey ? held : null;

  // The update count when this page first saw the write: the cap counts updates from there.
  const [seen, setSeen] = useState<{ readonly signature: string; readonly readId: number } | null>(null);
  let readIdAt = write !== null && seen !== null && seen.signature === write.signature ? seen.readId : null;
  if (write !== null && readIdAt === null) {
    readIdAt = page.readId;
    setSeen({ signature: write.signature, readId: page.readId });
  }

  // Moves only when a cap comes due, to that deadline: a timer may wake a
  // millisecond early (use-hold.ts), and one judged a hair before it would
  // leave `due` unchanged — and no effect would set the timer again. The
  // deadline is the least `now` can be, so the verdict waking for it is the
  // one past it (review, 10-09).
  const [dueSeen, setDueSeen] = useState(0);
  const state = write === null || readIdAt === null ? null : syncStateOf(write, { page, readIdAt, now: Math.max(Date.now(), dueSeen) });
  const sync = useMemo<WriteSync | null>(() => (write === null || state === null ? null : { write, state }), [write, state]);

  const due = sync === null ? null : syncDueAt(sync);
  useEffect(() => {
    if (due === null) return undefined;
    const timer = setTimeout(() => setDueSeen(due), Math.max(0, due - Date.now()));
    return () => clearTimeout(timer);
  }, [due]);

  const report = store?.report ?? null;
  useEffect(() => {
    report?.(sync);
  }, [report, sync]);
  // A live page that goes away judges nothing: the modal stops saying "updating".
  useEffect(() => () => report?.(null), [report]);

  return sync;
}

/** For a host outside the live body (the wallets modal's cards): whether its own landed write is the one the page is updating for. */
export function useWriteSyncing(progress: WriteProgress): boolean {
  return syncingFor(useContext(LastWriteContext)?.sync ?? null, progress);
}
