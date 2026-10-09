"use client";

/**
 * WHAT JUST ARRIVED, SPOKEN (10-09, plan P3). The wash on a new row and the
 * hero's pill are decoration; this is what a screen reader hears of them — one
 * polite announcement per update that brought something, and nothing on a
 * first paint, an older page, a backfilled settlement or a new price
 * (use-arrivals.ts decides all of that once, for every surface).
 *
 * IN THE CHAIN'S OWN AMOUNTS: "Saved 0.0366 SOL from Trading wallet 1.",
 * "Converted 0.0366 SOL to 3.67 USDC.", "Bought SPYx and ANTHROPIC.", "Saving
 * rule changed." Dollars are re-priced on every update, so they are not news.
 * Three or more transactions in one update, or one this has no sentence for
 * (a wrap, a withdrawal, a transfer in, a failure), are a count instead —
 * "4 new transactions on your pension." — never a guess at what they were.
 *
 * NEVER THE STEPS. The steps over the feed have a region of their own
 * (LivePending.tsx), and their "done" rows are aria-hidden so that what landed
 * is said here, once.
 *
 * ONE REGION FOR THE PAGE, always mounted and empty until something arrives: a
 * region must exist before what it announces. Each announcement is its own
 * node, keyed by the update that brought it, so the same words on a later
 * update are still read out; and the words are fixed when the update lands, so
 * a wallet's label loading later cannot read the same news out twice. No
 * counter, no control and nothing that ticks is ever inside it.
 */

import { useRef } from "react";

import type { ArrivalNews } from "@/components/live/use-arrivals";
import { formatSol, formatUsd, rawFrom } from "@/lib/amounts";
import { LIVE_COPY } from "@/lib/live-copy";
import { namesOf } from "@/lib/live-pending";
import { symbolOfMint } from "@/lib/live-symbols";
import type { LiveRow } from "@/lib/live-types";

/** More transactions than this in one update are counted, not listed. */
const LISTED_AT_MOST = 2;

/** One row's sentence, or null when it has none of its own. */
function sentenceOf(row: LiveRow, labelOf: (wallet: string | null) => string): string | null {
  if (!row.ok) return null;
  const event = row.event;
  switch (event.kind) {
    case "settled": {
      const paid = rawFrom(event.paid);
      // A settlement that moved nothing is counted, not called a saving.
      return paid === null || paid <= 0n ? null : LIVE_COPY.announce.saved(formatSol(paid), labelOf(event.wallet));
    }
    case "converted": {
      const spent = rawFrom(event.lamportsSpent);
      const received = rawFrom(event.usdcReceivedRaw);
      // An amount the chain did not give is never filled in.
      return spent === null || received === null ? null : LIVE_COPY.announce.converted(formatSol(spent), formatUsd(received).replace("$", ""));
    }
    case "rule_changed":
      return LIVE_COPY.announce.ruleChanged;
    default:
      return null;
  }
}

/**
 * The words for what one update brought, oldest first, or null when it brought
 * nothing. Buys are one sentence however many legs they took.
 */
export function announcementOf(rows: readonly LiveRow[], labelOf: (wallet: string | null) => string): string | null {
  if (rows.length === 0) return null;
  const transactions = new Set(rows.map((row) => row.signature)).size;
  const count = LIVE_COPY.announce.count(transactions);
  if (transactions > LISTED_AT_MOST) return count;

  const sentences: string[] = [];
  const bought: string[] = [];
  let boughtAt: number | null = null;
  for (const row of [...rows].sort((left, right) => left.slot - right.slot)) {
    if (row.ok && row.event.kind === "invested") {
      const symbol = row.event.symbol ?? symbolOfMint(row.event.mint);
      if (symbol !== null && !bought.includes(symbol)) bought.push(symbol);
      boughtAt ??= sentences.length;
      continue;
    }
    const sentence = sentenceOf(row, labelOf);
    // One the announcer cannot word: the count says it rather than a guess.
    if (sentence === null) return count;
    sentences.push(sentence);
  }
  if (boughtAt !== null) sentences.splice(boughtAt, 0, LIVE_COPY.announce.bought(namesOf(bought)));
  return sentences.join(" ");
}

export function LiveAnnouncer({ news, labelOf }: { readonly news: ArrivalNews | null; readonly labelOf: (wallet: string | null) => string }) {
  // Worded once per update: `labelOf` is a new function on every render.
  const said = useRef<{ readonly seq: number; readonly words: string | null } | null>(null);
  if (news !== null && said.current?.seq !== news.seq) said.current = { seq: news.seq, words: announcementOf(news.rows, labelOf) };
  const current = said.current;

  return (
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-live-announcer="">
      {current === null || current.words === null ? null : <span key={current.seq}>{current.words}</span>}
    </p>
  );
}
