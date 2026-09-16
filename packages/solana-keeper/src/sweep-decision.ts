// What the SWEEP decides about itself, as pure functions.
//
// The per-wallet decisions live in settle-decision.ts and the per-vault ones in
// invest-decision.ts. What was left in bin/keeper.mts were the decisions about
// the sweep as a whole — whether a failed read is weather or a defect — and they
// were inline between RPC calls, where no test could reach them.

import type { Alert } from "./alerts.js";

/**
 * The alerter's key for the sweep's batched vault read.
 *
 * ONE KEY, NOT ONE PER VAULT: the batch is one request for every link, so its
 * failure is one condition. Every other key the sweep raises names a vault or a
 * wallet (`invest-failed:<vault>`, `settle-failed:<wallet>`); this one names
 * nothing, because it is the sweep's own.
 */
export const VAULT_READ_ALERT_KEY = "vault-read";

/**
 * Consecutive sweeps whose batched vault read failed before it pages critical: 3,
 * the streak the invest and settle failures already use.
 */
export const VAULT_READ_CRITICAL_STREAK = 3;

/**
 * The alert for a batched vault read that failed: a warning at first, critical
 * from the third sweep in a row.
 *
 * NOT CRITICAL ON THE FIRST. A refused getMultipleAccounts used to fail the whole
 * sweep and page at once, so one throttled request from a public endpoint woke
 * somebody while nothing was actually wrong with the money. A sweep that degrades
 * to a read per link still settles every link whose vault it can read, so one
 * failure is weather. Three sweeps in a row is an endpoint that cannot serve this
 * program's accounts, and by then nothing has settled for three sweeps.
 */
export function vaultReadAlert(streak: number, detail: string): Alert {
  const critical = streak >= VAULT_READ_CRITICAL_STREAK;
  return {
    key: VAULT_READ_ALERT_KEY,
    severity: critical ? "critical" : "warn",
    title: critical ? "The sweep cannot read the vaults it settles against" : "The batched vault read failed; this sweep reads one vault per link",
    detail: `${streak} sweep${streak === 1 ? "" : "s"} in a row: ${detail}`,
    context: { sweeps: streak },
  };
}
