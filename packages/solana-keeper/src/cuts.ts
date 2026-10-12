// SIP_SOLANA_CUTS: which of the cost cuts this process runs, one token per cut.
//
// THE DISPATCHER ADR'S FLAG (§2.2, §6.1; rollout L1b). Every cut that changes
// what the keeper asks a provider for, or when, is switched on by naming its
// token here, and switched off — the whole rollback — by removing it. Nothing
// is on by default: an empty or absent variable is the keeper exactly as it was
// before any of these existed, request for request.
//
// ONLY THE TOKENS THIS BUILD IMPLEMENTS ARE ACCEPTED. The ADR lists more
// (`lamports-filter`, …); they land with their own code, each on its own
// soak, and until then naming one REFUSES TO START. A token that is accepted and
// does nothing is the one failure this list exists to prevent: the owner reads
// Railway, sees `lamports-filter`, and believes the vault reads are being
// filtered.
//
// THE FIRST THREE ARE NOT ON THE MONEY PATH. Each changes how a fact is read —
// the link list, a wallet's Privy record, when the rankings are recomputed — and
// never what is settled, for whom, or how much (ADR §6.2, L1b non-money).
//
// THE REST ARE, ONE TOKEN EACH, and the ADR's rule for them is that only one
// soaks at a time (§6.1 rule 1): a money token changes whether, when or how a
// buy is sent, so each has its own go gate and its rollback is removing it. They
// are listed after the non-money three, in the order they are switched on
// (the dispatcher plan §3.2: jupiter-key → rest-skip → invest-batch →
// explicit-send).
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
//
// NOR IS L2. Where the loss carries live (SIP_SOLANA_CARRY_STORE, ADR §4.6) has
// three phases, off, dual and on, and is read here by the same rule: unset is
// off, which is today, and anything unknown refuses to start.

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
 *
 *   MONEY PATH, one at a time:
 *
 *   * `jupiter-key` (J1 + P8, ADR §6.2 L1b-m1): every Jupiter call of a buying
 *     turn through api.jup.ag with SIP_SOLANA_JUPITER_API_KEY when one is set
 *     (today's host otherwise), paced, with the turn's calls RESERVED before its
 *     first one — a turn the budget cannot cover ends DEFERRED having moved
 *     nothing — and a backoff after a 429 (src/jupiter-pacer.ts).
 *   * `rest-skip` (C4): a link resting on its own settle, whose probe shows the
 *     same newest signature for the same link state as the walk that last
 *     proved it, returns that walk's IDLE without walking again: 1 call instead
 *     of 3 (src/rest-book.ts). Switched on after `jupiter-key` (plan §3.2).
 *   * `invest-batch` (C5 with C2 inside, ADR §2.3.3, §6.2 L1b-m3): the invest
 *     turn's at-rest reads — the policy, the vault's wSOL and USDC balances,
 *     the Clock, both Pyth feeds, the EpochSchedule — folded into the sweep's
 *     one vault batch, and the rent floor cached per size. The snapshot may only
 *     decide a turn that sends nothing; one that would act is run again on
 *     fresh reads, so every transaction is built as today
 *     (src/invest-snapshot.ts). The profit keeper's census goes 19 → 7.
 *   * `explicit-send` (L1d, ADR §4.3, §6.2): the wrap, the convert and every
 *     leg sent in the keeper's own order — blockhash, build, sign, ask, send,
 *     poll — with isLive() asked before EACH send, no wrap/convert/invest for
 *     75 s after taking the claim, and a SIGTERM drain; the bytes are Anchor's
 *     (src/explicit-send.ts).
 */
export const CUT_TOKENS = [
  "gpa-v2",
  "privy-address",
  "board-timer",
  "jupiter-key",
  "rest-skip",
  "invest-batch",
  "explicit-send",
] as const;

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
 * SIP_SOLANA_CARRY_STORE's phases, in rollout order (ADR §4.6, rollout L2):
 * where the losses zero settles carry forward are kept. NOT A TOKEN, for L3's
 * reason: it has three values, not on and off. `off` is today — memory, and a
 * restart forgets a pending carry; the store itself is src/carry-store.ts.
 */
export const CARRY_STORE_MODES = ["off", "dual", "on"] as const;
export type CarryStoreMode = (typeof CARRY_STORE_MODES)[number];

/**
 * SIP_SOLANA_CARRY_STORE, read strictly: unset or blank is `off`; otherwise
 * exactly `off`, `dual` or `on`, as written. Anything else REFUSES TO START, by
 * shape and never by value, as an unknown token does: an `On` that quietly meant
 * memory would be an owner who believes a restart no longer forgets a loss.
 */
export function readCarryStore(raw: string | undefined): { readonly mode: CarryStoreMode } | { readonly problem: string } {
  const value = raw?.trim();
  if (value === undefined || value === "") return { mode: "off" };
  if ((CARRY_STORE_MODES as readonly string[]).includes(value)) return { mode: value as CarryStoreMode };
  return {
    problem: `SIP_SOLANA_CARRY_STORE must be one of ${CARRY_STORE_MODES.join(", ")}; it holds a ${value.length}-character value.`,
  };
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
