/**
 * THE LIVE DASHBOARD'S CLIENT: two POSTs to this app's own /api/solana-live.
 *
 * The same transport the vault screens use (createJsonPoster), so retry-after, a
 * body that is not JSON, and a request that never got an answer are read exactly
 * one way across this app rather than two that drift.
 *
 * The origin is injectable, so the local proof drives this same client against a
 * `next start` on localhost. Nothing here signs, holds a key, or decides what to
 * show: it returns the chain's answer, and live-model.ts turns it into a screen.
 */

import type { LiveActivityJson, LiveActivityRequest, LiveLinkActivityJson, LiveLinkActivityRequest, LiveSnapshotJson, LiveSnapshotRequest } from "@/lib/live-types";
import { createJsonPoster, vaultFailureWords, type ApiFailure, type ApiResult } from "@/lib/vault-api";

const PATH = "/api/solana-live";

export interface LiveApi {
  /** The vault, its policy, the config, prices, the vault's token accounts, rents and each trading wallet. One batch. */
  snapshot(input: LiveSnapshotRequest): Promise<ApiResult<LiveSnapshotJson>>;
  /** One page of the vault's history, already classified. */
  activity(input: LiveActivityRequest): Promise<ApiResult<LiveActivityJson>>;
  /**
   * One page of ONE WALLET's link, where the settlements actually are.
   *
   * Its own method rather than a flag on `activity`, because the two answers
   * are different shapes carrying different claims, and a caller must not be
   * able to hold one where the other is expected. The route is the same action.
   */
  linkActivity(input: LiveLinkActivityRequest): Promise<ApiResult<LiveLinkActivityJson>>;
}

export function createLiveApi(options: { readonly origin?: string; readonly fetch?: typeof fetch } = {}): LiveApi {
  const { request } = createJsonPoster(options);

  return {
    snapshot: ({ owner, wallets, discover }) => request<LiveSnapshotJson>(PATH, { action: "snapshot", owner, wallets: [...wallets], discover }),
    activity: ({ owner, limit, before, until }) =>
      request<LiveActivityJson>(PATH, {
        action: "activity",
        owner,
        // The route refuses a field it did not expect, so only what was asked for is sent.
        ...(limit === undefined ? {} : { limit }),
        ...(before === undefined ? {} : { before }),
        ...(until === undefined ? {} : { until }),
      }),
    linkActivity: ({ owner, wallet, limit, before }) =>
      request<LiveLinkActivityJson>(PATH, {
        action: "activity",
        owner,
        wallet,
        ...(limit === undefined ? {} : { limit }),
        ...(before === undefined ? {} : { before }),
      }),
  };
}

/** A live read's failure in words. The same sentences the vault screens use. */
export const liveFailureWords = (failure: ApiFailure): string => vaultFailureWords(failure);

/**
 * Whether a history read left the screen with nothing true to say about it.
 *
 * TWO DIFFERENT ANSWERS CARRY THE SAME FACT. The POST can fail outright (a 429
 * from this browser's own bucket, a network drop), and the route can answer 200
 * with `status: "unreadable"` when the signature listing or the transaction
 * batch failed upstream. Either way NO history was read — which is a different
 * fact from a vault that has none, and the difference is the whole of what the
 * feed is allowed to say next.
 */
export const activityWasUnreadable = (page: ApiResult<LiveActivityJson | LiveLinkActivityJson>): boolean => !page.ok || page.body.status === "unreadable";

/**
 * WHAT A HISTORY READ THAT FAILED LEAVES BEHIND.
 *
 * A boolean said only THAT it failed. The route had already said WHEN this
 * browser may ask again — build-handler answers retryAfterSeconds beside a
 * retry-after header — and the hook dropped it on the floor, so the feed waited
 * out the whole sweep for a bucket that refills at a token a second, and
 * offered a Retry button that could say nothing about when it would work.
 */
export interface LiveActivityTrouble {
  /** The server's own retry-after, as an instant. Null: it named no time. */
  readonly retryAt: number | null;
  /** Early re-reads already spent on this trouble. */
  readonly attempts: number;
}

/**
 * The trouble a page leaves, or null when it was READ — however empty it was.
 *
 * A 200 the route marked "unreadable" carries no retry-after: upstream failed,
 * nothing was refused, and inventing a delay the server did not give would be
 * a number this screen cannot source.
 */
export const activityTroubleFrom = (
  page: ApiResult<LiveActivityJson | LiveLinkActivityJson>,
  input: { readonly attempts: number; readonly now: number },
): LiveActivityTrouble | null => {
  if (!activityWasUnreadable(page)) return null;
  const seconds = page.ok ? null : page.retryAfterSeconds;
  return { retryAt: seconds === null ? null : input.now + seconds * 1_000, attempts: input.attempts };
};
