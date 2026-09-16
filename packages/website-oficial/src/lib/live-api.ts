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

import type { LiveActivityJson, LiveActivityRequest, LiveSnapshotJson, LiveSnapshotRequest } from "@/lib/live-types";
import { createJsonPoster, vaultFailureWords, type ApiFailure, type ApiResult } from "@/lib/vault-api";

const PATH = "/api/solana-live";

export interface LiveApi {
  /** The vault, its policy, the config, prices, the vault's token accounts, rents and each trading wallet. One batch. */
  snapshot(input: LiveSnapshotRequest): Promise<ApiResult<LiveSnapshotJson>>;
  /** One page of the vault's history, already classified. */
  activity(input: LiveActivityRequest): Promise<ApiResult<LiveActivityJson>>;
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
export const activityWasUnreadable = (page: ApiResult<LiveActivityJson>): boolean => !page.ok || page.body.status === "unreadable";
