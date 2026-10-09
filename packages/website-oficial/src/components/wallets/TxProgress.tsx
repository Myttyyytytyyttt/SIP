"use client";

/**
 * WHERE A WRITE IS, AND WHAT TO DO WHEN IT STOPS.
 *
 * Running: (a chained create only) Creating your trading wallet, or (a chained
 * import only) Importing your wallet → Checking SaverFi's permission → Preparing →
 * (a link only) Trading wallet signs the consent → Approve in Phantom → (a link
 * only) Trading wallet signing → Sending → Confirming on Solana → Done. A step
 * the ladder passes without stopping on it (a consent already signed, reused
 * after a rebuild) is shown as done. Landed: "<what happened> · View on
 * Solscan", until dismissed. Stopped: "Took too long" offers Build again, since
 * nothing moved; "Not confirmed yet" offers only Check again on the signature
 * that was sent, never re-signing, and cannot be dismissed; a refusal says why.
 * Cancelled in the wallet (code "declined"): a neutral "Cancelled", not a refusal.
 *
 * HOW LONG "CONFIRMING" HAS STOOD (10-09). Solana usually answers in a second
 * or two; when it does not, a line that reads the same at second three and at
 * second forty looks stuck. A host that passes `startedAt` (useStepStartedAt,
 * below) gets "Confirming on Solana · 8 s" once the step has stood
 * CONFIRMING_ELAPSED_MS, counting in its own leaf (Elapsed.tsx). The count is
 * aria-hidden: this ladder is a polite region, and a number that changes every
 * second inside it would be read out every second. A host that passes nothing
 * keeps today's markup exactly.
 *
 * LANDED, AND NOT ON THE PAGE YET (10-09, plan B4). A host whose landed write
 * the live page has not shown yet passes `syncing` (last-write-context.ts
 * syncingFor, useWriteSyncing): the success line reads "Saving rule updated ·
 * Updating your pension…" with a turning mark — still for reduced motion, the
 * words saying it either way — until the page shows it, or stops claiming it
 * will. Read out with the line it joins; its leaving is not news. A host that
 * passes nothing keeps today's markup exactly.
 */

import { Check, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Elapsed } from "@/components/live/Elapsed";
import { WorkMark } from "@/components/live/WorkMark";
import { Button } from "@/components/ui/button";
import type { WriteProgress } from "@/hooks/use-vault-actions";
import { LIVE_COPY } from "@/lib/live-copy";
import { cn } from "@/lib/utils";
import { PROGRESS_COPY, VAULT_COPY } from "@/lib/vault-copy";
import { DECLINED_CODE, type FlowResult, type FlowStep } from "@/lib/vault-flows";

const CREATE_STEPS: readonly FlowStep[] = ["preparing", "approve_pension", "sending", "confirming", "done"];
const LINK_STEPS: readonly FlowStep[] = ["preparing", "consent", "approve_pension", "trading_signing", "sending", "confirming", "done"];
const CREATE_LINK_STEPS: readonly FlowStep[] = ["creating_wallet", ...LINK_STEPS];
const IMPORT_LINK_STEPS: readonly FlowStep[] = ["importing_wallet", "checking_permission", ...LINK_STEPS];
/** An import no link follows (already linked, or no vault yet): nothing for Phantom, so no link steps promised. */
const IMPORT_STEPS: readonly FlowStep[] = ["importing_wallet", "checking_permission", "done"];

/** The count appears beside "Confirming on Solana": the first read's own threshold (LiveFirstRead.tsx), before which a count is only noise. */
export const CONFIRMING_ELAPSED_MS = 5_000;

/** The step in flight, as one key — the write's kind and its step — or null when nothing runs. */
export function stepKeyOf(progress: WriteProgress): string | null {
  return progress.phase === "running" ? `${progress.kind}:${progress.step}` : null;
}

/** The step in flight and when this browser first showed it. */
export interface StepMark {
  readonly key: string | null;
  readonly at: number | null;
}

export const NO_STEP: StepMark = { key: null, at: null };

/**
 * The mark after `progress`: unchanged while the same step runs, restarted at
 * `now` when another one starts — a rebuild that goes back to "Preparing", a
 * chained link's own "Confirming" after the create's — and cleared when the
 * write stops.
 */
export function markStep(mark: StepMark, progress: WriteProgress, now: number): StepMark {
  const key = stepKeyOf(progress);
  if (key === mark.key) return mark;
  return { key, at: key === null ? null : now };
}

/**
 * When the step in flight began, in this browser's clock (null when nothing
 * runs) — for TxProgress's `startedAt`. Called by the host that owns the
 * write, which stays mounted while the ladder itself may come and go. Worked
 * out during the render, so the step and its moment never disagree for a frame.
 */
export function useStepStartedAt(progress: WriteProgress): number | null {
  const [mark, setMark] = useState<StepMark>(NO_STEP);
  if (stepKeyOf(progress) === mark.key) return mark.at;
  const next = markStep(mark, progress, Date.now());
  setMark(next);
  return next.at;
}

function SolscanLink({ href }: { readonly href: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4">
      {VAULT_COPY.viewOnSolscan}
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}

function stoppedTitle(result: Exclude<FlowResult, { ok: true }>): string {
  switch (result.kind) {
    case "expired":
      return PROGRESS_COPY.tookTooLong;
    case "unconfirmed":
      return PROGRESS_COPY.notConfirmed;
    case "rate_limited":
      return PROGRESS_COPY.rateLimited;
    case "unreadable":
      return PROGRESS_COPY.unreadable;
    default:
      return PROGRESS_COPY.refused;
  }
}

export function TxProgress({
  progress,
  successLabel,
  onBuildAgain,
  onCheckAgain,
  onDismiss,
  approveDetail,
  startedAt = null,
  syncing = false,
}: {
  readonly progress: WriteProgress;
  /** What landed: "Vault created", "Linked", "Policy signed", "Withdrawn". */
  readonly successLabel: string;
  readonly onBuildAgain?: () => void;
  readonly onCheckAgain?: () => void;
  readonly onDismiss?: () => void;
  /** What is being signed, shown while Phantom asks. */
  readonly approveDetail?: ReactNode;
  /** When the step in flight began, in this browser's clock (useStepStartedAt): "Confirming on Solana" then counts. */
  readonly startedAt?: number | null;
  /** The write landed and the live page does not show it yet (last-write-context.ts): the success line says the pension is updating. */
  readonly syncing?: boolean;
}) {
  if (progress.phase === "idle") return null;

  if (progress.phase === "running") {
    const steps =
      progress.kind === "createLink"
        ? CREATE_LINK_STEPS
        : progress.kind === "importLink"
          ? IMPORT_LINK_STEPS
          : progress.kind === "import"
            ? IMPORT_STEPS
            : progress.kind === "link"
              ? LINK_STEPS
              : CREATE_STEPS;
    const current = steps.indexOf(progress.step);
    return (
      <div role="status" aria-live="polite" data-progress={progress.step} className="space-y-1 rounded-md border px-3 py-2 text-xs">
        {steps.map((step, index) => (
          <div key={step} className={cn("flex items-center gap-2", index === current ? "font-medium text-foreground" : "text-muted-foreground", index > current && "opacity-60")}>
            {index < current ? <Check className="size-3.5" aria-hidden /> : index === current ? <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <span className="size-3.5" aria-hidden />}
            {PROGRESS_COPY[step]}
            {index === current && step === "confirming" && startedAt !== null ? (
              <Elapsed from={startedAt} after={CONFIRMING_ELAPSED_MS} className="-ml-0.5 font-normal text-muted-foreground" />
            ) : null}
          </div>
        ))}
        {progress.step === "approve_pension" && approveDetail !== undefined && approveDetail !== null ? <div className="pt-1">{approveDetail}</div> : null}
      </div>
    );
  }

  const { result } = progress;
  if (result.ok) {
    return (
      <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-emerald-600/30 bg-emerald-600/5 px-3 py-2 text-sm">
        <Check className="size-4 text-emerald-700 dark:text-emerald-400" aria-hidden />
        <span className="font-medium">{successLabel}</span>
        {syncing ? (
          <>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1.5 text-muted-foreground" data-syncing="">
              <WorkMark state="syncing" tile={false} />
              {LIVE_COPY.syncing.progress}
            </span>
          </>
        ) : null}
        {result.explorerUrl !== null ? (
          <>
            <span aria-hidden>·</span>
            <SolscanLink href={result.explorerUrl} />
          </>
        ) : null}
        {onDismiss !== undefined ? (
          <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={() => onDismiss()}>
            {VAULT_COPY.dismiss}
          </Button>
        ) : null}
      </div>
    );
  }

  // CANCELLED IN THE WALLET IS NOT AN ERROR (owner, 09-25): the person said no,
  // nothing was sent, and the red "Refused" read as SaverFi having failed. A
  // neutral status, the same shape as the landed one, with its Dismiss.
  if (result.kind === "refused" && result.code === DECLINED_CODE) {
    return (
      <div role="status" data-progress="cancelled" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-sm">
        <span className="font-medium">{PROGRESS_COPY.cancelled}</span>
        <span className="text-xs text-muted-foreground">{result.message}</span>
        {onDismiss !== undefined ? (
          <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={() => onDismiss()}>
            {VAULT_COPY.dismiss}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div role="alert" className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
      <p className="font-medium">{stoppedTitle(result)}</p>
      <p className="text-xs text-muted-foreground">{result.message}</p>
      {result.kind === "unconfirmed" && result.explorerUrl !== null ? (
        <p className="text-xs">
          <SolscanLink href={result.explorerUrl} />
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {result.kind === "expired" && onBuildAgain !== undefined ? (
          <Button type="button" size="sm" variant="outline" onClick={() => onBuildAgain()}>
            <RefreshCw aria-hidden />
            {PROGRESS_COPY.buildAgain}
          </Button>
        ) : null}
        {result.kind === "unconfirmed" && onCheckAgain !== undefined ? (
          <Button type="button" size="sm" variant="outline" onClick={() => onCheckAgain()}>
            <RefreshCw aria-hidden />
            {PROGRESS_COPY.checkAgain}
          </Button>
        ) : null}
        {result.kind !== "unconfirmed" && onDismiss !== undefined ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => onDismiss()}>
            {VAULT_COPY.dismiss}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
