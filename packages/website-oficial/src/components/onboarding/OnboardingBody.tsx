"use client";

/**
 * WHAT THE NEW-USER SETUP SHOWS, step by step — a pure view.
 *
 * Props in, callbacks out: no Privy, no chain, no storage. OnboardingHost feeds
 * it the shared vault read and the one create-vault writer; the tests and the
 * preview feed it fixtures, which is how every state is seen without a login.
 *
 * THREE SCREENS. Welcome: the brand, a line of four points, the motion, and what
 * SaverFi does — nothing to read before moving on (owner, 09-24: as little
 * friction as possible). Every cost is said where it is paid: the vault's rent
 * above Create vault, the link's and investing's in their own cards before
 * their signatures. Vault: profit at the product's
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

import { DEFAULT_VAULT_POLICY, MODE_PROFIT, OFFERED_LEGS } from "@sip/solana-core/client";
import { ArrowLeftRight, ArrowRight, ChartLine, Circle, PiggyBank, RefreshCw, ShieldCheck, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PRIMARY_ATTRIBUTE, type OnboardingHeading } from "@/components/onboarding/OnboardingDialog";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { TxProgress } from "@/components/wallets/TxProgress";
import type { CreateRequest, WriteProgress } from "@/hooks/use-vault-actions";
import { formatSol } from "@/lib/amounts";
import { LIVE_COPY, ONBOARDING_COPY } from "@/lib/live-copy";
import { SETUP_RATE, setupRate, type OnboardingBodyStep, type VaultStepRead } from "@/lib/onboarding";
import { MONO } from "@/lib/classes";
import { cn } from "@/lib/utils";
import { LINK_COPY, PROFIT_RATE, VAULT_COPY, ratePercent, shortAddress } from "@/lib/vault-copy";

/** The setup has two steps before the vault exists; the third screen is its result. */
const STEPS = 2;

/** "20 %", kept on one line: a rate split across two lines reads as two numbers. */
const onOneLine = (rate: string): string => rate.replace(" ", "\u00a0");
const RATE = onOneLine(PROFIT_RATE);
/** A rate in basis points, as the setup writes it: "15 %", on one line. */
const pct = (bps: number): string => onOneLine(ratePercent(bps));

/** "SPYx and ANTHROPIC": the first two things the vault can really buy (OFFERED_LEGS). */
export const INVEST_EXAMPLES: string = (() => {
  const symbols = OFFERED_LEGS.slice(0, 2).map((leg) => leg.symbol);
  return symbols.length < 2 ? (symbols[0] ?? "SPYx") : `${symbols[0]} and ${symbols[1]}`;
})();

/** The dialog's header for each screen; the vault step's points carry the share being chosen. */
export function onboardingHeading(step: OnboardingBodyStep, rateBps: number = SETUP_RATE.initial): OnboardingHeading {
  switch (step) {
    case "welcome":
      return {
        eyebrow: ONBOARDING_COPY.stepOf(1, STEPS),
        title: ONBOARDING_COPY.welcome.title,
        titleLead: ONBOARDING_COPY.welcome.titleLead,
        description: ONBOARDING_COPY.welcome.lede,
        points: ONBOARDING_COPY.welcome.points,
        hero: true,
        brand: true,
      };
    case "vault":
      return {
        eyebrow: ONBOARDING_COPY.stepOf(2, STEPS),
        title: ONBOARDING_COPY.vault.title,
        description: VAULT_COPY.noVaultDescription,
        points: ONBOARDING_COPY.vault.points(pct(rateBps)),
        hero: true,
      };
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
  readonly read: VaultStepRead;
  /** The profit share being chosen, in basis points (SETUP_RATE's range). */
  readonly rateBps: number;
  readonly onRate: (bps: number) => void;
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

/** One of the four things SaverFi does: second to the motion, so smaller than it. */
function Point({ icon: Icon, tone, title, children }: { readonly icon: LucideIcon; readonly tone: keyof typeof TILE; readonly title: string; readonly children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <span className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", TILE[tone])}>
        <Icon className="size-3.5" aria-hidden />
      </span>
      <span className="min-w-0 space-y-0.5">
        <span className="block text-[0.8rem] font-medium">{title}</span>
        <span className="block text-xs leading-relaxed text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}

/**
 * Each step's motion (the owner's clips, public/motion/onboarding{1,2}.mp4,
 * re-encoded to H.264 so every browser plays them — the originals are 10-bit
 * HEVC, which Chrome on Windows and Firefox do not), and its still frame for
 * someone who asked for less motion.
 */
export const STEP_MOTION = {
  welcome: { video: "/motion/onboarding-welcome.mp4", poster: "/motion/onboarding-welcome.jpg" },
  vault: { video: "/motion/onboarding-vault.mp4", poster: "/motion/onboarding-vault.jpg" },
} as const;

const REDUCED = "(prefers-reduced-motion: reduce)";
const subscribeReduced = (onChange: () => void): (() => void) => {
  const query = window.matchMedia(REDUCED);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

/** Whether the person asked for less motion. False on the server: the setup is never server-rendered anyway. */
function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, () => window.matchMedia(REDUCED).matches, () => false);
}

/** The motion says with pictures what the words around it say, so it is hidden from screen readers. */
function StepMotion({ motion }: { readonly motion: (typeof STEP_MOTION)[keyof typeof STEP_MOTION] }) {
  const reduced = useReducedMotion();
  return (
    <div className="aspect-video overflow-hidden rounded-xl bg-[#1d1d1d] ring-1 ring-foreground/10">
      {reduced ? (
        // eslint-disable-next-line @next/next/no-img-element -- a fixed still in public/, no optimisation to gain
        <img src={motion.poster} alt="" aria-hidden className="size-full object-cover" />
      ) : (
        <video key={motion.video} src={motion.video} poster={motion.poster} autoPlay muted loop playsInline preload="auto" aria-hidden className="size-full object-cover" />
      )}
    </div>
  );
}

function Welcome({ pensionKey, onContinue, onDisconnect }: OnboardingBodyProps) {
  const copy = ONBOARDING_COPY.welcome;
  return (
    <Frame
      label={copy.title}
      body={
        <div className="space-y-5">
          <StepMotion motion={STEP_MOTION.welcome} />
          <ul className="grid gap-x-5 gap-y-3.5 sm:grid-cols-2">
            <Point icon={ArrowLeftRight} tone="quiet" title={copy.tradeTitle}>
              {copy.trade}
            </Point>
            <Point icon={PiggyBank} tone="saved" title={copy.saveTitle}>
              {copy.save(RATE)}
            </Point>
            <Point icon={ChartLine} tone="invest" title={copy.investTitle}>
              {copy.invest(INVEST_EXAMPLES)}
            </Point>
            <Point icon={ShieldCheck} tone="quiet" title={copy.ownTitle}>
              {copy.own}
            </Point>
          </ul>
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
  const { pensionKey, vaultRent, fees, read, rateBps, onRate, progress, running, busyElsewhere, unconfirmed } = props;
  const copy = ONBOARDING_COPY.vault;
  const blocked = running || busyElsewhere || unconfirmed;
  const rate = setupRate(rateBps);
  // THE LIMITS ARE THE PRODUCT'S (owner, 09-24): no Advanced, nothing else to decide on a first vault.
  // They can be changed later from the vault card, and the rule below says the one that matters.
  const request: CreateRequest = { mode: MODE_PROFIT, skimBps: rate, maxContribution: DEFAULT_VAULT_POLICY.maxContribution, walletReserve: DEFAULT_VAULT_POLICY.walletReserve };
  const preset = SETUP_RATE.presets.some((value) => value === rate) ? String(rate) : "";

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
            <StepMotion motion={STEP_MOTION.vault} />
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Identity pensionKey={pensionKey} onDisconnect={props.onDisconnect} disabled={running} />
            <div className="ml-auto flex items-center gap-2">
              {back}
              {reading ? null : (
                <Button type="button" variant="outline" onClick={() => props.onRetryRead()} {...primary}>
                  <RefreshCw aria-hidden />
                  {VAULT_COPY.retry}
                </Button>
              )}
            </div>
          </div>
        }
      />
    );
  }

  return (
    <Frame
      label={copy.title}
      body={
        <div className="space-y-4">
          <StepMotion motion={STEP_MOTION.vault} />

          {/* The one choice: how much of each gain the vault keeps. The same bar and presets as the rule card. */}
          <div role="group" aria-labelledby="onboarding-rate" className="space-y-2.5 rounded-lg border px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <Label id="onboarding-rate" className="flex items-center gap-2 text-[0.8rem]">
                <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md", TILE.saved)}>
                  <PiggyBank className="size-3.5" aria-hidden />
                </span>
                {copy.rateLabel}
              </Label>
              <span className={cn(MONO, "text-xl font-semibold")}>{pct(rate)}</span>
            </div>
            <Slider
              value={[rate]}
              min={SETUP_RATE.min}
              max={SETUP_RATE.max}
              step={SETUP_RATE.step}
              disabled={blocked}
              onValueChange={(values) => {
                const next = values[0];
                if (next !== undefined) onRate(setupRate(next));
              }}
              // The thumb is what a screen reader lands on: name it, and speak the percent rather than the basis points.
              thumbProps={{ "aria-labelledby": "onboarding-rate", "aria-valuetext": pct(rate) }}
            />
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={preset}
              disabled={blocked}
              onValueChange={(value) => {
                if (value) onRate(setupRate(Number(value)));
              }}
              className="w-full"
            >
              {SETUP_RATE.presets.map((value) => (
                <ToggleGroupItem key={value} value={String(value)} className={cn(MONO, "flex-1")}>
                  {pct(value)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">{copy.ruleLine(formatSol(DEFAULT_VAULT_POLICY.maxContribution))}</p>
          </div>

          {ladder}
        </div>
      }
      footer={
        <>
          <div className="space-y-0.5 text-xs">
            <p>{vaultRent === null ? VAULT_COPY.costUnknown : copy.cost(formatSol(vaultRent), formatSol(fees))}</p>
            {busyElsewhere ? <p className="text-muted-foreground">{LINK_COPY.busy}</p> : null}
            {unconfirmed ? <p className="font-medium text-amber-700 dark:text-amber-400">{copy.checkAbove}</p> : null}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Identity pensionKey={pensionKey} onDisconnect={props.onDisconnect} disabled={running} />
            <div className="ml-auto flex items-center gap-2">
              {back}
              <Button
                type="button"
                disabled={blocked}
                aria-busy={running}
                // An explicit object: the flow gets the limits shown, never a click event.
                onClick={() => props.onCreate(request)}
                {...primary}
              >
                {running ? VAULT_COPY.creating : VAULT_COPY.create}
              </Button>
            </div>
          </div>
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

