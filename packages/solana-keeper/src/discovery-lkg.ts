// L3: a failed link listing stops failing the whole sweep.
//
// TODAY ONE REFUSED getProgramAccounts ENDS THE SWEEP. Discovery throws into the
// sweep's catch, sweep-failed pages critical, and nobody is turned — not the
// link whose window is waiting, not the vault with a deposit to invest. It
// happened as "overloaded" on 09-27 (dispatcher findings, scale §4): a listing
// is the heaviest read the keeper makes, and the first one a struggling
// provider sheds.
//
// THE FIX IS A MEMORY OF WHO, NEVER OF WHAT. When the listing fails, the sweep
// falls back to the ADDRESSES the last good listing returned, while that list is
// younger than SIP_SOLANA_DISCOVERY_LKG_MS, and re-reads every one of those
// accounts FRESH in batches of 100 (src/discovery.ts, rereadLinks). The
// attester signs a link's nonce and frontier, both of which move at every
// settle, so nothing a turn measures or attests may come from the cache — only
// the knowledge that the account exists. A closed link reads as nothing and is
// dropped; a link created during the outage is found by the next listing that
// succeeds, and charged nothing extra, because its window starts at its own
// frontier.
//
// IN MEMORY ONLY. A Postgres `keeper_link` table arrives with the queue (ADR
// §3.14 P5, L4). Boot always needs a fresh listing: a keeper that has never
// listed has nothing to fall back to, and fails as it does today.
//
// OFF IS TODAY, EXACTLY. With the limit at 0 nothing is remembered and the
// listing's own error propagates unchanged — the same sweep-failed, the same
// message.

import type { PublicKey } from "@solana/web3.js";
import type { Alert } from "./alerts.js";
import type { DiscoveryMethod, DiscoveryReport, ManagedLink } from "./discovery.js";

/** One condition for the sweep's own listing, like vault-read: it names nothing but the sweep. */
export const DISCOVERY_STALE_ALERT_KEY = "discovery-stale";

/**
 * How old the remembered list may be before a sweep that uses it pages: 10
 * minutes, the rollout's rule for discovery-stale ([ROLLOUT] §6 row 7, ADR §6.3:
 * warn at the first use, page when older than 10 min).
 *
 * BY AGE, NOT BY A STREAK OF FAILED LISTINGS. What the list costs is the links
 * created since it was kept, and that is a matter of time, not of how many
 * sweeps fit in it: a streak of three is three minutes at the default sweep —
 * a page inside the very outage L3 exists to absorb quietly — and fifteen at
 * SIP_SOLANA_SWEEP_MS=300000, where it never comes before the list expires.
 *
 * AT THE DEFAULT LIMIT THIS NEVER PAGES, AND THAT IS THE RULE TOO. With
 * SIP_SOLANA_DISCOVERY_LKG_MS at its post-go 600000, a list older than 10 minutes
 * is no longer used: the listing's own error propagates and sweep-failed pages,
 * as it does today. Only a limit set above 10 minutes reaches this page.
 */
export const DISCOVERY_STALE_CRITICAL_AGE_MS = 10 * 60 * 1_000;

/** Where a sweep's link list came from. */
export type DiscoverySource = "fresh" | "lkg";

export interface DiscoveryOutcome {
  readonly links: ManagedLink[];
  readonly source: DiscoverySource;
  /** The call that listed them: null on a last-known-good sweep, which listed nothing. */
  readonly method: DiscoveryMethod | null;
  /** Why V2 was not used, when the listing fell back to V1 (the gpa-v2 cut). */
  readonly fallbackReason?: string;
  /** How old the remembered list was, on a last-known-good sweep. */
  readonly lkgAgeMs: number | null;
  /** The listing's failure, on a last-known-good sweep. */
  readonly failure: unknown;
  /** Failed listings in a row, this one included; 0 on a fresh sweep. */
  readonly consecutiveFailures: number;
}

/** The discovery block of /status. No address, no URL: counts, ages and names of calls. */
export interface DiscoveryStatus {
  /** The last listing's call: "v1" today, "v2" or "v1-fallback" under the gpa-v2 cut. Null until one has succeeded. */
  readonly method: DiscoveryMethod | null;
  /** Why the last fallback to V1 happened, while the last listing was one. */
  readonly fallbackReason: string | null;
  /** Where the last sweep's links came from. Null until a sweep has discovered anything. */
  readonly source: DiscoverySource | null;
  /** SIP_SOLANA_DISCOVERY_LKG_MS; 0 is off. */
  readonly lkgMaxAgeMs: number;
  /** How old the remembered list is now; null when none is kept. */
  readonly lkgAgeMs: number | null;
  readonly consecutiveFailures: number;
  /** Sweeps since boot that used the remembered list. Any value above 0 is worth a look. */
  readonly lkgUses: number;
}

/**
 * The sweep's link list, with L3's fallback.
 *
 * ONE INSTANCE PER PROCESS, created at boot: it is the memory.
 */
export class LastKnownGoodDiscovery {
  private addresses: readonly PublicKey[] | null = null;
  private listedAt: number | null = null;
  private failures = 0;
  private uses = 0;
  private lastSource: DiscoverySource | null = null;
  private lastMethod: DiscoveryMethod | null = null;
  private lastFallbackReason: string | null = null;

  /** `maxAgeMs` is SIP_SOLANA_DISCOVERY_LKG_MS: 0 keeps nothing and falls back to nothing. */
  constructor(readonly maxAgeMs: number) {}

  /**
   * Lists the links, or falls back to the remembered list re-read fresh.
   *
   * WHAT PROPAGATES. With the limit at 0, with nothing remembered, or with a
   * list older than the limit: the LISTING'S OWN ERROR, unchanged, so the sweep
   * fails exactly as it does today and sweep-failed says what it always said.
   * When the fresh re-read itself fails, the listing's error too: the re-read
   * runs on the same endpoints and fails for the same reason, and the listing
   * is the read an operator knows to look for.
   *
   * THE LIST'S AGE IS THE LISTING'S, NOT THE RE-READ'S. A re-read confirms that
   * the remembered accounts still exist; it cannot find a new one. So a run of
   * last-known-good sweeps does not refresh the clock, and the limit bounds how
   * long a new link can stay unseen.
   */
  async discover(
    list: () => Promise<DiscoveryReport>,
    reread: (addresses: readonly PublicKey[]) => Promise<ManagedLink[]>,
    now: number,
  ): Promise<DiscoveryOutcome> {
    let report: DiscoveryReport;
    try {
      report = await list();
    } catch (listingError) {
      this.failures += 1;
      const age = this.listedAt === null ? null : now - this.listedAt;
      if (this.maxAgeMs === 0 || this.addresses === null || age === null || age > this.maxAgeMs) throw listingError;
      let links: ManagedLink[];
      try {
        links = await reread(this.addresses);
      } catch {
        throw listingError;
      }
      this.uses += 1;
      this.lastSource = "lkg";
      return { links, source: "lkg", method: null, lkgAgeMs: age, failure: listingError, consecutiveFailures: this.failures };
    }
    this.failures = 0;
    this.lastSource = "fresh";
    this.lastMethod = report.method;
    this.lastFallbackReason = report.fallbackReason ?? null;
    // REMEMBERED ONLY WHEN IT CAN BE USED: off keeps nothing, as today.
    if (this.maxAgeMs > 0) {
      this.addresses = report.links.map((link) => link.linkAddress);
      this.listedAt = now;
    }
    return {
      links: report.links,
      source: "fresh",
      method: report.method,
      ...(report.fallbackReason === undefined ? {} : { fallbackReason: report.fallbackReason }),
      lkgAgeMs: null,
      failure: null,
      consecutiveFailures: 0,
    };
  }

  status(now: number): DiscoveryStatus {
    return {
      method: this.lastMethod,
      fallbackReason: this.lastMethod === "v1-fallback" ? this.lastFallbackReason : null,
      source: this.lastSource,
      lkgMaxAgeMs: this.maxAgeMs,
      lkgAgeMs: this.listedAt === null ? null : now - this.listedAt,
      consecutiveFailures: this.failures,
      lkgUses: this.uses,
    };
  }
}

/**
 * The alert for a sweep that ran on the last-known-good list: a warning while
 * the list is at most DISCOVERY_STALE_CRITICAL_AGE_MS old — it stays on the box,
 * in the log and on /status — and critical once it is older.
 *
 * NOT CRITICAL AT FIRST, for vault-read's reason: the sweep that used the list
 * settled and invested everybody it knows about, from fresh reads, and refused
 * listings from a busy provider are weather. What it cannot see is a link
 * created since the list was kept, and ten minutes of that is worth a person.
 */
export function discoveryStaleAlert(consecutiveFailures: number, lkgAgeMs: number, detail: string): Alert {
  const critical = lkgAgeMs > DISCOVERY_STALE_CRITICAL_AGE_MS;
  return {
    key: DISCOVERY_STALE_ALERT_KEY,
    severity: critical ? "critical" : "warn",
    title: critical
      ? "The keeper cannot list its links; it is sweeping the last list it had"
      : "The link listing failed; this sweep used the last-known-good list",
    detail:
      `${consecutiveFailures} listing${consecutiveFailures === 1 ? "" : "s"} in a row failed. Every remembered link was re-read ` +
      `fresh, but the list is ${Math.round(lkgAgeMs / 1_000)} s old and a link created since is not seen until a listing ` +
      `succeeds: ${detail}`,
    context: { sweeps: consecutiveFailures, lkgAgeMs },
  };
}
