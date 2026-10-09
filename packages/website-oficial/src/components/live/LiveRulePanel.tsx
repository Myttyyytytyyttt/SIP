"use client";

/**
 * THE RULE CARD ON A LIVE PAGE, AND THE GEAR BEHIND IT (owner, 09-25).
 *
 * The card is the sample's own, read-only (savings-rule-panel.tsx). Its gear
 * opens "Vault settings" — every change to the vault in one place, each title
 * with a "?" — and here every change is a signature from the pension key,
 * through the SAME writes the wallets modal uses (useVaultWrite), under the
 * SAME page-wide lock, so nothing about signing is invented twice. What to sign
 * is worked out by components/live/rule-settings-plan.ts, which calls the
 * investing card's own readers; this file only runs it.
 *
 * WHAT ONE SAVE SIGNS:
 *   mode, rate, pause         → set_policy_v2, all six of the vault's fields,
 *                               the ones not on the form exactly as stored.
 *   assets, shares, threshold → set_invest_policy, every field — the stored
 *                               caps (moved into the basket's window, and said
 *                               so), `enabled` as stored (an omitted one would
 *                               UN-PAUSE buying), the minimum per leg that makes
 *                               the basket buy at the threshold.
 *   both                      → two approvals, the rule's first; the second
 *                               starts only once the first has landed.
 *   no policy yet             → no signature: the basket is kept as this
 *                               device's choice, and the "first savings" card
 *                               asks for the approval once there is something
 *                               to buy with.
 *
 * "SWITCH TO LIVE-PRICE BUYING" re-signs the stored basket at the live price —
 * the investing card's button of the same name, byte for byte. It is shown
 * only over a basket approved before 2026-10-08, which still carries price
 * limits (live-model.ts priceLimitsOf); a dot on the gear says so, and the
 * block goes first in the dialog when those limits are stopping buys. The
 * same request, under "Approve again at today's price", is the way out when
 * SOL has fallen under a newer basket's safety floor ("safety_floor"), which
 * always stops conversion and so always goes first.
 *
 * NOTHING CAN BE PRESSED TWICE. From the press until the vault screen has read
 * the chain again after the landing, the form is frozen — the old "Update
 * rule" came back live for up to ten seconds after "Rule updated", with the
 * same change on it.
 *
 * WHAT MOVES ON THE CARD IS DRAWN HERE TOO (10-09, plan B1). Next investment is
 * always this page's own drawing (NextInvestmentLive.tsx): the data's figure,
 * gate and line, and a mark for the work under way. `pulse`, from LiveBody,
 * says what that work is, a buy under way beside "Last investment", and what
 * just arrived — the last buy and a rule change each wash their own block.
 */

import { VOLUME_MODE_OFFERED } from "@sip/solana-core/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { InfoTip } from "@/components/info-tip";
import { NextInvestmentLive, type LiveRulePulse } from "@/components/live/NextInvestmentLive";
import { liveCategories, liveSeed, planSettings, type LiveSeed } from "@/components/live/rule-settings-plan";
import { RuleSettingsDialog, RuleSettingsForm, RuleSettingsStatus, type SettingsJudgement } from "@/components/rule-settings-dialog";
import { SavingsRulePanel } from "@/components/savings-rule-panel";
import { Button } from "@/components/ui/button";
import { SigningDetail, switchToLiveRequest } from "@/components/wallets/InvestingCard";
import { TxProgress } from "@/components/wallets/TxProgress";
import { useBasketChoice } from "@/hooks/use-onboarding-closed";
import { useVaultWrite, type InvestRequest } from "@/hooks/use-vault-actions";
import { useVaultScreen } from "@/hooks/use-vault-state";
import { artForMint } from "@/lib/asset-art";
import { PICKER_MAX_LEGS, catalogueAsset } from "@/lib/basket-picker";
import { LIVE_COPY } from "@/lib/live-copy";
import { priceLimitsOf } from "@/lib/live-model";
import { basketOnShelf, basketSplit } from "@/lib/onboarding";
import { saveBasketChoice, type BasketChoice } from "@/lib/onboarding-memory";
import type { SettingsDraft } from "@/lib/rule-settings";
import { SETTINGS_COPY } from "@/lib/settings-copy";
import type { VaultStateJson } from "@/lib/vault-api";
import { DECLINED_CODE } from "@/lib/vault-flows";
import type { ActivityEvent, SavingsRule, SavingsStats } from "@/mocks/types";

// The ranges and the threshold's inverse live with the dialog's other shapes now; kept importable from here.
export { RATE_RANGES, minimumFor } from "@/lib/rule-settings";

/** What the last approval was for, so its success line says so. */
const SUCCESS = {
  rule: "Saving rule updated",
  buying: "What you buy updated",
  live: "Switched to live-price buying",
  safetyFloor: "Approved at today's price",
} as const;

export function LiveRulePanel({
  rule,
  stats,
  activity,
  now,
  onRefresh,
  pulse,
  className,
}: {
  readonly rule: SavingsRule;
  readonly stats: SavingsStats;
  readonly activity: readonly ActivityEvent[];
  readonly now: string;
  /** Reads the dashboard again, so a landed signature shows as the new rule. */
  readonly onRefresh: () => void;
  /** What is under way and what just arrived (NextInvestmentLive.tsx rulePulseOf). Absent: nothing is marked. */
  readonly pulse?: LiveRulePulse;
  readonly className?: string;
}) {
  const screen = useVaultScreen();
  const ruleWrite = useVaultWrite("vault");
  const policyWrite = useVaultWrite("policy");
  const pensionKey = screen?.pensionKey ?? null;
  const choice = useBasketChoice(pensionKey);
  const [open, setOpen] = useState(false);
  /**
   * The policy write waiting for the rule's to land, when both changed — and
   * the rule write's progress as it stood when it was queued, so only THIS rule
   * write's outcome can release it, never one left over from before.
   */
  const [queued, setQueued] = useState<{ readonly request: InvestRequest; readonly after: unknown } | null>(null);
  /** The vault state a landed write was made against: the form stays frozen until the screen has read past it. */
  const [landedOn, setLandedOn] = useState<VaultStateJson | null>(null);
  const [policyLabel, setPolicyLabel] = useState<string>(SUCCESS.buying);
  const [signedRequest, setSignedRequest] = useState<InvestRequest | null>(null);
  /** Which write the footer follows: the one started last. A finished one must not hide the next one's steps. */
  const [lastWriter, setLastWriter] = useState<"rule" | "policy">("rule");
  /** A basket choice (no policy yet) waiting for the rule half of the same Save to land. */
  const [queuedChoice, setQueuedChoice] = useState<{ readonly choice: BasketChoice; readonly after: unknown } | null>(null);
  /** The second half of a Save that was not sent because the first did not land. */
  const [dropped, setDropped] = useState<string | null>(null);
  /** Landings so far: the form is re-seeded from the chain after each, even when a lagging read shows the old values. */
  const [landings, setLandings] = useState(0);
  /** The state on screen when the dialog opened: nothing is signed from it until the fresh read has answered. */
  const [openedOn, setOpenedOn] = useState<VaultStateJson | null>(null);

  const state = screen !== null && screen.view.kind === "ready" ? screen.view.state : null;
  const account = state?.vault.state ?? null;
  const policy = state?.policy.status === "exists" ? (state.policy.state ?? null) : null;

  // WHEN A SIGNATURE LANDS, THE PAGE READS AGAIN — once per landing — and the
  // form holds until the vault screen has read the chain past it. A rule that
  // was refused or could not be confirmed takes the queued half down with it:
  // the owner asked for both, and half of it is not what he asked for.
  const seen = useRef(new WeakSet<object>());
  useEffect(() => {
    for (const progress of [ruleWrite.progress, policyWrite.progress]) {
      if (progress.phase !== "finished" || seen.current.has(progress)) continue;
      seen.current.add(progress);
      if (progress.result.ok) {
        setLandedOn(state);
        setLandings((count) => count + 1);
        onRefresh();
      } else if (progress === policyWrite.progress && progress.result.kind === "refused" && progress.result.code !== DECLINED_CODE) {
        // A refused policy (a leg fee over the ceiling or unreadable, a stale vault): read the vault again before the next try.
        screen?.refresh();
      }
    }
    if (queued !== null && ruleWrite.progress !== queued.after && ruleWrite.progress.phase === "finished") {
      const next = queued.request;
      setQueued(null);
      if (ruleWrite.progress.result.ok) {
        setPolicyLabel(SUCCESS.buying);
        setSignedRequest(next);
        setLastWriter("policy");
        void policyWrite.investPolicy(next);
      } else {
        // Said, never silent: a rule later landed by Check again must not pass for the whole Save.
        setDropped(SETTINGS_COPY.secondHalfDropped);
      }
    }
    if (queuedChoice !== null && ruleWrite.progress !== queuedChoice.after && ruleWrite.progress.phase === "finished") {
      const next = queuedChoice.choice;
      setQueuedChoice(null);
      if (ruleWrite.progress.result.ok && pensionKey !== null) saveBasketChoice(pensionKey, next);
      else setDropped(SETTINGS_COPY.secondHalfDropped);
    }
  }, [ruleWrite.progress, policyWrite.progress, queued, queuedChoice, policyWrite, onRefresh, state, screen, pensionKey]);

  // Nothing is offered while the page cannot sign it, while a signature is under
  // way anywhere on the page, while a sent one is unconfirmed — or while the
  // vault screen has not yet read the chain past the last landing.
  const busy =
    account === null ||
    queued !== null ||
    ruleWrite.running ||
    ruleWrite.busyElsewhere ||
    ruleWrite.unconfirmed ||
    policyWrite.running ||
    policyWrite.busyElsewhere ||
    policyWrite.unconfirmed;
  const frozen = busy || (landedOn !== null && landedOn === state) || (openedOn !== null && openedOn === state);
  // The dialog cannot close under a wallet prompt, nor between two halves of one save.
  const holdClose = ruleWrite.running || policyWrite.running || queued !== null || queuedChoice !== null;

  const seed = useMemo((): LiveSeed | { readonly problem: string } | null => (state === null ? null : liveSeed(state, choice)), [state, choice]);
  const ready = seed !== null && !("problem" in seed) ? seed : null;
  // The form is keyed on what it opens on — but never re-keyed mid-flow, or a
  // read landing during a signature would reset it under the owner's hands.
  const keyRef = useRef("loading");
  if (!frozen && ready !== null) keyRef.current = `${ready.key}#${landings}`;

  const categories = useMemo(() => liveCategories(), []);
  const limits = policy !== null && state !== null ? priceLimitsOf(policy, state.prices) : null;
  const oldLimits = limits === "held" || limits === "blocking";
  // SOL under the safety floor: the same one-press re-sign, in its own words.
  const underFloor = limits === "safety_floor";
  const attention = oldLimits || underFloor || ruleWrite.unconfirmed || policyWrite.unconfirmed;

  const judge = useCallback(
    (draft: SettingsDraft): SettingsJudgement => {
      if (state === null || ready === null) return { changes: { rule: false, buying: false }, problem: null, notices: [], acknowledge: null, approvals: 0 };
      const plan = planSettings({ state, seed: ready, draft, volumeOffered: VOLUME_MODE_OFFERED });
      const seedNotices = ready.buying.kind === "policy" ? ready.buying.notices : [];
      return { changes: plan.changes, problem: plan.problem, notices: [...seedNotices, ...plan.notices], acknowledge: plan.acknowledge, approvals: plan.approvals };
    },
    [state, ready],
  );

  const save = (draft: SettingsDraft): void => {
    if (state === null || ready === null || frozen) return;
    const plan = planSettings({ state, seed: ready, draft, volumeOffered: VOLUME_MODE_OFFERED });
    if (plan.problem !== null) return;
    setDropped(null);
    if (plan.rule !== null) {
      // The basket half — a policy to sign, or a choice to keep — waits for the rule to land.
      setQueued(plan.policy === null ? null : { request: plan.policy, after: ruleWrite.progress });
      setQueuedChoice(plan.choice === null ? null : { choice: plan.choice, after: ruleWrite.progress });
      setLastWriter("rule");
      void ruleWrite.setPolicy(plan.rule);
    } else if (plan.policy !== null) {
      setPolicyLabel(SUCCESS.buying);
      setSignedRequest(plan.policy);
      setLastWriter("policy");
      void policyWrite.investPolicy(plan.policy);
    } else if (plan.choice !== null && pensionKey !== null) {
      // A choice kept on this device needs no approval: done.
      saveBasketChoice(pensionKey, plan.choice);
      setOpen(false);
    }
  };

  const switchToLive = (): void => {
    if (policy === null || frozen) return;
    const request = switchToLiveRequest(policy);
    if ("problem" in request) return;
    setPolicyLabel(underFloor ? SUCCESS.safetyFloor : SUCCESS.live);
    setSignedRequest(request);
    setDropped(null);
    setLastWriter("policy");
    void policyWrite.investPolicy(request);
  };

  const onOpen = (): void => {
    setOpen(true);
    // Frozen until the read below answers: a quick Save or Switch would otherwise sign from what was on screen before.
    setOpenedOn(state);
    // A fresh read of the vault and its policy, so the form opens on what is on chain now.
    screen?.refresh();
  };

  // "SWITCH TO LIVE-PRICE BUYING" — only over a signed basket that still carries
  // price limits — or "APPROVE AGAIN AT TODAY'S PRICE" over one whose SOL is
  // under its safety floor: one request, the stored basket re-signed.
  const resign = policy === null || !(oldLimits || underFloor) ? null : switchToLiveRequest(policy);
  // Limits that stop something now: the one thing to do, so it goes first.
  const blocking = limits === "blocking" || underFloor;
  const resignTitle = underFloor ? SETTINGS_COPY.safetyFloor : SETTINGS_COPY.switchLive;
  const refreshBlock =
    resign === null
      ? null
      : ({ buyingChanged }: { readonly buyingChanged: boolean }) => (
      <div className={blocking ? "space-y-2 rounded-lg border border-amber-600/40 p-3" : "space-y-2 border-t pt-4"}>
        <div className="flex items-center gap-1.5">
          <p className="text-sm leading-none font-medium">{resignTitle}</p>
          {underFloor ? null : <InfoTip label={SETTINGS_COPY.switchLive}>{SETTINGS_COPY.help.switchLive}</InfoTip>}
        </div>
        <p
          className={
            blocking ? "rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300" : "text-xs text-muted-foreground"
          }
        >
          {underFloor ? SETTINGS_COPY.safetyFloorBlocking : blocking ? SETTINGS_COPY.switchLiveBlocking : SETTINGS_COPY.switchLiveHeld}
        </p>
        {"problem" in resign ? (
          <p className="text-xs text-destructive">{resign.problem}</p>
        ) : buyingChanged ? (
          // Switching now would re-sign the STORED basket under the owner's edits; Save signs at the live price anyway.
          <p className="text-xs text-muted-foreground">{underFloor ? SETTINGS_COPY.safetyFloorBlocked : SETTINGS_COPY.switchLiveBlocked}</p>
        ) : (
          <Button type="button" variant="outline" size="sm" disabled={frozen} onClick={switchToLive}>
            {resignTitle}
          </Button>
        )}
      </div>
    );

  // THE WRITE STARTED LAST is the one shown: a finished "Switched to live-price buying"
  // must never sit over the next rule's steps, its cancel, or its Check again.
  const showPolicy = lastWriter === "policy" ? policyWrite.progress.phase !== "idle" : ruleWrite.progress.phase === "idle" && policyWrite.progress.phase !== "idle";
  const writeProgress =
    showPolicy ? (
      <TxProgress
        progress={policyWrite.progress}
        successLabel={policyLabel}
        approveDetail={<SigningDetail progress={policyWrite.progress} request={signedRequest} />}
        onBuildAgain={() => void policyWrite.buildAgain()}
        onCheckAgain={() => void policyWrite.checkAgain()}
        onDismiss={() => policyWrite.dismiss()}
      />
    ) : (
      <TxProgress
        progress={ruleWrite.progress}
        successLabel={SUCCESS.rule}
        onBuildAgain={() => void ruleWrite.buildAgain()}
        onCheckAgain={() => void ruleWrite.checkAgain()}
        onDismiss={() => ruleWrite.dismiss()}
      />
    );
  const progress = (
    <>
      {dropped === null ? null : (
        <p role="status" className="rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          {dropped}
        </p>
      )}
      {writeProgress}
    </>
  );
  // Any write in hand keeps its progress on screen, even over a status body (a read that failed mid-signature).
  const writing = ruleWrite.progress.phase !== "idle" || policyWrite.progress.phase !== "idle";

  /*
   * THE CARD'S BASKET, TOLD HONESTLY. The dashboard's rule lists the signed
   * policy's legs; with none there, "nothing picked, savings stay as SOL" is
   * true only when nothing WAS picked. A policy nobody could read says so, and a
   * basket chosen at setup but not approved yet is shown as chosen, pending.
   */
  const shownRule = ((): SavingsRule => {
    if (state === null || rule.targets.length > 0) return rule;
    if (state.policy.status === "unreadable") return { ...rule, targetsNote: LIVE_COPY.policyUnreadable };
    if (state.policy.status === "missing" && choice !== null && choice.kind === "stocks") {
      const legs = basketSplit(basketOnShelf(choice));
      const targets = legs.flatMap((leg) => {
        const asset = catalogueAsset(leg.mint);
        const logo = artForMint(leg.mint);
        return asset === null ? [] : [{ symbol: asset.symbol, weightBps: leg.percent * 100, ...(logo === null || logo === undefined ? {} : { logo }) }];
      });
      return { ...rule, targets, targetsNote: SETTINGS_COPY.appliesWhenBuyingStarts };
    }
    return rule;
  })();

  const body =
    state === null ? (
      <RuleSettingsStatus>
        {screen !== null && screen.view.kind === "unreadable" ? (
          <>
            <p>{screen.view.message}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => screen.refresh()}>
              {SETTINGS_COPY.retry}
            </Button>
          </>
        ) : (
          <p>{SETTINGS_COPY.loading}</p>
        )}
        {writing ? progress : null}
      </RuleSettingsStatus>
    ) : ready === null ? (
      <RuleSettingsStatus>
        <p>{seed !== null && "problem" in seed ? seed.problem : SETTINGS_COPY.loading}</p>
        {writing ? progress : null}
      </RuleSettingsStatus>
    ) : (
      <RuleSettingsForm
        key={keyRef.current}
        initial={ready.draft}
        rates={ready.rates}
        live
        volume={{
          selectable: VOLUME_MODE_OFFERED,
          note: ready.draft.mode === "volume" && !VOLUME_MODE_OFFERED ? SETTINGS_COPY.volumeLegacy : VOLUME_MODE_OFFERED ? null : SETTINGS_COPY.volumeComing,
        }}
        categories={categories}
        maxLegs={PICKER_MAX_LEGS}
        weightsEditable={ready.buying.kind === "policy"}
        thresholdEditable={ready.buying.kind === "policy"}
        buyingLocked={ready.buying.kind === "locked" ? ready.buying.message : null}
        thresholdNote={ready.buying.kind === "choice" ? SETTINGS_COPY.appliesWhenBuyingStarts : null}
        frozen={frozen}
        judge={judge}
        onSave={save}
        onCancel={() => {
          if (!holdClose) setOpen(false);
        }}
        refresh={refreshBlock}
        refreshFirst={blocking}
        progress={progress}
      />
    );

  return (
    <>
      <SavingsRulePanel
        rule={shownRule}
        stats={stats}
        activity={activity}
        now={now}
        settings={{ open, onOpen, attention }}
        renderNextInvestment={(next) => <NextInvestmentLive next={next} work={pulse?.work ?? null} />}
        {...(pulse === undefined ? {} : { pulse })}
        {...(className === undefined ? {} : { className })}
      />
      <RuleSettingsDialog
        open={open}
        onOpenChange={(next) => {
          if (!next && holdClose) return;
          setOpen(next);
        }}
        holdClose={holdClose}
        description={SETTINGS_COPY.descriptionLive}
      >
        {body}
      </RuleSettingsDialog>
    </>
  );
}
