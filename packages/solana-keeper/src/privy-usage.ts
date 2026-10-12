// WHAT THIS KEEPER ASKS OF PRIVY: requests by kind, the wallet index's cost,
// and settle signatures by the mode they charged — per sweep and per day.
//
// WHY (ADR §1.1, §6.3 "privy-burn", RT-23). Once the Helius cuts land, the next
// walls are Privy's. Its 50,000 free signatures a month last to about 139 users
// if they all save in VOLUME at today's cadence, and to about 579 in PROFIT at
// mix B (ADR §1.1 and §5.5, COMPUTED from ASSUMED activity). And the wallet
// listing the keeper reads once per sweep grows by pages with the app's
// wallets (the N ≈ 145 cliff, COST_MODEL §7). Each of those numbers was
// computed; this file is what makes them read. Signatures are counted BY MODE
// because the modes collect at different rates and the owner decides a cadence
// per mode.
//
// TWO SOURCES, ONE BLOCK ON /status:
//   * REQUESTS, counted in the fetch every Privy client of the keeper is built
//     with (privyFetch below, handed in through PrivySolanaConfig.fetch, which
//     pinnedPrivyClient already takes). Only the method and the SHAPE of the
//     path are read — never an id, a header or a body: the headers carry the
//     app secret and the authorization signature.
//   * SIGNATURES, told by the settle's own send (settle-tick.ts, onSend), which
//     is the one place that knows the mode it charged. A settle through a local
//     keypair is no Privy signature and is not counted here.
//
// IT DECIDES NOTHING, like src/rpc-usage.ts: every entry point swallows its own
// failure, and nothing on the signing path reads anything back.

import { DAY_BUCKET_MS, DAY_MS, MIN_OBSERVED_FOR_ESTIMATE_MS, createRollingCounts, scaledToWindow } from "./rolling-counts.js";
import { keeperModeFor } from "./role-registry.js";

/**
 * Which Privy request this is, from its method and the shape of its path:
 *   * walletsList — GET /v1/wallets: one PAGE of the wallet listing the index
 *     reads every sweep (buildPrivySolanaIndex);
 *   * walletRpc — POST /v1/wallets/{id}/rpc: a signAndSendTransaction, the
 *     settle itself;
 *   * keyQuorum — GET /v1/key_quorums/{id}: the authorization-key check, once
 *     at boot and then every thirty sweeps;
 *   * other — anything else the SDK sends.
 */
export type PrivyCallKind = "walletsList" | "walletRpc" | "keyQuorum" | "other";

/** The kind of one request, from its method and URL. The URL is parsed for its path's shape and dropped. */
export function privyCallKind(method: string, url: string): PrivyCallKind {
  let path: string;
  try {
    path = new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return "other";
  }
  const verb = method.toUpperCase();
  if (verb === "GET" && path === "/v1/wallets") return "walletsList";
  if (verb === "POST" && /^\/v1\/wallets\/[^/]+\/rpc$/.test(path)) return "walletRpc";
  if (verb === "GET" && /^\/v1\/key_quorums\/[^/]+$/.test(path)) return "keyQuorum";
  return "other";
}

/** How /status names a mode: the registry's name, lower-cased ("profit", "volume"), or "mode-<byte>" for one it has no row for. */
export function modeLabel(byte: number): string {
  return keeperModeFor(byte)?.name.toLowerCase() ?? `mode-${byte}`;
}

/**
 * Privy's free tier, in signatures a month (ADR §1.2: "Privy free signatures
 * (50k/month)", DOC). Kept beside the counter compared against it.
 */
export const PRIVY_FREE_SIGNATURES_PER_MONTH = 50_000;

/** A month, for projecting a daily rate onto the free tier: thirty days. */
const MONTH_DAYS = 30;

/** The `privy` block of /status. "Per day" means what `rpc` says it means: the last 24 h this process saw. */
export interface PrivyUsageStatus {
  readonly observedMs: number;
  /** Privy HTTP requests, by kind. */
  readonly callsPerDay: Readonly<Record<string, number>>;
  /** Requests Privy answered with a non-2xx, or that never got an answer. */
  readonly failedPerDay: number;
  readonly http429PerDay: number;
  /** The last completed sweep's requests, and how many of them were pages of the wallet listing. Null until a sweep completes. */
  readonly callsLastSweep: number | null;
  readonly listPagesLastSweep: number | null;
  /**
   * Settle sends Privy signed and broadcast (it answered with a signature), by
   * the mode they charged. A send that threw is in `signThrewPerDay` instead:
   * a refusal and a 504 after signing look the same from here.
   */
  readonly signaturesPerDay: Readonly<Record<string, number>>;
  readonly signThrewPerDay: number;
  /** Since this process came up, by mode: the per-day window forgets, and this is what a long-lived process has signed. */
  readonly signaturesSinceBoot: Readonly<Record<string, number>>;
  /** Every mode's signatures, scaled to 24 h and multiplied by thirty, against the free tier. Null before MIN_OBSERVED_FOR_ESTIMATE_MS. */
  readonly signaturesMonthEstimate: number | null;
  readonly freeSignaturesPerMonth: number;
  /** How long the last wallet index took to build, and whether it did. Null before the first one. */
  readonly indexMs: number | null;
  readonly indexFailures: number;
  readonly consecutiveIndexFailures: number;
  /**
   * Signer resolutions that ran WITHOUT the sweep's index, because building it
   * failed: each one rebuilds the whole listing for one wallet, which is the
   * N × pages cliff happening.
   */
  readonly fallbackLookups: number;
}

export interface PrivyUsage {
  /**
   * A fetch for PrivySolanaConfig.fetch: counts each request by kind and how it
   * ended, then returns exactly what `inner` did. Without `inner` it calls
   * globalThis.fetch AT THE REQUEST, as the SDK's own default fetch would.
   */
  fetch(inner?: typeof fetch): typeof fetch;
  /** One settle send through Privy, in `mode`; `signed` when Privy answered with a signature. */
  signature(mode: number, signed: boolean): void;
  /** One wallet index built (or failed to be) in `ms`. */
  indexBuilt(ms: number, ok: boolean): void;
  /** One signer resolution that had no index to read. */
  fallbackLookup(): void;
  startSweep(): void;
  endSweep(): void;
  report(now: number): PrivyUsageStatus;
}

export interface PrivyUsageOptions {
  readonly startedAt: number;
  readonly now?: () => number;
  /**
   * Told how each request through fetch() ended — its HTTP status, or
   * "unanswered" with what was thrown — after it ended. For the `dep-down`
   * token's Privy watch (src/dependency-watch.ts) and nothing else; absent, as
   * it is everywhere but a keeper with that token, nothing is told. It is called
   * inside a try of its own, like every count here.
   */
  readonly onAnswer?: (answer: number | "unanswered", error?: unknown) => void;
}

export function createPrivyUsage(options: PrivyUsageOptions): PrivyUsage {
  const now = options.now ?? (() => Date.now());
  const onAnswer = options.onAnswer;
  const day = () => createRollingCounts({ windowMs: DAY_MS, bucketMs: DAY_BUCKET_MS, startedAt: options.startedAt });
  const calls = day();
  const failures = day();
  const signatures = day();
  const threw = day();
  const sinceBoot = new Map<string, number>();
  let indexMs: number | null = null;
  let indexFailures = 0;
  let consecutiveIndexFailures = 0;
  let fallbackLookups = 0;
  let sweep: { calls: number; listPages: number } | null = null;
  let lastSweep: { readonly calls: number; readonly listPages: number } | null = null;

  const quietly = (count: () => void): void => {
    try {
      count();
    } catch {
      // A lost count is a gap on a status page, never a lost settle.
    }
  };

  return {
    fetch(given?: typeof fetch) {
      const inner: typeof fetch = given ?? ((input, init) => globalThis.fetch(input, init));
      return (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
        quietly(() => {
          const method = init?.method ?? (input instanceof Request ? input.method : "GET");
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const kind = privyCallKind(method, url);
          calls.add(kind, 1, now());
          if (sweep !== null) {
            sweep.calls += 1;
            if (kind === "walletsList") sweep.listPages += 1;
          }
        });
        let response: Response;
        try {
          response = await inner(input, init);
        } catch (error) {
          quietly(() => failures.add("unanswered", 1, now()));
          if (onAnswer !== undefined) quietly(() => onAnswer("unanswered", error));
          throw error;
        }
        if (!response.ok) quietly(() => failures.add(response.status === 429 ? "http429" : "httpOther", 1, now()));
        if (onAnswer !== undefined) quietly(() => onAnswer(response.status));
        return response;
      }) as typeof fetch;
    },
    signature(mode, signed) {
      quietly(() => {
        const label = modeLabel(mode);
        if (!signed) {
          threw.add(label, 1, now());
          return;
        }
        signatures.add(label, 1, now());
        sinceBoot.set(label, (sinceBoot.get(label) ?? 0) + 1);
      });
    },
    indexBuilt(ms, ok) {
      quietly(() => {
        if (Number.isFinite(ms) && ms >= 0) indexMs = ms;
        if (ok) consecutiveIndexFailures = 0;
        else {
          indexFailures += 1;
          consecutiveIndexFailures += 1;
        }
      });
    },
    fallbackLookup() {
      fallbackLookups += 1;
    },
    startSweep() {
      sweep = { calls: 0, listPages: 0 };
    },
    endSweep() {
      if (sweep !== null) lastSweep = { ...sweep };
      sweep = null;
    },
    report(at) {
      const observedMs = calls.observedMs(at);
      const failed = failures.totals(at);
      const signed = signatures.total(at);
      const perDay = observedMs < MIN_OBSERVED_FOR_ESTIMATE_MS ? null : scaledToWindow(signed, observedMs, DAY_MS);
      return {
        observedMs,
        callsPerDay: calls.totals(at),
        failedPerDay: failures.total(at),
        http429PerDay: failed["http429"] ?? 0,
        callsLastSweep: lastSweep?.calls ?? null,
        listPagesLastSweep: lastSweep?.listPages ?? null,
        signaturesPerDay: signatures.totals(at),
        signThrewPerDay: threw.total(at),
        signaturesSinceBoot: Object.fromEntries([...sinceBoot].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        signaturesMonthEstimate: perDay === null ? null : Math.round(perDay * MONTH_DAYS),
        freeSignaturesPerMonth: PRIVY_FREE_SIGNATURES_PER_MONTH,
        indexMs,
        indexFailures,
        consecutiveIndexFailures,
        fallbackLookups,
      };
    },
  };
}
