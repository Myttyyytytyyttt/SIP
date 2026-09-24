"use client";

/**
 * THE NEW-USER SETUP, WIRED: the shared vault read, the ONE create-vault path,
 * and what this browser remembers of where the setup was left.
 *
 * ALWAYS MOUNTED FOR A CONNECTED KEY, whether the dialog is open or not. Radix
 * unmounts a closed dialog's content, and the step, the chosen share and a
 * write's progress must survive a close and a reopen — so they live here, and
 * the dialog is only their window. The frame keys it by the pension key, so
 * another wallet starts from its own memory.
 *
 * ONE SIGNING PATH. The vault is created by useVaultWrite(...).createVault, the
 * same flow and the same page-wide lock VaultCard uses (use-vault-actions.ts);
 * only the writer's name differs, so the vault card reads this as busy
 * elsewhere rather than as its own write.
 *
 * WHEN THE VAULT LANDS the setup does not simply vanish: it stays open on "Your
 * vault is ready" (a latch the reads cannot pull away), forgets what it
 * remembered, tells this browser's other tabs, and asks the dashboard to read
 * again. Closing that screen ends the setup for good; the dashboard's own cards
 * carry on from there.
 *
 * A REOPEN ON AN OLD READ ASKS AGAIN. The vault screen does not poll, so a
 * setup reopened long after its last answer could offer Create for a vault
 * made on another device. Past a minute, the reopen reads again and the vault
 * step shows its skeleton until the answer is fresh — never the form.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { OnboardingBody, onboardingHeading } from "@/components/onboarding/OnboardingBody";
import { OnboardingDialog, focusPrimary } from "@/components/onboarding/OnboardingDialog";
import { useVaultWrite } from "@/hooks/use-vault-actions";
import { useVaultScreen, type VaultView } from "@/hooks/use-vault-state";
import { rawFrom } from "@/lib/amounts";
import { SETUP_RATE, landedCreate, onboardingOpen, vaultStepRead, type OnboardingBodyStep, type OnboardingCreated } from "@/lib/onboarding";
import { forgetOnboarding, readOnboardingStep, saveOnboardingStep, type OnboardingStep } from "@/lib/onboarding-memory";
import { CREATE_VAULT_FEE_LAMPORTS } from "@/lib/vault-limits";

/** How old the vault read may be when the setup reopens before it is read again. */
export const REOPEN_FRESH_MS = 60_000;

export function OnboardingHost({
  pensionKey,
  wanted,
  onClose,
  onCreated,
  onDisconnect,
  onRunningChange,
}: {
  readonly pensionKey: string;
  /** The frame wants the setup on screen (src/lib/onboarding.ts, onboardingWanted). */
  readonly wanted: boolean;
  /** The person closed it: the frame puts the sample on screen. */
  readonly onClose: () => void;
  /** A vault landed, or the ready screen was left: the dashboard reads again. */
  readonly onCreated: () => void;
  readonly onDisconnect: () => void;
  /** Told when this setup's write starts and stops: the frame refuses Back's close while it runs. */
  readonly onRunningChange?: (running: boolean) => void;
}) {
  const screen = useVaultScreen();
  const write = useVaultWrite("onboarding");
  const [step, setStep] = useState<OnboardingStep>(() => readOnboardingStep(pensionKey));
  /** The share chosen on the vault step: kept here, so a close and a reopen find it as it was left. */
  const [rateBps, setRateBps] = useState<number>(SETUP_RATE.initial);
  const [created, setCreated] = useState<OnboardingCreated>(null);
  /** The read that was out of date when the setup reopened: until another arrives, the vault step waits. */
  const [staleView, setStaleView] = useState<VaultView | null>(null);

  // ── a landed create, noticed once ──────────────────────────────────────────
  const seen = useRef(new WeakSet<object>());
  const latestOnCreated = useRef(onCreated);
  latestOnCreated.current = onCreated;
  useEffect(() => {
    const progress = write.progress;
    if (progress.phase !== "finished" || seen.current.has(progress)) return;
    seen.current.add(progress);
    if (!landedCreate(progress)) return;
    setCreated("celebrating");
    forgetOnboarding(pensionKey, { announce: true });
    latestOnCreated.current();
  }, [write.progress, pensionKey]);

  // ── how old the vault read is ──────────────────────────────────────────────
  const view = screen?.view ?? null;
  const answeredAt = useRef<number>(0);
  useEffect(() => {
    answeredAt.current = Date.now();
  }, [view]);

  // NOTHING CLOSES IT WHILE THE WALLET IS ASKED — not the X, not Back, not a
  // read that changes underneath: the answer must land where it was asked for.
  const running = write.running;
  useEffect(() => {
    onRunningChange?.(running);
  }, [running, onRunningChange]);
  const open = running || onboardingOpen(wanted, created);
  const wasOpen = useRef(false);
  const refresh = screen?.refresh ?? null;
  useEffect(() => {
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (!opening || refresh === null || view === null) return;
    if (Date.now() - answeredAt.current < REOPEN_FRESH_MS) return;
    setStaleView(view);
    refresh();
  }, [open, refresh, view]);

  // ── focus follows the step ─────────────────────────────────────────────────
  const bodyStep: OnboardingBodyStep = created === "celebrating" ? "ready" : step;
  const shownStep = useRef<OnboardingBodyStep | null>(null);
  useEffect(() => {
    if (!open) {
      shownStep.current = null;
      return;
    }
    // The first frame is the dialog's own onOpenAutoFocus; after that, a new step takes focus to its primary button.
    if (shownStep.current !== null && shownStep.current !== bodyStep) focusPrimary(document.querySelector<HTMLElement>('[data-onboarding="open"]'));
    shownStep.current = bodyStep;
  }, [open, bodyStep]);

  const goTo = useCallback(
    (next: OnboardingStep) => {
      setStep(next);
      saveOnboardingStep(pensionKey, next);
    },
    [pensionKey],
  );

  if (screen === null || view === null) return null;

  // Figures only from THIS key's read.
  const chain = view.kind === "ready" && view.state.owner === pensionKey ? view.state : null;
  const read = staleView !== null && view === staleView ? "reading" : vaultStepRead(view, pensionKey);

  const finish = (): void => {
    setCreated("done");
    write.dismiss();
    onCreated();
  };

  return (
    <OnboardingDialog
      open={open}
      holdClose={running}
      heading={onboardingHeading(bodyStep, rateBps)}
      onOpenChange={(next) => {
        if (next) return;
        if (created === "celebrating") finish();
        else onClose();
      }}
    >
      <OnboardingBody
        step={bodyStep}
        pensionKey={pensionKey}
        vaultRent={rawFrom(chain?.rents?.vault)}
        linkRent={rawFrom(chain?.rents?.link)}
        fees={CREATE_VAULT_FEE_LAMPORTS}
        read={read}
        rateBps={rateBps}
        onRate={setRateBps}
        progress={write.progress}
        running={write.running}
        busyElsewhere={write.busyElsewhere}
        unconfirmed={write.unconfirmed}
        onContinue={() => goTo("vault")}
        onBack={() => goTo("welcome")}
        onCreate={(request) => void write.createVault(request)}
        onRetryRead={() => screen.refresh()}
        onBuildAgain={() => void write.buildAgain()}
        onCheckAgain={() => void write.checkAgain()}
        onDismissProgress={() => write.dismiss()}
        onDone={finish}
        onDisconnect={onDisconnect}
      />
    </OnboardingDialog>
  );
}
