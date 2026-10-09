/**
 * WHAT SOLANA SAID CHANGED, ON THE ROWS BEFORE ANY UPDATE HAS BROUGHT IT
 * (plan B3, 10-09). The header's dot breathes the moment the chain rings
 * (`live.heard`, LiveHeartbeat.tsx); the rows over the feed said nothing until
 * the update that covered the change had landed, seconds later — and "I trade
 * and see nothing in progress" was the owner's complaint (10-09).
 *
 * A WALLET: "Activity seen on Trading wallet 1 · checking", for each trading
 * wallet among `live.heard.wallets` — its first activity since its last
 * saving. It stands under the key its own step takes once the update lands
 * (`measuring:<address>`, live-pending.ts pendingLines), so "checking your
 * latest activity" REPLACES it in place: one row whose words change, never one
 * closing while another grows. Only where that step can follow
 * (checkedLineOf): a wallet whose activity the page would never check — the
 * vault paused, a link that is not this vault's, a wallet at its reserve —
 * gets no row claiming it is checked; the dot still says a change was seen.
 * Its line under the title is the step's own, so the takeover changes the
 * title alone.
 *
 * THE VAULT: "Activity seen on your vault · checking", when what was heard
 * names no trading wallet (`heard.wallets` empty): the vault or one of its
 * token accounts rang — a saving landing, a deposit, a withdrawal, the
 * keeper's own step. Not while a conversion or a buy is under way: that step's
 * turning mark already says the vault is about to move, and one fact wears one
 * moving mark. Not when a wallet is named too: `heard` cannot say whether the
 * vault rang as well.
 *
 * IT ENDS WHEN `heard` CLEARS — an update that covered the change landed. A
 * wallet's line becomes its step's, or closes when no step follows (the change
 * was the saving itself, which arrives as its own row); the vault's closes in
 * the update that covered it, which brings its row whenever the vault's own
 * history holds one.
 *
 * NO FRAME WITH NEITHER (the bridge). The steps are drawn off a SETTLED read
 * (use-read-settled.ts), which can lag the newest by up to READ_SETTLE_MS,
 * while a wallet leaves `heard` in the very commit its step appears in the
 * newest snapshot (use-live-dashboard.ts LiveLiveness.heard). So a wallet whose
 * step the newest snapshot has and the settled read not yet is drawn with that
 * newest step's own line, under the same key, until the settled read has it.
 *
 * WHILE THE UPDATES FAIL — the stale note, or the history unreadable — what
 * was heard is not on the page, and nothing on it can say when it will be:
 * "not on this page yet", with the still clock of a wait instead of the
 * turning mark (the dot's own words for the same moment,
 * LIVE_COPY.pulse.heardBehind).
 *
 * NOT READ OUT. A heard line is the herald of news, not news: the step's own
 * line is spoken when it takes over (LivePending.tsx gives its words a node of
 * their own), and whatever lands is spoken by the announcer when its row
 * arrives (LiveAnnouncer.tsx). One story, said once.
 */

import type { ShownLine } from "@/components/live/LivePending";
import { LIVE_COPY } from "@/lib/live-copy";
import { pendingLines, pendingSteps, type PendingLine } from "@/lib/live-pending";
import type { PushHeard } from "@/lib/live-push";
import type { LiveDashboard } from "@/lib/live-types";

/** The vault's own line: no step ever takes this key. */
export const VAULT_HEARD_KEY = "heard:vault";

/** The key a wallet's step is drawn under (live-pending.ts pendingLines). */
const measuringKey = (address: string): string => `measuring:${address}`;

/**
 * THE LINE A WALLET'S CHANGE WOULD BECOME, asked of live-pending.ts itself
 * rather than copied from it: the page's own data with one change of that
 * wallet, at a slot past anything it holds — past its link's frontier and its
 * newest settlement, heard this very moment. Null when no change of that
 * wallet would be checked at all (measuringSteps: the vault or SaverFi paused
 * or not known not to be, volume not offered, a link that is not this vault's,
 * a wallet at its reserve).
 */
export function checkedLineOf(data: LiveDashboard, address: string): PendingLine | null {
  const probe: LiveDashboard = { ...data, walletChanges: [{ wallet: address, slot: Number.MAX_SAFE_INTEGER, sinceMs: data.nowMs }] };
  const steps = pendingSteps(probe).filter((step) => step.kind === "measuring");
  return pendingLines(steps, data.nowMs).find((line) => line.key === measuringKey(address)) ?? null;
}

/** The step under way that already says the vault is about to move. */
const vaultMoving = (lines: readonly PendingLine[]): boolean => lines.some((line) => line.active && (line.kind === "converting" || line.kind === "buying"));

/**
 * The heard lines, in the column's order: each wallet's in the page's wallet
 * order (as its step would be), then the vault's. Empty when nothing was heard
 * and nothing is bridged.
 *
 * `data` is the newest snapshot, `lines` the steps as the settled read draws
 * them, `latest` the newest snapshot's steps (the same as `lines` once the read
 * has settled). `behind`: the last update failed, or the history could not be
 * read — what was heard is not on the page, and no update is known to be
 * bringing it.
 */
export function heardLinesOf(input: {
  readonly heard: PushHeard | null;
  readonly data: LiveDashboard;
  readonly lines: readonly PendingLine[];
  readonly latest: readonly PendingLine[];
  readonly behind: boolean;
}): ShownLine[] {
  const { heard, data, behind } = input;
  const drawn = new Set(input.lines.map((line) => line.key));
  const newest = new Map(input.latest.map((line) => [line.key, line]));
  const wallets = new Set(heard?.wallets ?? []);
  const out: ShownLine[] = [];
  for (const wallet of data.wallets) {
    const key = measuringKey(wallet.address);
    // Its step is drawn: that line speaks for it.
    if (drawn.has(key)) continue;
    // The bridge: the newest snapshot's step, until the settled read has it.
    const bridged = newest.get(key);
    if (bridged !== undefined) {
      out.push(bridged);
      continue;
    }
    if (!wallets.has(wallet.address)) continue;
    const checked = checkedLineOf(data, wallet.address);
    if (checked === null) continue;
    out.push({
      ...checked,
      active: !behind,
      // The still clock of a wait (LivePending.tsx workStateOf): no update is known to be bringing it.
      rest: behind ? "slow" : null,
      title: behind ? LIVE_COPY.heardLine.walletBehind(wallet.label) : LIVE_COPY.heardLine.wallet(wallet.label),
      heard: true,
    });
  }
  if (heard !== null && heard.wallets.length === 0 && !vaultMoving(input.lines) && !vaultMoving(input.latest)) {
    out.push({
      key: VAULT_HEARD_KEY,
      kind: "vault",
      active: !behind,
      rest: behind ? "slow" : null,
      title: behind ? LIVE_COPY.heardLine.vaultBehind : LIVE_COPY.heardLine.vault,
      sub: LIVE_COPY.heardLine.vaultSub,
      amount: "",
      amountSpoken: "",
      heard: true,
    });
  }
  return out;
}
