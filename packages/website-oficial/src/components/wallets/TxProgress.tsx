"use client";

/**
 * WHERE A WRITE IS, AND WHAT TO DO WHEN IT STOPS.
 *
 * Running: Preparing → Approve in Phantom → (a link only) Trading wallet signing
 * → Sending → Confirming on Solana → Done. Landed: "<what happened> · View on
 * Solscan", until dismissed. Stopped: "Took too long" offers Build again, since
 * nothing moved; "Not confirmed yet" offers only Check again on the signature
 * that was sent, never re-signing, and cannot be dismissed; a refusal says why.
 */

import { Check, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { WriteProgress } from "@/hooks/use-vault-actions";
import { cn } from "@/lib/utils";
import { PROGRESS_COPY, VAULT_COPY } from "@/lib/vault-copy";
import type { FlowResult, FlowStep } from "@/lib/vault-flows";

const CREATE_STEPS: readonly FlowStep[] = ["preparing", "approve_pension", "sending", "confirming", "done"];
const LINK_STEPS: readonly FlowStep[] = ["preparing", "approve_pension", "trading_signing", "sending", "confirming", "done"];

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
}: {
  readonly progress: WriteProgress;
  /** What landed: "Vault created", "Linked". */
  readonly successLabel: string;
  readonly onBuildAgain?: () => void;
  readonly onCheckAgain?: () => void;
  readonly onDismiss?: () => void;
}) {
  if (progress.phase === "idle") return null;

  if (progress.phase === "running") {
    const steps = progress.kind === "link" ? LINK_STEPS : CREATE_STEPS;
    const current = steps.indexOf(progress.step);
    return (
      <div role="status" aria-live="polite" data-progress={progress.step} className="space-y-1 rounded-md border px-3 py-2 text-xs">
        {steps.map((step, index) => (
          <div key={step} className={cn("flex items-center gap-2", index === current ? "font-medium text-foreground" : "text-muted-foreground", index > current && "opacity-60")}>
            {index < current ? <Check className="size-3.5" aria-hidden /> : index === current ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <span className="size-3.5" aria-hidden />}
            {PROGRESS_COPY[step]}
          </div>
        ))}
      </div>
    );
  }

  const { result } = progress;
  if (result.ok) {
    return (
      <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-emerald-600/30 bg-emerald-600/5 px-3 py-2 text-sm">
        <Check className="size-4 text-emerald-700 dark:text-emerald-400" aria-hidden />
        <span className="font-medium">{successLabel}</span>
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
