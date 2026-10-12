// C7, THE `lamports-filter` TOKEN: a link whose wallet has not moved is not
// probed for real, for up to thirty minutes (dispatcher ADR §2.3.4, with RT-19;
// [CUTS] §3.5; plan §3.3.1 "C7 inside the scheduler's batch read").
//
// WHY IT EXISTS. A safety or full-pass turn of a quiet link costs a worker job
// whose first act is getSignaturesForAddress on the wallet — an archival call —
// to learn that nothing happened. The scheduler's batch already reads every
// turned vault; reading each turned link's WALLET ACCOUNT and its wSOL ATA in the
// same kind of batch costs a standard read per hundred accounts, and a wallet
// that traded has, almost always, a different lamport balance: it paid a fee.
// The filter's real value is robustness (ADR §2.3.4): it makes the bill
// independent of whether the doorbell is trusted. An untrusted doorbell turns
// every link every tick, and with C7 that costs a batch read, not N probes.
//
// WHEN A REAL PROBE IS SKIPPED — ALL OF THESE (canSkip, and the caller):
//   * the vault's last job rested (vault_work.rests), and the vault is in the
//     full or safety lane — never bell, busy or new (the caller, src/scheduler.ts);
//   * a MEMO exists for the link: the fingerprint read BEFORE a real probe that
//     then rested (below);
//   * the (lamports, wSOL) fingerprint read now equals the memo's;
//   * the batch's context slot is at or above the memo's: an endpoint that
//     lags after a failover could serve a state from before the probe;
//   * the link's (nonce, frontier) are the memo's: a settle moved neither;
//   * the memo's real probe was less than C7_REAL_PROBE_MS ago.
//
// THE MEMO IS THE FINGERPRINT READ BEFORE THE PROBE, NEVER AFTER IT. The
// scheduler reads the fingerprint at slot S, then enqueues the vault; a worker
// claims it and probes at T > S. If that job rests, everything up to T was seen
// and nothing was owed, so any later transaction the wallet signs moves its
// lamports away from the state at T — and the memo holds the state at S, which
// the probe vouched for. A fingerprint read AFTER the job would bake in whatever
// happened between the probe and the read, and skip it forever: that is the
// mistake this ordering exists to rule out (test/lamports-filter.test.ts runs it
// against the real settle turn over random histories). A job is matched to the
// read before it by time: its claimed_at must be after the enqueue, both on the
// database's clock.
//
// THE DELAY CLASSES, NEVER LOSSES ([CUTS] §3.5): a token-only swap someone else
// paid the fee for, a stranger's zero-value transfer, and wSOL held outside the
// ATA leave the fingerprint as it was. Each is caught by the bell, or by the real
// probe that is due at most C7_REAL_PROBE_MS after the last one. A settle is
// delayed, never doubled and never lost: the frontier only moves when a settle
// lands, and the next real probe walks from it.
//
// THE POST-BOOT STAGGER (RT-19). A scheduler that takes the lock has no memos,
// so its first pass probes everybody for real; with realProbeAt = that moment,
// every link's next forced probe would land in the same tick thirty minutes
// later — at N = 1,000, a thousand archival calls in one tick. So the memos of
// that first pass are dated back by a phase spread EVENLY over the pass:
// links ordered by sha256(link) — the ADR's "hash(link) mod 30 min", made
// even — get phase = rank × pass / N, and realProbeAt = takeover − phase. Over
// the hour after a takeover each tick then makes at most ⌈N × tick / pass⌉
// forced probes, plus bells. (A plain hash mod 30 min bunches by chance: at
// N = 1,000 some minute would carry ~45 where the rank spread carries 34.)
//
// IN MEMORY, PER PROCESS, as the ADR has it: a scheduler that takes over starts
// empty and probes everybody once. Nothing here reads a clock or the chain.

import { createHash } from "node:crypto";
import { SAFETY_PASS_MS } from "./doorbell.js";

/** The longest a link goes without a real probe under the filter: thirty minutes, the safety pass (ADR §2.3.4). */
export const C7_REAL_PROBE_MS = SAFETY_PASS_MS;

/** What the filter compares for one link. */
export interface LinkFingerprint {
  /** The wallet account's lamports (0 for an account the chain does not have). */
  readonly lamports: bigint;
  /** The wallet's wSOL ATA balance (0 when it has none). */
  readonly wsol: bigint;
  /** The context slot of the batch that read both. */
  readonly slot: number;
  /** The link's settlement nonce and frontier, as this tick's discovery read them. */
  readonly nonce: bigint;
  readonly frontier: bigint;
}

interface Memo {
  readonly fingerprint: LinkFingerprint;
  /** When its real probe ran, on the database's clock (ms) — or earlier, by the post-boot stagger. */
  readonly realProbeAt: number;
}

interface Pending {
  /** When the scheduler read these fingerprints and enqueued the vault (database clock, ms). */
  readonly at: number;
  readonly links: ReadonlyMap<string, LinkFingerprint>;
}

/** What a skip decision said, for /status and the tests. */
export type SkipVerdict =
  | { readonly skip: true }
  | { readonly skip: false; readonly reason: "no-memo" | "moved" | "slot-behind" | "settled" | "probe-due" };

/** What the scheduler sees of a vault's row when it settles a pending read. */
export interface JobObservation {
  /** claimed_at of the vault's last job (database clock, ms), or null. */
  readonly claimedAt: number | null;
  /** last_done_at, or null. */
  readonly doneAt: number | null;
  readonly rests: boolean | null;
  /** Whether a worker holds the vault now. */
  readonly held: boolean;
}

export interface LamportsFilterStatus {
  readonly memos: number;
  readonly pending: number;
  readonly skips: number;
  readonly probes: number;
  readonly committed: number;
  readonly dropped: number;
  /** Probes refused a skip, by reason, since boot. */
  readonly refusals: Readonly<Record<Exclude<SkipVerdict, { skip: true }>["reason"], number>>;
  readonly staggered: number;
}

/** sha256 of the link's address, as a hex string: the order the post-boot stagger spreads links in. */
export function linkHash(link: string): string {
  return createHash("sha256").update(link).digest("hex");
}

export class LamportsFilter {
  readonly #memos = new Map<string, Memo>();
  readonly #pending = new Map<string, Pending>();
  /** link → phase (ms) for the memos the first pass after a takeover will commit; null outside that pass. */
  #bootPhases: Map<string, number> | null = null;
  #bootAt: number | null = null;
  #skips = 0;
  #probes = 0;
  #committed = 0;
  #dropped = 0;
  #staggered = 0;
  readonly #refusals: Record<Exclude<SkipVerdict, { skip: true }>["reason"], number> = {
    "no-memo": 0,
    moved: 0,
    "slot-behind": 0,
    settled: 0,
    "probe-due": 0,
  };

  constructor(readonly realProbeMs: number = C7_REAL_PROBE_MS) {}

  /** The process took the lock: it trusts nothing it remembered. */
  takeover(): void {
    this.#memos.clear();
    this.#pending.clear();
    this.#bootPhases = null;
    this.#bootAt = null;
  }

  /**
   * The first pass after a takeover is about to enqueue `links` for a real
   * probe: their memos, when they come, are staggered (RT-19). Each link's phase
   * is its rank by sha256 over these links, spread evenly over the pass.
   */
  planBootPass(links: readonly string[], at: number): void {
    const ordered = [...new Set(links)].sort((a, b) => {
      const ha = linkHash(a);
      const hb = linkHash(b);
      return ha < hb ? -1 : ha > hb ? 1 : 0;
    });
    const n = ordered.length;
    this.#bootPhases = new Map(ordered.map((link, rank) => [link, Math.floor((rank * this.realProbeMs) / Math.max(1, n))]));
    this.#bootAt = at;
  }

  /** The phase planBootPass gave a link, or null: for the tests and /status. */
  bootPhase(link: string): number | null {
    return this.#bootPhases?.get(link) ?? null;
  }

  /**
   * Whether `link`'s real probe may be skipped this tick, from what was just
   * read. Only the memo's conditions: the lane and the vault's rest are the
   * caller's.
   */
  canSkip(link: string, current: LinkFingerprint, now: number): SkipVerdict {
    const memo = this.#memos.get(link);
    const verdict = ((): SkipVerdict => {
      if (memo === undefined) return { skip: false, reason: "no-memo" };
      const was = memo.fingerprint;
      if (current.nonce !== was.nonce || current.frontier !== was.frontier) return { skip: false, reason: "settled" };
      if (current.slot < was.slot) return { skip: false, reason: "slot-behind" };
      if (current.lamports !== was.lamports || current.wsol !== was.wsol) return { skip: false, reason: "moved" };
      if (!(now - memo.realProbeAt < this.realProbeMs)) return { skip: false, reason: "probe-due" };
      return { skip: true };
    })();
    if (verdict.skip) this.#skips += 1;
    else this.#refusals[verdict.reason] += 1;
    return verdict;
  }

  /**
   * The vault was enqueued for a job, after these fingerprints were read at
   * `at`. A newer read replaces an older one still pending: both came before
   * any probe that has not happened yet, and the newer is the closer.
   */
  enqueued(vault: string, links: ReadonlyMap<string, LinkFingerprint>, at: number): void {
    this.#probes += links.size;
    this.#pending.set(vault, { at, links });
  }

  /**
   * What the vault's row says now. A job claimed AFTER the pending read and
   * completed since: its rest commits the read as each link's memo, and a job
   * that did not rest drops them. Anything else keeps waiting.
   */
  observe(vault: string, row: JobObservation): "committed" | "dropped" | "waiting" | "none" {
    const pending = this.#pending.get(vault);
    if (pending === undefined) return "none";
    if (row.held || row.claimedAt === null || row.doneAt === null) return "waiting";
    if (!(row.claimedAt > pending.at) || row.doneAt < row.claimedAt) return "waiting";
    this.#pending.delete(vault);
    if (row.rests !== true) {
      for (const link of pending.links.keys()) this.#memos.delete(link);
      this.#dropped += pending.links.size;
      return "dropped";
    }
    for (const [link, fingerprint] of pending.links) {
      const phase = this.#bootPhases?.get(link);
      const staggered = phase !== undefined && this.#bootAt !== null && pending.at <= this.#bootAt;
      if (staggered) this.#staggered += 1;
      this.#memos.set(link, { fingerprint, realProbeAt: staggered ? this.#bootAt! - phase! : row.claimedAt });
      this.#committed += 1;
    }
    return "committed";
  }

  /** Forgets links and vaults discovery no longer lists. */
  prune(liveLinks: ReadonlySet<string>, liveVaults: ReadonlySet<string>): void {
    for (const link of this.#memos.keys()) if (!liveLinks.has(link)) this.#memos.delete(link);
    for (const vault of this.#pending.keys()) if (!liveVaults.has(vault)) this.#pending.delete(vault);
  }

  /** When a link's memo says its real probe ran, or null: for the tests. */
  realProbeAt(link: string): number | null {
    return this.#memos.get(link)?.realProbeAt ?? null;
  }

  status(): LamportsFilterStatus {
    return {
      memos: this.#memos.size,
      pending: this.#pending.size,
      skips: this.#skips,
      probes: this.#probes,
      committed: this.#committed,
      dropped: this.#dropped,
      refusals: { ...this.#refusals },
      staggered: this.#staggered,
    };
  }
}
