"use client";

/**
 * THE SAMPLE'S RULE CARD, SIGNING.
 *
 * The owner asked (09-23) for the sample's own card — rate slider, threshold,
 * pause, "Update rule" — and for its controls to do what they say. On the
 * sample they move local state; here every one of them is a signature from the
 * pension key, through the SAME writes the wallets modal uses (useVaultWrite),
 * under the SAME page-wide lock, so nothing about signing is invented twice.
 *
 * WHAT EACH CONTROL SIGNS:
 *   rate, pause  → set_policy_v2, which writes all six of the vault's fields.
 *                  The four this card does not change go back exactly as the
 *                  chain stores them (VaultCard's own rule): leaving one out
 *                  would overwrite it with a guess.
 *   threshold    → set_invest_policy, with ONLY the minimum per leg changed.
 *                  The stored weights, caps and `enabled` travel with it: an
 *                  omitted field takes the product's default, and a default
 *                  `enabled` would quietly UN-PAUSE investing.
 *   both         → two signatures, the rule's first; the threshold's starts
 *                  only once the first has landed.
 *
 * THE SAMPLE'S ONE THRESHOLD IS MADE TRUE, not approximated. The chain stores a
 * minimum PER LEG; the basket invests when EVERY leg clears it, which is at
 * minimum × 10 000 ÷ the lightest leg's weight (pending.ts). The card shows that
 * basket figure — "invests when the pile reaches this" — and signs its inverse.
 *
 * NOTHING HERE MOVES THE FORM. The stored rule changes when the chain says it
 * did: a signature that lands refreshes the page, the page reads the new rule,
 * and the form below remounts on it (its `key`).
 */

import { useEffect, useRef, useState } from "react";

import { readMinimum, resignStoredPolicy } from "@/components/wallets/InvestingCard";
import { TxProgress } from "@/components/wallets/TxProgress";
import { SavingsRulePanel, type RuleSigner } from "@/components/savings-rule-panel";
import { useVaultWrite, type InvestRequest } from "@/hooks/use-vault-actions";
import { useVaultScreen } from "@/hooks/use-vault-state";
import { formatUnits, rawFrom } from "@/lib/amounts";
import { LIVE_COPY } from "@/lib/live-copy";
import type { ActivityEvent, SavingsRule, SavingsStats } from "@/mocks/types";

/**
 * The program's own ranges, in basis points (rules.ts in @sip/solana-core,
 * pinned there to state.rs). Written out, as the sample panel writes its own:
 * that entry carries the IDL, and this ships to the browser for four numbers.
 * LiveRulePanel.test.ts holds them to the package's values.
 */
export const RATE_RANGES = {
  profit: { min: 201, max: 10_000, presets: [1_000, 2_000, 5_000] },
  volume: { min: 1, max: 200, presets: [50, 100, 200] },
} as const;

const USDC_UNIT = 1_000_000;

/** Dollars typed as a number, in USDC raw units, to the micro-dollar. */
const rawOfUsd = (usd: number): bigint => BigInt(Math.round(usd * USDC_UNIT));

/** The minimum PER LEG that makes the basket invest at `thresholdRaw`: the inverse of pending.ts. */
export function minimumFor(thresholdRaw: bigint, weightsBps: readonly number[]): bigint {
  if (weightsBps.length === 0) return 0n;
  const lightest = BigInt(Math.min(...weightsBps));
  return (thresholdRaw * lightest) / 10_000n;
}

export function LiveRulePanel({
  rule,
  stats,
  activity,
  now,
  onRefresh,
  className,
}: {
  readonly rule: SavingsRule;
  readonly stats: SavingsStats;
  readonly activity: readonly ActivityEvent[];
  readonly now: string;
  /** Reads the dashboard again, so a landed signature shows as the new rule. */
  readonly onRefresh: () => void;
  readonly className?: string;
}) {
  const screen = useVaultScreen();
  const ruleWrite = useVaultWrite("vault");
  const policyWrite = useVaultWrite("policy");
  /**
   * The threshold write waiting for the rule's to land, when both changed —
   * and the rule write's progress as it stood when it was queued, so only THIS
   * rule write's outcome can release it, never one left over from before.
   */
  const [queued, setQueued] = useState<{ readonly request: InvestRequest; readonly after: unknown } | null>(null);

  const state = screen !== null && screen.view.kind === "ready" ? screen.view.state : null;
  const account = state?.vault.state ?? null;
  const policy = state?.policy.status === "exists" ? (state.policy.state ?? null) : null;
  const weights = policy?.legs.map((leg) => leg.weightBps) ?? [];
  const maxPerCall = rawFrom(policy?.maxPerCall) ?? null;
  const resign = policy === null ? null : resignStoredPolicy(policy);

  // WHEN A SIGNATURE LANDS, THE PAGE READS AGAIN — once per landing, and the
  // queued threshold starts only after the rule's has landed. A rule that was
  // refused or could not be confirmed takes the queued half down with it: the
  // owner asked for both, and half of it is not what he asked for.
  const seen = useRef(new WeakSet<object>());
  useEffect(() => {
    for (const progress of [ruleWrite.progress, policyWrite.progress]) {
      if (progress.phase !== "finished" || seen.current.has(progress)) continue;
      seen.current.add(progress);
      if (progress.result.ok) onRefresh();
    }
    if (queued !== null && ruleWrite.progress !== queued.after && ruleWrite.progress.phase === "finished") {
      const next = queued.request;
      setQueued(null);
      if (ruleWrite.progress.result.ok) void policyWrite.investPolicy(next);
    }
  }, [ruleWrite.progress, policyWrite.progress, queued, policyWrite, onRefresh]);

  const mode = rule.mode === "volume" ? "volume" : "profit";
  const range = RATE_RANGES[mode];

  const thresholdLocked =
    state === null
      ? LIVE_COPY.reading
      : policy === null
        ? state.policy.status === "unreadable"
          ? LIVE_COPY.policyUnreadable
          : LIVE_COPY.investingNotSetUp
        : resign !== null && !resign.ok
          ? resign.message
          : null;

  const signer: RuleSigner = {
    rateMin: range.min,
    rateMax: range.max,
    presets: range.presets,
    thresholdLocked,
    thresholdProblem: (usd) => {
      const minimum = minimumFor(rawOfUsd(usd), weights);
      const check = readMinimum(formatUnits(minimum, 6), maxPerCall, weights);
      return check.ok ? null : check.message;
    },
    // Nothing is offered while the page cannot sign it, while a signature is
    // under way anywhere on the page, or while a sent one is unconfirmed.
    busy:
      account === null ||
      queued !== null ||
      ruleWrite.running ||
      ruleWrite.busyElsewhere ||
      ruleWrite.unconfirmed ||
      policyWrite.running ||
      policyWrite.busyElsewhere ||
      policyWrite.unconfirmed,
    onUpdate: (next, changed) => {
      if (account === null) return;
      const threshold: InvestRequest | null =
        changed.threshold && policy !== null && resign !== null && resign.ok && next.thresholdUsd !== null
          ? {
              maxPerCall: rawFrom(policy.maxPerCall) ?? 0n,
              maxRolling30d: rawFrom(policy.maxRolling30d) ?? 0n,
              enabled: policy.enabled,
              minInvestment: minimumFor(rawOfUsd(next.thresholdUsd), weights),
              weights: resign.weights,
            }
          : null;
      if (changed.rule) {
        setQueued(threshold === null ? null : { request: threshold, after: ruleWrite.progress });
        void ruleWrite.setPolicy({
          mode: account.skimMode,
          // Only the active mode's rate is the one on the slider; the other goes back untouched.
          skimBps: account.skimMode === 1 ? account.skimBps : next.rateBps,
          volumeBps: account.skimMode === 1 ? next.rateBps : account.volumeBps,
          paused: next.paused,
          maxContribution: rawFrom(account.maxContribution) ?? 0n,
          walletReserve: rawFrom(account.walletReserve) ?? 0n,
        });
      } else if (threshold !== null) {
        void policyWrite.investPolicy(threshold);
      }
    },
    // Whichever write is showing something: the threshold's once it has started, the rule's until then.
    progress:
      policyWrite.progress.phase !== "idle" ? (
        <TxProgress
          progress={policyWrite.progress}
          successLabel="Threshold updated"
          onBuildAgain={() => void policyWrite.buildAgain()}
          onCheckAgain={() => void policyWrite.checkAgain()}
          onDismiss={() => policyWrite.dismiss()}
        />
      ) : (
        <TxProgress
          progress={ruleWrite.progress}
          successLabel="Rule updated"
          onBuildAgain={() => void ruleWrite.buildAgain()}
          onCheckAgain={() => void ruleWrite.checkAgain()}
          onDismiss={() => ruleWrite.dismiss()}
        />
      ),
  };

  return (
    <SavingsRulePanel
      // The form remounts on the rule the chain now stores: its fields are
      // seeded once, and a poll after a signature must re-seed them.
      key={`${rule.mode}:${rule.rateBps}:${rule.thresholdUsd}:${rule.paused}`}
      rule={rule}
      stats={stats}
      activity={activity}
      now={now}
      signer={signer}
      {...(className === undefined ? {} : { className })}
    />
  );
}
