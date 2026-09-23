"use client";

/**
 * WHAT THE NEW-USER SETUP SHOWS, step by step — a pure view.
 *
 * Props in, callbacks out: no Privy, no chain, no storage. OnboardingHost feeds
 * it the shared vault read and the one create-vault writer; the tests and the
 * preview feed it fixtures, which is how every state is seen without a login.
 *
 * THREE SCREENS. Welcome: what SaverFi does, in four short points, and every
 * cost that exists before anyone is asked to sign. Vault: profit at the product's
 * rate (the only mode offered), the two limits folded under Advanced at their
 * defaults, the cost above the button, one approval. Ready: the vault landed,
 * and what the dashboard does next.
 *
 * THE VAULT STEP NEVER OFFERS CREATE ON A READ IT DOES NOT HAVE. While the read
 * is in flight it shows a skeleton; when it failed, Retry — and in both the
 * button is not rendered at all, not merely disabled (VaultCard's rule).
 *
 * THE FOOTER STAYS ON SCREEN. The body scrolls between the dialog's header and
 * this footer, so on a phone the cost line and the button are always visible;
 * the progress ladder and anything long live in the scrolling part.
 */

import { MODE_PROFIT, OFFERED_LEGS } from "@sip/solana-core/client";
import { ArrowLeftRight, ArrowRight, ChartLine, Circle, PiggyBank, RefreshCw, ShieldCheck, type LucideIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PRIMARY_ATTRIBUTE, type OnboardingHeading } from "@/components/onboarding/OnboardingDialog";
import { LimitField } from "@/components/wallets/LimitField";
import { TxProgress } from "@/components/wallets/TxProgress";
import type { CreateRequest, WriteProgress } from "@/hooks/use-vault-actions";
import { formatSol, formatUsd, usdcRawForLamports } from "@/lib/amounts";
import { LIVE_COPY, ONBOARDING_COPY } from "@/lib/live-copy";
import type { OnboardingBodyStep, VaultStepRead } from "@/lib/onboarding";
import { cn } from "@/lib/utils";
import { LINK_COPY, LOSS_DROPPED_AFTER_TXS, PROFIT_RATE, VAULT_COPY, shortAddress } from "@/lib/vault-copy";
import { readLimits } from "@/lib/vault-limits";

/** The setup has two steps before the vault exists; the third screen is its result. */
const STEPS = 2;

/** "20 %", kept on one line: a rate split across two lines reads as two numbers. */
const RATE = PROFIT_RATE.replace(" ", "\u00a0");

/** "SPYx and ANTHROPIC": the first two things the vault can really buy (OFFERED_LEGS). */
export const INVEST_EXAMPLES: string = (() => {
  const symbols = OFFERED_LEGS.slice(0, 2).map((leg) => leg.symbol);
  return symbols.length < 2 ? (symbols[0] ?? "SPYx") : `${symbols[0]} and ${symbols[1]}`;
})();

/** The dialog's header for each screen. */
export function onboardingHeading(step: OnboardingBodyStep): OnboardingHeading {
  switch (step) {
    case "welcome":
      return { eyebrow: ONBOARDING_COPY.stepOf(1, STEPS), title: ONBOARDING_COPY.welcome.title, description: ONBOARDING_COPY.welcome.lede };
    case "vault":
      return { eyebrow: ONBOARDING_COPY.stepOf(2, STEPS), title: ONBOARDING_COPY.vault.title, description: VAULT_COPY.noVaultDescription };
    case "ready":
      return { eyebrow: null, title: ONBOARDING_COPY.ready.title, description: ONBOARDING_COPY.ready.body };
  }
}

export interface OnboardingBodyProps {
  readonly step: OnboardingBodyStep;
  readonly pensionKey: string;
  /** Lamports, or null when the rent could not be read: then it is said, never shown as a figure. */
  readonly vaultRent: bigint | null;
  readonly linkRent: bigint | null;
  readonly fees: bigint;
  readonly usdcPerSol: bigint | null;
  readonly read: VaultStepRead;
  readonly maxText: string;
  readonly reserveText: string;
  readonly onMaxText: (value: string) => void;
  readonly onReserveText: (value: string) => void;
  readonly progress: WriteProgress;
  /** This setup's own write is in progress. */
  readonly running: boolean;
  /** Another writer on the page holds the lock. */
  readonly busyElsewhere: boolean;
  /** A create was sent and is not confirmed: nothing new is offered until it is checked. */
  readonly unconfirmed: boolean;
  readonly onContinue: () => void;
  readonly onBack: () => void;
  readonly onCreate: (request: CreateRequest) => void;
  readonly onRetryRead: () => void;
  readonly onBuildAgain: () => void;
  readonly onCheckAgain: () => void;
  readonly onDismissProgress: () => void;
  readonly onDone: () => void;
  readonly onDisconnect: () => void;
}

const primary = { [PRIMARY_ATTRIBUTE]: "" } as const;

export function OnboardingBody(props: OnboardingBodyProps) {
  const { step } = props;
  if (step === "welcome") return <Welcome {...props} />;
  if (step === "vault") return <VaultStep {...props} />;
  return <Ready {...props} />;
}

/**
 * The body scrolls; the footer does not. The scrolling part is a tab stop of its
 * own, so a keyboard can reach what is below the fold even on a step whose body
 * has nothing else to focus (the welcome's costs).
 */
function Frame({ label, body, footer }: { readonly label: string; readonly body: ReactNode; readonly footer: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-col">
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset sm:px-6"
      >
        {body}
      </div>
      <div className="space-y-3 border-t bg-popover p-4 sm:px-6">{footer}</div>
    </div>
  );
}

/** Whose setup this is, and the way out of the wrong wallet. Disabled while that wallet is being asked. */
function Identity({ pensionKey, onDisconnect, disabled }: { readonly pensionKey: string; readonly onDisconnect: () => void; readonly disabled: boolean }) {
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
      <span>{ONBOARDING_COPY.pensionKey(shortAddress(pensionKey))}</span>
      <span aria-hidden>·</span>
      <span>{ONBOARDING_COPY.notThisWallet}</span>
      <Button type="button" variant="link" size="xs" className="h-auto px-0 text-xs" disabled={disabled} onClick={() => onDisconnect()}>
        {LIVE_COPY.disconnect}
      </Button>
    </p>
  );
}

const TILE = {
  quiet: "bg-muted text-muted-foreground",
  saved: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
  invest: "bg-blue-500/12 text-blue-600 dark:text-blue-400",
} as const;

function Point({ icon: Icon, tone, title, children }: { readonly icon: LucideIcon; readonly tone: keyof typeof TILE; readonly title: string; readonly children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-md", TILE[tone])}>
        <Icon className="size-4.5" aria-hidden />
      </span>
      <span className="min-w-0 space-y-0.5">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-sm text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}

function Welcome({ pensionKey, vaultRent, linkRent, fees, onContinue, onDisconnect }: OnboardingBodyProps) {
  const copy = ONBOARDING_COPY.welcome;
  return (
    <Frame
      label={copy.title}
      body={
        <div className="space-y-4">
          <ul className="space-y-3.5">
            <Point icon={ArrowLeftRight} tone="quiet" title={copy.tradeTitle}>
              {copy.trade}
            </Point>
            <Point icon={PiggyBank} tone="saved" title={copy.saveTitle(RATE)}>
              {copy.save(RATE, LOSS_DROPPED_AFTER_TXS)}
            </Point>
            <Point icon={ChartLine} tone="invest" title={copy.investTitle}>
              {copy.invest(INVEST_EXAMPLES)}
            </Point>
            <Point icon={ShieldCheck} tone="quiet" title={copy.ownTitle}>
              {copy.own}
            </Point>
          </ul>

          <section aria-labelledby="onboarding-costs" className="rounded-lg border bg-muted/30 px-3 py-2.5">
            <h3 id="onboarding-costs" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {copy.costTitle}
            </h3>
            <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-muted-foreground marker:text-muted-foreground/60">
              <li>{vaultRent === null ? copy.costVaultUnknown : copy.costVault(formatSol(vaultRent), formatSol(fees))}</li>
              <li>{linkRent === null ? copy.costLinkUnknown : copy.costLink(formatSol(linkRent))}</li>
              <li>{copy.costSettle}</li>
              <li>{copy.costInvest}</li>
            </ul>
          </section>

          <p className="text-xs text-muted-foreground">{ONBOARDING_COPY.closeHint}</p>
        </div>
      }
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Identity pensionKey={pensionKey} onDisconnect={onDisconnect} disabled={false} />
          <Button type="button" className="ml-auto" onClick={() => onContinue()} {...primary}>
            {copy.continue}
            <ArrowRight aria-hidden />
          </Button>
        </div>
      }
    />
  );
}

function VaultStep(props: OnboardingBodyProps) {
  const { pensionKey, vaultRent, fees, usdcPerSol, read, maxText, reserveText, onMaxText, onReserveText, progress, running, busyElsewhere, unconfirmed } = props;
  const copy = ONBOARDING_COPY.vault;
  const limits = readLimits(maxText, reserveText);
  const blocked = running || busyElsewhere || unconfirmed;
  const shownMax = limits.ok ? formatSol(limits.maxContribution) : maxText.trim();
  const shownReserve = limits.ok ? formatSol(limits.walletReserve) : reserveText.trim();
  const request: CreateRequest | null = limits.ok ? { mode: MODE_PROFIT, maxContribution: limits.maxContribution, walletReserve: limits.walletReserve } : null;

  // The ladder sits in the scrolling part; each time it moves it is brought into
  // view, so a stop and its one way forward are never below the fold.
  const ladderRef = useRef<HTMLDivElement>(null);
  const moment = progress.phase === "running" ? progress.step : progress.phase;
  useEffect(() => {
    if (moment !== "idle") ladderRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [moment]);

  const ladder =
    progress.phase === "idle" ? null : (
      <div ref={ladderRef}>
        <TxProgress
          progress={progress}
          successLabel={VAULT_COPY.created}
          onBuildAgain={() => props.onBuildAgain()}
          onCheckAgain={() => props.onCheckAgain()}
          onDismiss={() => props.onDismissProgress()}
        />
      </div>
    );

  const back = (
    <Button type="button" variant="ghost" disabled={running} onClick={() => props.onBack()}>
      {copy.back}
    </Button>
  );

  if (read !== "form") {
    const reading = read === "reading";
    return (
      <Frame
        label={copy.title}
        body={
          <div className="space-y-4">
            {reading ? (
              <div aria-busy="true" aria-label={VAULT_COPY.loading} className="space-y-3">
                <Skeleton className="h-20 w-full rounded-lg" />
                <Skeleton className="h-10 w-full rounded-lg" />
              </div>
            ) : (
              <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm">
                {VAULT_COPY.unreadable}
              </p>
            )}
            {ladder}
          </div>
        }
        footer={
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              {back}
              {reading ? null : (
                <Button type="button" variant="outline" onClick={() => props.onRetryRead()} {...primary}>
                  <RefreshCw aria-hidden />
                  {VAULT_COPY.retry}
                </Button>
              )}
            </div>
            <Identity pensionKey={pensionKey} onDisconnect={props.onDisconnect} disabled={running} />
          </>
        }
      />
    );
  }

  return (
    <Frame
      label={copy.title}
      body={
        <div className="space-y-4">
          <div className="rounded-lg border px-3 py-2.5">
            <div className="flex items-center gap-2">
              <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", TILE.saved)}>
                <PiggyBank className="size-4" aria-hidden />
              </span>
              <span className="text-sm font-medium">{copy.modeTitle(RATE)}</span>
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">{copy.mode(RATE, LOSS_DROPPED_AFTER_TXS)}</p>
          </div>

          <details className="group rounded-lg border px-3 py-2">
            <summary className="cursor-pointer text-sm font-medium">
              {copy.advanced}
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                {copy.advancedSummary(shownMax, shownReserve)}
              </span>
            </summary>
            <div className="mt-3 space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <LimitField
                  id="onboarding-max-contribution"
                  label={VAULT_COPY.mostPerSettlement}
                  value={maxText}
                  onChange={onMaxText}
                  disabled={blocked}
                  hint={limits.ok && usdcPerSol !== null ? `${VAULT_COPY.aboutUsd(formatUsd(usdcRawForLamports(limits.maxContribution, usdcPerSol)))}. ${copy.maxHint}` : copy.maxHint}
                />
                <LimitField id="onboarding-wallet-reserve" label={VAULT_COPY.alwaysLeft} value={reserveText} onChange={onReserveText} disabled={blocked} hint={copy.reserveHint} />
              </div>
              <p className="text-xs text-muted-foreground">{copy.changeLater}</p>
            </div>
          </details>

          {ladder}
        </div>
      }
      footer={
        <>
          {!limits.ok ? (
            <p role="alert" className="text-xs text-destructive">
              {limits.message}
            </p>
          ) : null}
          <div className="space-y-0.5 text-xs">
            <p>{vaultRent === null ? VAULT_COPY.costUnknown : VAULT_COPY.cost(formatSol(vaultRent), formatSol(fees))}</p>
            <p className="text-muted-foreground">{copy.approveOnce}</p>
            {busyElsewhere ? <p className="text-muted-foreground">{LINK_COPY.busy}</p> : null}
            {unconfirmed ? <p className="font-medium text-amber-700 dark:text-amber-400">{copy.checkAbove}</p> : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {back}
            <Button
              type="button"
              disabled={blocked || request === null}
              aria-busy={running}
              // An explicit object: the flow gets the limits shown, never a click event.
              onClick={() => {
                if (request !== null) props.onCreate(request);
              }}
              {...primary}
            >
              {running ? VAULT_COPY.creating : VAULT_COPY.create}
            </Button>
          </div>
          <Identity pensionKey={pensionKey} onDisconnect={props.onDisconnect} disabled={running} />
        </>
      }
    />
  );
}

function Ready({ progress, onDone }: OnboardingBodyProps) {
  const copy = ONBOARDING_COPY.ready;
  return (
    <Frame
      label={copy.title}
      body={
        <div className="space-y-4">
          <TxProgress progress={progress} successLabel={VAULT_COPY.created} />
          <section aria-labelledby="onboarding-next" className="space-y-2">
            <h3 id="onboarding-next" className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {copy.nextTitle}
            </h3>
            <ol className="space-y-1.5">
              {copy.next.map((line) => (
                <li key={line} className="flex items-center gap-2 text-sm">
                  <Circle className="size-4 text-muted-foreground" aria-hidden />
                  {line}
                </li>
              ))}
            </ol>
          </section>
        </div>
      }
      footer={
        <div className="flex justify-end">
          <Button type="button" onClick={() => onDone()} {...primary}>
            {copy.done}
            <ArrowRight aria-hidden />
          </Button>
        </div>
      }
    />
  );
}

