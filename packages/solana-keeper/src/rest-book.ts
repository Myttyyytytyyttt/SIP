// The `rest-skip` cut (C4): a link resting on its own settle skips the walk.
//
// TODAY (the cut off). A settle moves the frontier to the window's last slot, and
// the settle transaction itself lands ABOVE it: the next sweep's confirmed probe
// sees our own settle as the wallet's newest signature, so the turn reads
// getSlot("finalized"), walks one finalized page (and the anchor and the settle,
// from the walk cache once warm), and stops at the loop guard — "only our own
// settle since slot N" — without moving anything. Three calls a sweep, two of
// them archival, for every link that has settled once, forever, until its owner
// trades again. Both of the volume keeper's settled links pay exactly that in the
// census (disp-measure/census, 2026-10-12: 11 calls a sweep, 6 of them these two
// links' probes, getSlots and pages).
//
// WITH THE CUT. The turn that reached that stop writes a MEMO: the link's state
// (epoch, nonce, frontier), the newest signature its probe saw — which the walk
// also saw, finalized, as the newest above the frontier — and the stop's detail.
// The next turn whose probe answers THE SAME NEWEST SIGNATURE FOR THE SAME LINK
// STATE returns IDLE with THE SAME DETAIL and walks nothing: 1 call instead of 3.
// The same detail matters: the sweep logs a resting state only when its line
// changes, so a memo that worded it differently would log every resting wallet
// on the first skipped sweep.
//
// WHY THE ANSWER IS THE SAME ONE A WALK WOULD GIVE (dispatcher ADR §2.3.2; CUTS
// §3.2; INFERRED from Solana's commitment rules, and pinned by a differential
// property test in test/rest-book.test.ts).
//   * A memo is written only when the walk's newest finalized signature IS the
//     probe's newest confirmed one, and the walk found nothing above the frontier
//     but our own settles. So everything above the frontier was final and ours.
//   * A finalized slot's ancestors are final, and a block lands whole: a new
//     transaction for the wallet can only appear in a LATER slot, and the probe
//     answers newest first, so it can only appear as a NEW NEWEST SIGNATURE. Any
//     new signature misses the memo and walks.
//   * The link's state is part of the key. A frontier or a nonce moved by any
//     settle — this process's, or another container's in a deploy overlap — comes
//     from this sweep's discovery read and misses the memo. So does a relink (a
//     new epoch).
//   * A memo lives in this process only. A restart starts with an empty book, and
//     the first sweep pays one real walk per settled link (3 calls, plus 2
//     getTransaction while the walk cache is cold): about 4 calls per link per
//     restart against ~2 880 saved per link per day. Persisting it would put
//     Postgres in the read path to recover under 1 %, and is not done.
//
// WHAT A WRONG MEMO CAN DO: DELAY A SETTLE, NEVER DOUBLE ONE. The only way a memo
// answers differently from a walk is a probe that missed a newer transaction —
// an endpoint behind the one that served the walk. The memo then repeats a
// resting IDLE until the probe catches up, which is exactly what that same probe
// does today when it answers nothing above the frontier ("nothing since slot N").
// It never reaches a base, an attestation or a send: a memo only ever returns a
// resting state. And the opposite divergence favours the memo: a walk whose
// cached anchor was evicted and whose endpoint then answers null reports
// INCOMPLETE (our node's weather) where the memo, rightly, reports the rest.
//
// MONEY PATH FOR SOAK PURPOSES ONLY (ADR RT-24): it decides when a settle is
// looked for, so it soaks like a money cut, but it can neither build nor send one.

import type { ManagedLink } from "./discovery.js";

type RestLink = Pick<ManagedLink, "linkAddress" | "epoch" | "settlementNonce" | "frontierSlot">;

/** What one resting link's walk proved, and the words it said it in. */
interface RestMemo {
  readonly epoch: bigint;
  readonly settlementNonce: bigint;
  readonly frontierSlot: bigint;
  /** The probe's newest confirmed signature, which the walk also read, finalized, as the newest above the frontier. */
  readonly signature: string;
  /** The loop guard's detail, returned verbatim on every skipped turn. */
  readonly detail: string;
}

/** /status's view of the book: how many links rest on a memo, and what it has saved since boot. */
export interface RestBookStatus {
  /** Links holding a memo now. */
  readonly memos: number;
  /** Turns that returned from a memo instead of walking, since boot: each saved a getSlot and at least one page. */
  readonly skips: number;
  /** Memos written since boot: each is one real walk that ended on our own settle. */
  readonly recorded: number;
  /** Memos dropped because the probe, or the link, had moved on: each such turn walked. */
  readonly invalidated: number;
}

/**
 * The memos, by link address. One per link at most, and only while that link is
 * discovered (prune).
 */
export class RestBook {
  readonly #memos = new Map<string, RestMemo>();
  #skips = 0;
  #recorded = 0;
  #invalidated = 0;

  /**
   * The resting detail to return for `link` when its probe's newest signature is
   * `newestSignature`, or null when the turn must walk.
   *
   * EXACT, OR NOTHING. Every part of the key must match: the epoch, the nonce and
   * the frontier as this sweep read them, and the signature as this probe answered
   * it. A memo that misses is dropped on the spot — the link has moved on, and a
   * walk is about to say where to — so a stale one never waits for a prune.
   */
  restingDetail(link: RestLink, newestSignature: string): string | null {
    const key = link.linkAddress.toBase58();
    const memo = this.#memos.get(key);
    if (memo === undefined) return null;
    if (
      memo.signature === newestSignature &&
      memo.epoch === link.epoch &&
      memo.settlementNonce === link.settlementNonce &&
      memo.frontierSlot === link.frontierSlot
    ) {
      this.#skips += 1;
      return memo.detail;
    }
    this.#memos.delete(key);
    this.#invalidated += 1;
    return null;
  }

  /**
   * Records that a real walk of `link`, whose probe's newest signature was
   * `signature`, ended at the loop guard with `detail`. settle-tick.ts calls it
   * only when the walk's own newest finalized signature was that same one.
   */
  record(link: RestLink, signature: string, detail: string): void {
    this.#memos.set(link.linkAddress.toBase58(), {
      epoch: link.epoch,
      settlementNonce: link.settlementNonce,
      frontierSlot: link.frontierSlot,
      signature,
      detail,
    });
    this.#recorded += 1;
  }

  /** Forgets every link not in `linked` (link addresses, base58): the sweep calls it with the links it discovered. */
  prune(linked: ReadonlySet<string>): void {
    for (const key of [...this.#memos.keys()]) if (!linked.has(key)) this.#memos.delete(key);
  }

  status(): RestBookStatus {
    return { memos: this.#memos.size, skips: this.#skips, recorded: this.#recorded, invalidated: this.#invalidated };
  }
}
