// How the doorbell is plugged into the keeper: the receiver's callbacks, and
// what a webhook sync tells it.
//
// OUT OF bin/keeper.mts ON PURPOSE (review, 2026-09-23). The wiring used to be
// written inline in the top-level script, where no test can drive it, and six
// plausible edits to it — a delivery ingested against an empty known set, a
// lost delivery that no longer asked for a full pass, a sync that told the
// doorbell nothing, an error scrubber missing the doorbell secret — each left
// the whole suite green. Here each of them is a behaviour a test can watch
// (test/doorbell-wiring.test.ts), and the script keeps two thin call sites.

import type { Secret } from "@sip/solana-log";
import type { Doorbell } from "./doorbell.js";
import { WebhookSync, createHeliusWebhookClient } from "./helius-webhooks.js";
import { authorizationMatcher, type HooksRoute } from "./status.js";

export type DoorbellLog = (level: "info" | "warn", message: string, fields: Record<string, unknown>) => void;

/**
 * POST /hooks/helius's callbacks, or null when the doorbell is off (the route
 * then answers 404).
 *
 * `known` IS READ AT DELIVERY TIME, never captured: it is the latest
 * discovery's wallets and vaults, replaced whole every sweep, and a set taken
 * once at boot would be the empty one — every delivery trusted, no bell ever
 * rung, and /status saying all is well.
 */
export function createHooksRoute(input: {
  readonly secret: Secret | null;
  readonly doorbell: Doorbell;
  readonly known: () => ReadonlySet<string>;
  readonly log: DoorbellLog;
  readonly now?: () => number;
}): HooksRoute | null {
  const { secret, doorbell, known, log } = input;
  if (secret === null) return null;
  const now = input.now ?? Date.now;
  return {
    authorized: authorizationMatcher(secret),
    accepted: (body) => {
      const report = doorbell.ingestBody(body.toString("utf8"), known(), now());
      if (report.lost !== null) log("warn", "doorbell: a delivery was not read whole; the next sweep turns every link", { reason: report.lost });
    },
    // A refused delivery is only counted — unless the webhook is not yet known
    // to send this secret, when the doorbell itself asks for a full pass
    // (Doorbell.rejected). A flood of wrong guesses must not become a flood of
    // log lines.
    rejected: () => doorbell.rejected(),
    lost: (reason) => {
      doorbell.lost(reason);
      log("warn", "doorbell: a delivery was refused; the next sweep turns every link", { reason });
    },
  };
}

/**
 * The webhook sync, told to report into the doorbell.
 *
 * THREE THINGS A SYNC KNOWS THAT THE DOORBELL MUST HEAR:
 *   * what Helius holds, and which addresses this edit added — those ring, so
 *     a link turned in the "new" lane until the edit landed is turned once more
 *     after it;
 *   * a GAP — the webhook was missing, disabled, or sent another header — in
 *     which Helius certainly dropped deliveries: the next sweep is a full pass;
 *   * that the header is confirmed, after which a 403 is a stranger.
 *
 * MANAGED BUT NOT YET CONFIRMED IS ITS OWN STATE. When this process can manage
 * the webhook, the doorbell starts with an EMPTY watched set, so every link is
 * "new" and none rests on a bell until the first sync says what Helius holds.
 * Null — unmanaged, a webhook made by hand taken at its word — is only for a
 * process that cannot manage it at all.
 *
 * THE DOORBELL SECRET IS SCRUBBED FROM EVERY ERROR too: it is sent as the
 * webhook's authHeader, and an error body can echo the request back.
 */
export function createDoorbellWebhookSync(input: {
  readonly apiKey: Secret | null;
  readonly secret: Secret | null;
  readonly url: string | null;
  readonly doorbell: Doorbell;
  readonly log: DoorbellLog;
  readonly fetch?: typeof fetch;
}): WebhookSync {
  const { doorbell, log } = input;
  const sync = new WebhookSync({
    client:
      input.apiKey === null
        ? null
        : createHeliusWebhookClient({
            apiKey: input.apiKey,
            alsoScrub: input.secret === null ? [] : [input.secret],
            ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
          }),
    url: input.url,
    secret: input.secret,
    onSynced: (report) => {
      doorbell.setWatched(report.watched, report.added, report.now);
      if (report.authConfirmed) doorbell.confirmAuthorization();
      if (report.gap !== null) {
        doorbell.requestFullPass(`the webhook was just repaired (${report.gap})`);
        log("warn", "doorbell: Helius dropped deliveries before this sync; the next sweep turns every link", { gap: report.gap });
      }
    },
    log,
  });
  if (doorbell.enabled && sync.manageable) doorbell.setWatched(new Set<string>());
  return sync;
}
