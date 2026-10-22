/**
 * THE FIGURES A SHARE CARD TAKES FROM A LIVE PENSION, AND THE STREAK'S PROOF
 * (owner, 10-22: "Post on X" posts a link whose preview is the card, and the
 * figures in it are the server's, read from the chain — nobody can mint a card
 * with a figure of their own choosing).
 *
 * ONE PLACE FOR THEM, TWO READERS. The Live page reads them through
 * toDashboardMock (live-mock.ts) to draw its hero and its rule card; the share
 * route reads them from a snapshot of its own (lib/share-server.ts) to sign the
 * link. Both call the functions below, so the dollars, the month, the rule and
 * the streak are worked out one way only. live-mock.ts could not be the shared
 * home: it imports from a "use client" component (LiveActivityRow.tsx), and a
 * route that imported it would be handed client references. Pure, and
 * server-safe, like invest-limits.ts.
 *
 * THE STREAK IS THE ONE FIGURE A SNAPSHOT CANNOT GIVE: it is counted from the
 * days the loaded history covers, and every browser loads its own. So the
 * server does not re-read a history; it checks a claim. The browser sends one
 * settlement of each day of its streak (streakProofOf), the server reads those
 * transactions itself and counts the days the PROGRAM says this vault was paid
 * on (provenStreakOf). An honest claim comes back as the same number; anything
 * else, and the card says nothing about a streak — never a zero.
 *
 * Types from '@/mocks/types' only: no-mock-import.test.ts scans lib/live-*.
 */

import { classifyVaultEntry, scopeEntryToVault, type ClassifiableEntry } from "@sip/solana-core/client";

import { rawFrom, usdcRawForLamports } from "@/lib/amounts";
import { artForMint } from "@/lib/asset-art";
import { SHARE_STREAK_CAP, type ShareCardInput } from "@/lib/live-share";
import type { LiveDashboard, VaultEventJson } from "@/lib/live-types";
import type { SavingsRule } from "@/mocks/types";

export const DAY_MS = 86_400_000;
const USDC_UNIT = 1_000_000;

/**
 * The sample's streaks, computed the sample's way (src/mocks/data.ts): today
 * is not over, so an empty today does not break the current one.
 */
export function streaksOf(days: readonly { readonly lamports: bigint }[]): { readonly current: number; readonly longest: number } {
  let current = 0;
  let index = days.length - 1;
  if (index >= 0 && days[index]!.lamports === 0n) index -= 1;
  for (; index >= 0 && days[index]!.lamports > 0n; index -= 1) current += 1;
  let longest = 0;
  let run = 0;
  for (const day of days) {
    run = day.lamports > 0n ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return { current, longest };
}

/** Lamports as dollars at the ONE price this snapshot read; null when it read none (live-mock.ts says why today's price). */
export function dollarsAtSnapshot(data: LiveDashboard): (lamports: bigint | null | undefined) => number | null {
  const perSol = rawFrom(data.prices?.usdcRawPerSol);
  return (lamports) => (lamports === null || lamports === undefined || perSol === null ? null : Number(usdcRawForLamports(lamports, perSol)) / USDC_UNIT);
}

/** The vault's creation, in ms; null when the chain did not say. Where "saving since" starts. */
export const createdMsOf = (data: LiveDashboard): number | null =>
  data.vault.createdAt === null || data.vault.createdAt <= 0n ? null : Number(data.vault.createdAt) * 1_000;

/** "Saving since": the vault's creation as an ISO instant, or null. */
export function firstSaveAtOf(data: LiveDashboard): string | null {
  const created = createdMsOf(data);
  return created === null ? null : new Date(created).toISOString();
}

/** The current streak over the days the loaded history covers; null while it covers none (a dash, not 0). */
export const currentStreakOf = (data: LiveDashboard): number | null => (data.stats.dailySaved.length === 0 ? null : streaksOf(data.stats.dailySaved).current);

/** The rule as the sample's components draw it: the vault's mode, rate and pause, and the policy's basket. */
export function liveRuleOf(data: LiveDashboard, thresholdUsd: number | null): SavingsRule {
  const { vault, policy } = data;
  return {
    mode: vault.mode === 1 ? "volume" : "profit",
    rateBps: vault.rateBps ?? 0,
    thresholdUsd,
    targets: policy.legs.map((leg) => ({ symbol: leg.symbol, logo: artForMint(leg.mint) ?? undefined, weightBps: leg.weightBps })),
    paused: vault.paused === true,
  };
}

/**
 * EVERYTHING shareCardOf TAKES, from one LiveDashboard: what LiveBody hands it
 * from the page, and what the share route hands it from its own snapshot.
 * `streak` replaces the history's count — the route's proven one.
 */
export function shareInputOf(data: LiveDashboard, streak: number | null = currentStreakOf(data)): ShareCardInput & { readonly lifetimeSaved: bigint | null } {
  return {
    lifetimeSaved: data.vault.lifetimeSaved,
    stats: { totalSavedUsd: dollarsAtSnapshot(data)(data.vault.lifetimeSaved), firstSaveAt: firstSaveAtOf(data), currentStreakDays: streak },
    rule: liveRuleOf(data, null),
    now: new Date(data.nowMs).toISOString(),
  };
}

type SettledEventJson = Extract<VaultEventJson, { kind: "settled" }>;

const dayOfSeconds = (blockTime: number): string => new Date(blockTime * 1_000).toISOString().slice(0, 10);

/**
 * THE STREAK'S PROOF, AS THIS BROWSER CAN GIVE IT: one settlement signature for
 * each day of the current run, newest first, at most SHARE_STREAK_CAP of them.
 * The days are the ones streaksOf counted (stats.dailySaved), and each one's
 * signature is a settlement the page holds for it (settlementRows, both
 * streams). Nothing when there is no streak to state (under two days, which
 * the card does not print), and nothing when a day has no settlement here to
 * show for it: a shorter proof would prove a shorter streak, and a card that
 * says "5 days" of a 7-day run is wrong too.
 */
export function streakProofOf(data: LiveDashboard): readonly string[] {
  const days = data.stats.dailySaved;
  const run: string[] = [];
  let index = days.length - 1;
  if (index >= 0 && days[index]!.lamports === 0n) index -= 1;
  for (; index >= 0 && days[index]!.lamports > 0n && run.length < SHARE_STREAK_CAP; index -= 1) run.push(days[index]!.day);
  if (run.length < 2) return [];
  const byDay = new Map<string, string>();
  for (const row of data.settlementRows) {
    if (!row.ok || row.blockTime === null || row.event.kind !== "settled") continue;
    if (BigInt((row.event as SettledEventJson).paid) <= 0n) continue;
    const day = dayOfSeconds(row.blockTime);
    if (!byDay.has(day)) byDay.set(day, row.signature);
  }
  const proof = run.map((day) => byDay.get(day));
  return proof.every((signature): signature is string => signature !== undefined) ? proof : [];
}

/**
 * THE DAY ONE TRANSACTION PROVES, or null: its UTC day number (days since the
 * epoch, by the transaction's own block time) when it is, by the program's own
 * words, a settlement INTO THIS VAULT that paid something — the Settled event's
 * vault and settle_v2's `vault` account (scopeEntryToVault). A signature of
 * somebody else's settlement, a failed one, one nobody could read, or any other
 * instruction proves nothing here.
 */
export function settledDayOf(entry: ClassifiableEntry, vault: string): number | null {
  if (!entry.readable || !entry.ok || entry.blockTime === null) return null;
  const scoped = scopeEntryToVault(entry, vault);
  if (scoped === null) return null;
  if (!classifyVaultEntry(scoped).some((event) => event.kind === "settled" && event.paid > 0n)) return null;
  return Math.floor((entry.blockTime * 1_000) / DAY_MS);
}

/** The current run over proven days (UTC day numbers), by streaksOf's own rule, against `nowMs`'s day. A day after today proves nothing. */
export function streakOfDays(proven: Iterable<number>, nowMs: number): number {
  const today = Math.floor(nowMs / DAY_MS);
  const paid = new Set([...proven].filter((day) => day <= today));
  if (paid.size === 0) return 0;
  const first = Math.min(...paid);
  return streaksOf(Array.from({ length: today - first + 1 }, (_, offset) => ({ lamports: paid.has(first + offset) ? 1n : 0n }))).current;
}

/** THE STREAK THE CHAIN PROVES, from transactions the server read itself: the days they prove, counted against the server's today. */
export function provenStreakOf(entries: readonly ClassifiableEntry[], vault: string, nowMs: number): number {
  return streakOfDays(
    entries.map((entry) => settledDayOf(entry, vault)).filter((day): day is number => day !== null),
    nowMs,
  );
}
