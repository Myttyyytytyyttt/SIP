// SIP_SOLANA_CUTS: which of the cost cuts this process runs, one token per cut.
//
// THE DISPATCHER ADR'S FLAG (§2.2, §6.1; rollout L1b). Every cut that changes
// what the keeper asks a provider for, or when, is switched on by naming its
// token here, and switched off — the whole rollback — by removing it. Nothing
// is on by default: an empty or absent variable is the keeper exactly as it was
// before any of these existed, request for request.
//
// ONLY THE TOKENS THIS BUILD IMPLEMENTS ARE ACCEPTED. The ADR lists more
// (`jupiter-key`, `invest-batch`, `explicit-send`, …); they land
// with their own code, each on its own soak, and until then naming one REFUSES
// TO START. A token that is accepted and does nothing is the one failure this
// list exists to prevent: the owner reads Railway, sees `invest-batch`, and
// believes the invest reads are being batched.
//
// THE FIRST THREE ARE OFF THE MONEY PATH. Each changes how a fact is read — the
// link list, a wallet's Privy record, when the rankings are recomputed — and
// never what is settled, for whom, or how much (ADR §6.2, L1b non-money).
//
// `rest-skip` SOAKS AS A MONEY CUT (ADR §2.3.2, RT-24) although it builds and
// sends nothing: it decides when a settle is LOOKED FOR, so a wrong memo would
// delay one. It cannot double one or change its amount — a memo only ever
// returns a resting IDLE (src/rest-book.ts). The ADR's rule of one money change
// switched on at a time applies to it.
//
// L3 IS NOT A TOKEN. The last-known-good link list carries a number, how old a
// list it may fall back to, so it has a variable of its own
// (SIP_SOLANA_DISCOVERY_LKG_MS, ADR §6.2 L3), read here beside the tokens and by
// the same strict rule: 0 or unset is off, which is today.

/**
 * The cuts this build implements, in the ADR's rollout order.
 *
 *   * `gpa-v2` (C6): discovery through Helius's paginated getProgramAccountsV2,
 *     with today's getProgramAccounts as the fallback IN THE SAME SWEEP
 *     (src/discovery.ts, discoverLinksPreferringV2).
 *   * `privy-address` (C8): each wallet's Privy record by its address, cached,
 *     instead of listing every Solana wallet in the app every sweep, and never a
 *     per-wallet full scan (src/privy-address-book.ts).
 *   * `board-timer`: the rankings recomputed at most every
 *     BOARD_REFRESH_MIN_GAP_MS after a settlement, one in flight and one queued,
 *     instead of once per SETTLED (src/board-refresh.ts).
 *   * `rest-skip` (C4): a link resting on its own settle, whose probe shows the
 *     same newest signature for the same link state as the walk that last
 *     proved it, returns that walk's IDLE without walking again: 1 call instead
 *     of 3 (src/rest-book.ts). The dispatcher plan (§3.2) switches it on after
 *     `jupiter-key`, a money cut this build does not have yet.
 */
export const CUT_TOKENS = ["gpa-v2", "privy-address", "board-timer", "rest-skip"] as const;

export type CutToken = (typeof CUT_TOKENS)[number];

/** The longest last-known-good list SIP_SOLANA_DISCOVERY_LKG_MS may ask for: an hour. */
export const DISCOVERY_LKG_MAX_MS = 60 * 60 * 1_000;

const isCutToken = (value: string): value is CutToken => (CUT_TOKENS as readonly string[]).includes(value);

/**
 * SIP_SOLANA_CUTS, read strictly: a comma-separated list of tokens, case and
 * surrounding spaces as written, each one of CUT_TOKENS.
 *
 * AN UNKNOWN TOKEN REFUSES TO START, as an unknown SIP_SOLANA_ROLE does: a
 * misspelt cut is not "no cut", it is a deploy that the owner believes changed
 * something. The refusal names the position and the shape, never the value
 * (config.ts's rule, although no token is a secret: the variable is read beside
 * ones that are, and the habit is the protection).
 *
 * A REPEATED TOKEN IS REFUSED TOO. It is harmless, and it is also the sign of a
 * hand-edited list nobody re-read; the rollback is "remove the token", and a
 * list holding it twice survives the first removal.
 */
export function readCuts(raw: string | undefined): { readonly cuts: ReadonlySet<CutToken> } | { readonly problems: readonly string[] } {
  const value = raw?.trim();
  if (value === undefined || value === "") return { cuts: new Set() };
  const problems: string[] = [];
  const cuts = new Set<CutToken>();
  value.split(",").forEach((entry, index) => {
    const token = entry.trim();
    const position = index + 1;
    if (!isCutToken(token)) {
      problems.push(
        `SIP_SOLANA_CUTS entry #${position} is not a cut this keeper implements (${CUT_TOKENS.join(", ")}); ` +
          `it holds ${token === "" ? "an empty value" : `a ${token.length}-character value`}.`,
      );
      return;
    }
    if (cuts.has(token)) {
      problems.push(`SIP_SOLANA_CUTS entry #${position} repeats a token an earlier entry already names.`);
      return;
    }
    cuts.add(token);
  });
  return problems.length > 0 ? { problems } : { cuts };
}

/**
 * SIP_SOLANA_DISCOVERY_LKG_MS: how old a last-known-good link list a sweep may
 * fall back to when the listing fails (L3). 0 or unset is OFF, which is today:
 * a failed listing fails the sweep.
 *
 * AN INTEGER NUMBER OF MILLISECONDS, AT MOST AN HOUR. The ADR's value after go
 * is 600000. The ceiling is not about cost — a fallback sweep re-reads every
 * cached link fresh — but about what a stale list cannot see: a link created
 * during the outage is found only by a listing, and an hour is already sixty
 * sweeps of it being invisible. Past that, failing loudly is the better answer.
 */
export function readDiscoveryLkgMs(raw: string | undefined): { readonly ms: number } | { readonly problem: string } {
  const value = raw?.trim();
  if (value === undefined || value === "") return { ms: 0 };
  const parsed = /^[0-9]+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed > DISCOVERY_LKG_MAX_MS) {
    return {
      problem:
        `SIP_SOLANA_DISCOVERY_LKG_MS must be 0 (off) or an integer number of milliseconds up to ${DISCOVERY_LKG_MAX_MS}; ` +
        `it holds a ${value.length}-character value.`,
    };
  }
  return { ms: parsed };
}
