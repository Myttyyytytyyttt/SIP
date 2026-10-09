/**
 * THE WALLETS SCREENS FOLLOW THE CHAIN (diagnosis 10-09, inventory D2). Pure,
 * so the policy is numbers and a table a test can pin; the hooks that apply
 * it are useVaultState (src/hooks/use-vault-state.ts) and useVaultFollowsLive
 * (src/hooks/use-vault-follow.ts).
 *
 * The vault screen — the Manage wallets modal, /wallets, the rule card's gear
 * dot — read POST /api/solana-vault at mount and then only after a write, a
 * Refresh or Retry, or a failed read. So the vault balance, what can be
 * withdrawn, the token holdings and the investing card showed the vault as the
 * page last read it, however many settlements, conversions and buys had
 * landed since.
 *
 * ON THE DASHBOARD IT FOLLOWS THE LIVE STORE, which already polls and hears
 * the chain: after a committed live read whose snapshot shows the vault's
 * lamports, its account, its token amounts or its investment policy moved
 * (vaultMoved), and when the Manage wallets modal opens. It never polls by
 * itself there: two clocks reading the same vault would be one too many.
 *
 * ON /wallets NOTHING ELSE IS READING, so the screen polls on its own at the
 * keeper's sweep while the tab is visible, and reads on returning to the tab.
 *
 * WHAT IT COSTS. A vault-screen read is BUILD_READS_WEIGHT.state = 12 weighted
 * tokens (solana-core build-handler.ts) out of /api/solana-vault's own
 * per-client bucket of relay.perClientPerMin = 60 a minute — a bucket separate
 * from the live dashboard's. The /wallets poll is 12 of them a minute. A read
 * the live store prompts waits VAULT_FOLLOW_FLOOR_MS after the last vault read
 * began, so at most two a minute (24 tokens) however busy the vault is; a
 * modal opened waits the manual floor, 10 s, which only a person can spend.
 */

import { MANUAL_FLOOR_MS, POLL_BASE_MS } from "@/lib/live-schedule";
import type { LiveSnapshotJson } from "@/lib/live-types";

/** /wallets' own poll: the keeper's sweep. */
export const VAULT_POLL_MS = POLL_BASE_MS;

/** The modal opening, or the tab looked at again: a person's floor. */
export const VAULT_OPEN_FLOOR_MS = MANUAL_FLOOR_MS;

/**
 * A read the live store prompted waits this long after the last vault read
 * began: two a minute at most, 24 of the bucket's 60 tokens. A change that
 * comes inside it is not lost — one read is kept for the moment it ends.
 */
export const VAULT_FOLLOW_FLOOR_MS = 30_000;

/**
 * WHAT OF A LIVE SNAPSHOT THE VAULT SCREEN DRAWS, kept apart per field so a
 * part that could not be read compares as nothing rather than as a change: a
 * flaky token-account read must not buy a vault read every half minute.
 * Prices are left out on purpose — they move on every read.
 */
export interface VaultStamp {
  /** The vault account's lamports; null when unread. */
  readonly lamports: string | null;
  /** The vault account's decoded state (rule, mode, counters), as JSON; null when unread. */
  readonly vault: string | null;
  /** The investment policy as JSON, "missing" when there is none; null when unread. */
  readonly policy: string | null;
  /** Each vault token account's amount ("missing" when it does not exist), by address; null when the listing was unread. Unread items are left out. */
  readonly tokens: Readonly<Record<string, string>> | null;
}

/** The stamp of a snapshot, or null when there is nothing to compare: no snapshot, or no vault. */
export function vaultStampOf(snapshot: LiveSnapshotJson | null): VaultStamp | null {
  if (snapshot === null || snapshot.vault.status !== "exists") return null;
  const policy =
    snapshot.policy.status === "exists" ? JSON.stringify(snapshot.policy.state ?? null) : snapshot.policy.status === "missing" ? "missing" : null;
  let tokens: Record<string, string> | null = null;
  if (snapshot.vaultTokenAccounts.status === "exists") {
    tokens = {};
    for (const item of snapshot.vaultTokenAccounts.items) {
      if (item.status === "missing") tokens[item.address] = "missing";
      else if (item.status === "exists" && typeof item.amountRaw === "string") tokens[item.address] = item.amountRaw;
    }
  }
  return {
    lamports: snapshot.vault.lamports ?? null,
    vault: snapshot.vault.state === undefined ? null : JSON.stringify(snapshot.vault.state),
    policy,
    tokens,
  };
}

/**
 * Whether the vault moved between two committed live reads. Only what BOTH
 * read is compared: nothing before there are two stamps (the vault screen read
 * at mount already), and nothing from a field one of them could not read.
 */
export function vaultMoved(before: VaultStamp | null, after: VaultStamp | null): boolean {
  if (before === null || after === null) return false;
  const differs = (a: string | null, b: string | null): boolean => a !== null && b !== null && a !== b;
  if (differs(before.lamports, after.lamports) || differs(before.vault, after.vault) || differs(before.policy, after.policy)) return true;
  if (before.tokens === null || after.tokens === null) return false;
  for (const [address, amount] of Object.entries(after.tokens)) {
    const held = before.tokens[address];
    if (held !== undefined && held !== amount) return true;
  }
  return false;
}

/** Milliseconds until /wallets' next poll, counted from the last answer; a full sweep when none has come yet. */
export function vaultPollDelayMs(input: { readonly answeredAt: number | null; readonly now: number }): number {
  if (input.answeredAt === null) return VAULT_POLL_MS;
  return Math.max(0, input.answeredAt + VAULT_POLL_MS - input.now);
}

/**
 * ONE READ, NEVER SOONER THAN A FLOOR AFTER THE LAST ONE BEGAN, AND NEVER LOST.
 *
 * ask(floor) reads at once when the last read began `floor` ago or more (or
 * never), and otherwise keeps ONE read for the moment the floor ends — the
 * earliest moment any asker named, however many asked meanwhile. A read in
 * flight counts as begun, so a change heard while one is out is read after it
 * rather than beside it. Every read reports itself through started() — the
 * gate's own, a write's refresh, the first read — and one that BEGINS after an
 * ask covers it: the change was already on chain when it was asked about, so
 * the kept read is dropped rather than paid twice.
 */
export interface FloorGate {
  ask(floorMs: number): void;
  /** A read began, by any path: the floor counts from now, and a read kept for later is no longer needed. */
  started(): void;
  /** Drops the kept read, if any. */
  dispose(): void;
}

export function createFloorGate(options: {
  readonly run: () => void;
  readonly now?: () => number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}): FloorGate {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let startedAt: number | null = null;
  let kept: { readonly timer: unknown; readonly at: number } | null = null;

  const drop = (): void => {
    if (kept !== null) clearTimer(kept.timer);
    kept = null;
  };

  return {
    ask(floorMs) {
      const at = now();
      const due = startedAt === null ? at : startedAt + floorMs;
      if (due <= at) {
        drop();
        options.run();
        return;
      }
      // One kept read, at the earliest moment asked for.
      if (kept !== null && kept.at <= due) return;
      drop();
      kept = {
        at: due,
        timer: setTimer(() => {
          kept = null;
          options.run();
        }, due - at),
      };
    },
    started() {
      startedAt = now();
      drop();
    },
    dispose: drop,
  };
}
