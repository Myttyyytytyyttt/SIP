// ONE MESSAGE A DAY OF THE WARNINGS THAT NEVER LEFT THE BOX. Token
// `warn-digest` (src/cuts.ts); off, nothing here is built.
//
// WHY (ADR §4.10 amendment 2, RT-17). Only `critical` leaves the box by default
// (src/alerts.ts, minSeverity; SIP_SOLANA_ALERT_MIN_SEVERITY), and that is right
// for a page: a warning that wakes somebody is a warning that gets muted. The
// cost is that every warn this keeper raises — a wallet with no signer, a basket
// that cannot be bought, a crank running low, a sweep filling its interval —
// reaches nobody unless somebody reads the log. Several soak gates in the ADR
// are written in terms of exactly those signals.
//
// SO ONCE A DAY, AT DIGEST_HOUR_UTC, ONE MESSAGE: each KIND of warning raised
// since the last digest (alertFamily: `no-signer`, not forty wallet keys), how
// many keys of that kind, how many times it was raised, and when last — and
// whether that kind also paged. EVEN WHEN THERE IS NOTHING: "no warning was
// raised" is then the day's proof that the channel delivers, which the header of
// src/alerts.ts asks for — silence must never be the healthy state. A day with no
// digest is itself the signal: a keeper whose sweep stopped sends none.
//
// HOW IT LEAVES THE BOX. Through its own sender (bin/keeper.mts) with the same
// destination as every alert and a threshold of `warn`, so it reaches Telegram
// as a warn — what it summarizes — rather than dressed as a critical, which
// would teach the owner that a daily [CRITICAL] means nothing.
//
// WHAT IT COUNTS. Every warn the keeper RAISES after the dependency gate
// (src/dependency-watch.ts) — one count per raise, before the alerter's
// 30-minute dedupe, so a condition that stood for a day reads as raised about
// once per sweep. Criticals are not listed, they already paged; a kind that did
// both is marked. It lives in memory: a restart starts a new window, and the
// digest says when its window began.
//
// IT DECIDES NOTHING: it is a tap on the alerter, told after the fact.

import { alertFamily, type Alert, type Alerter } from "./alerts.js";

/** The hour, UTC, the digest goes out: 08:00 — 08:00 or 09:00 in Lisbon. */
export const DIGEST_HOUR_UTC = 8;

/** The key it is sent under, on its own sender. */
export const DIGEST_ALERT_KEY = "warn-digest";

/** At most this many kinds are listed; the rest are counted. Telegram caps a message at 4096 characters. */
export const DIGEST_MAX_KINDS = 15;

/** The first DIGEST_HOUR_UTC strictly after `now`. */
export function nextDigestAt(now: number): number {
  const at = new Date(now);
  const today = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), DIGEST_HOUR_UTC);
  return today > now ? today : today + 24 * 60 * 60 * 1_000;
}

/** The `ops.digest` block of /status. */
export interface WarnDigestStatus {
  readonly nextAt: string;
  readonly windowStartedAt: string;
  readonly lastSentAt: string | null;
  /** Kinds of warning raised in the open window, and raises in all. */
  readonly kinds: number;
  readonly raised: number;
}

interface Kind {
  readonly keys: Set<string>;
  warns: number;
  paged: boolean;
  lastAt: number;
}

const hhmm = (at: number): string => new Date(at).toISOString().slice(11, 16) + "Z";

export class WarnDigest {
  #windowStartedAt: number;
  #nextAt: number;
  #lastSentAt: number | null = null;
  #kinds = new Map<string, Kind>();
  /** Whether the window began at this process's start rather than at a digest. */
  #fromBoot = true;

  constructor(startedAt: number) {
    this.#windowStartedAt = startedAt;
    this.#nextAt = nextDigestAt(startedAt);
  }

  /** One alert raised: counted if it is a warn, marked if it is a critical of a kind that warned. Never throws. */
  note(alert: Alert, at: number): void {
    try {
      const family = alertFamily(alert.key);
      const kind = this.#kinds.get(family) ?? { keys: new Set<string>(), warns: 0, paged: false, lastAt: at };
      if (alert.severity === "warn") {
        kind.keys.add(alert.key);
        kind.warns += 1;
        kind.lastAt = at;
      } else {
        kind.paged = true;
      }
      this.#kinds.set(family, kind);
    } catch {
      // A lost count is a line missing from tomorrow's message, never a lost alert.
    }
  }

  /** An Alerter that notes every fire and then passes it, and everything else, to `inner` unchanged. */
  tap(inner: Alerter, now: () => number = () => Date.now()): Alerter {
    return {
      fire: (alert: Alert): void => {
        this.note(alert, now());
        inner.fire(alert);
      },
      delivery: () => inner.delivery(),
      clear: (key: string) => inner.clear(key),
    };
  }

  due(now: number): boolean {
    return now >= this.#nextAt;
  }

  /** The digest for the window ending now, and a new window from now. */
  take(now: number): Alert {
    const kinds = [...this.#kinds.entries()]
      .filter(([, kind]) => kind.warns > 0)
      .sort(([a, x], [b, y]) => y.warns - x.warns || (a < b ? -1 : a > b ? 1 : 0));
    const hours = Math.round(((now - this.#windowStartedAt) / 3_600_000) * 10) / 10;
    const window =
      `the last ${hours} h (since ${new Date(this.#windowStartedAt).toISOString().slice(0, 16)}Z` +
      `${this.#fromBoot ? ", when this process started" : ""})`;
    const raised = kinds.reduce((sum, [, kind]) => sum + kind.warns, 0);
    const lines = kinds
      .slice(0, DIGEST_MAX_KINDS)
      .map(
        ([family, kind]) =>
          `${family}: ${kind.keys.size} key${kind.keys.size === 1 ? "" : "s"}, raised ${kind.warns} time${kind.warns === 1 ? "" : "s"}, ` +
          `last ${hhmm(kind.lastAt)}${kind.paged ? " (also paged)" : ""}`,
      );
    if (kinds.length > DIGEST_MAX_KINDS) lines.push(`… and ${kinds.length - DIGEST_MAX_KINDS} more kinds`);
    const detail =
      kinds.length === 0
        ? `No warning was raised over ${window}. This message is also the daily proof that alerts reach you.`
        : `${kinds.length} kind${kinds.length === 1 ? "" : "s"} of warning, raised ${raised} times over ${window}:\n` +
          `${lines.join("\n")}\n` +
          "Most warnings are raised once per sweep while their condition stands, and only criticals are sent as they " +
          "happen; /status has what stands now.";
    const alert: Alert = {
      key: DIGEST_ALERT_KEY,
      severity: "warn",
      title: "Daily digest: the warnings that did not page",
      detail,
      context: { kinds: kinds.length, raised, windowHours: hours },
    };
    this.#lastSentAt = now;
    this.#windowStartedAt = now;
    this.#fromBoot = false;
    this.#nextAt = nextDigestAt(now);
    this.#kinds = new Map();
    return alert;
  }

  status(): WarnDigestStatus {
    const kinds = [...this.#kinds.values()].filter((kind) => kind.warns > 0);
    return {
      nextAt: new Date(this.#nextAt).toISOString(),
      windowStartedAt: new Date(this.#windowStartedAt).toISOString(),
      lastSentAt: this.#lastSentAt === null ? null : new Date(this.#lastSentAt).toISOString(),
      kinds: kinds.length,
      raised: kinds.reduce((sum, kind) => sum + kind.warns, 0),
    };
  }
}
