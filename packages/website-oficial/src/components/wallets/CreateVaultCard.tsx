"use client";

/**
 * The one write on this screen: VaultFactory.createVault, signed by the
 * pension key.
 *
 * Ported from HEAD (fd927b0) src/components/CreateVaultCard.tsx into shadcn;
 * the onboarding/wizard mode and every Solana, basket, stock and profit path
 * are gone. What does not change: the server-side simulation, and every
 * warning that explains a disabled button — hiding those would leave a button
 * that cannot be pressed and no sentence saying why.
 *
 * The machinery lives in useCreateVault.ts; this file only renders it.
 */

import type { ConnectedWallet } from "@privy-io/react-auth";
import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import type { Address } from "viem";

import { Num } from "@/components/num";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { explorerTxUrl } from "@/lib/chain";
import { LABEL, MONO } from "@/lib/classes";
import type { PublicConfig } from "@/lib/config";
import { shortHex } from "@/lib/format";
import { cn } from "@/lib/utils";

import { useCreateVault, type CreatePhase } from "./useCreateVault";

export interface CreateVaultCardProps {
  /** The pension key: the wallet the user logged in with. Owns the vault. */
  admin: Address;
  config: PublicConfig;
  /** The pension key as a Privy connected wallet; null until Privy hands it over. */
  wallet: ConnectedWallet | null;
  onCreated: (vault: Address) => void;
  className?: string;
}

const PHASE_TEXT: Record<CreatePhase, string> = {
  idle: "Create pension",
  switching: "Switching to Robinhood Chain…",
  signing: "Waiting for your signature…",
  confirming: "Waiting for the receipt…",
};

export function CreateVaultCard({ admin, config, wallet, onCreated, className }: CreateVaultCardProps) {
  const state = useCreateVault({ admin, config, wallet, onCreated });
  const { preview, previewing, trimmedLabel, phase, txHash, created, failure } = state;

  const prepared = preview !== null && preview.ok ? preview.value : null;
  const txUrl = txHash !== null ? explorerTxUrl(config.explorerUrl, txHash) : null;
  const buttonText = phase !== "idle" ? PHASE_TEXT[phase] : previewing ? "Simulating…" : PHASE_TEXT.idle;

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader>
        <CardTitle>Create your pension</CardTitle>
        <CardDescription>
          A contract on Robinhood Chain that holds what you put aside. Only your pension key — the wallet you are
          connected with — can ever take anything out of it.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="pension-name">Name</Label>
          <Input
            id="pension-name"
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
            disabled={phase !== "idle" || created !== null}
            value={state.label}
            onChange={(event) => state.setLabel(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Your name, hashed, decides the address. Same name, same address, forever.
          </p>
        </div>

        <dl className="divide-y rounded-lg border text-sm">
          <Row label="Pension key">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className={MONO} tabIndex={0}>
                  {shortHex(admin)}
                </span>
              </TooltipTrigger>
              <TooltipContent className={MONO}>{admin}</TooltipContent>
            </Tooltip>
          </Row>

          <Row label="Cohort" tag="upgrade group">
            <Num>{String(prepared !== null ? prepared.cohortId : config.cohortId)}</Num>
          </Row>

          <Row label="Address" tag="predicted">
            {trimmedLabel === "" ? (
              <span className="text-muted-foreground">enter a name first</span>
            ) : previewing || preview === null ? (
              <Skeleton role="status" aria-label="Computing the address" className="h-4 w-full max-w-[42ch]" />
            ) : !preview.ok ? (
              <span className="text-muted-foreground">unknown</span>
            ) : preview.value.predicted !== null ? (
              // The one fact this chain lets us state before anything exists:
              // the address is derived, so it can be shown before the vault is.
              // It is the difference between "trust us" and "here is where it
              // will be" — the full thing, not an abbreviation.
              <span className={cn(MONO, "break-all")}>{preview.value.predicted}</span>
            ) : (
              <span className="text-muted-foreground">
                could not predict: <span className={MONO}>{preview.value.predictionError}</span>
              </span>
            )}
          </Row>
        </dl>

        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Details</summary>
          <div className="mt-2 space-y-2">
            <p className="break-all">
              userSalt — your name above, hashed:{" "}
              <span className={MONO}>{prepared !== null ? prepared.userSalt : "computing…"}</span>
            </p>
            <p>
              What you put aside is held as WETH. The 30-day ceiling on contributions is left open, so no trading
              wallet can starve another.
            </p>
          </div>
        </details>

        {prepared !== null && !prepared.cohortRegistered ? (
          <Notice tone="error">
            <strong>Cohort {String(prepared.cohortId)} is not registered on this factory.</strong>{" "}
            <span className={MONO}>cohorts({String(prepared.cohortId)}).beacon</span> is the zero address, so
            createVault reverts <span className={MONO}>InvalidCohort</span>. Set{" "}
            <span className={MONO}>NUVEM_COHORT_ID</span> to a registered cohort (mainnet uses 1).
          </Notice>
        ) : null}

        {prepared !== null && prepared.simulationError !== null ? (
          <Notice tone="error">
            <strong>The chain rejects this call as it stands.</strong>{" "}
            <span className={cn(MONO, "break-all")}>{prepared.simulationError}</span> This was simulated
            server-side before asking you to sign anything, so nothing has been spent. Signing would only reproduce
            the same revert.
          </Notice>
        ) : null}

        {prepared !== null && prepared.simulationError === null && prepared.predicted === null ? (
          <Notice tone="error">
            <strong>The address could not be predicted.</strong> The chain did not answer{" "}
            <span className={MONO}>predictVault</span>, and this page will not ask for a signature without knowing
            where the pension will be. Try again in a moment.
          </Notice>
        ) : null}

        {preview !== null && !preview.ok ? (
          <Notice tone="error">
            <strong>Could not prepare the transaction.</strong>{" "}
            <span className={cn(MONO, "break-all")}>{preview.error}</span>
          </Notice>
        ) : null}

        <div className="space-y-2">
          <Button
            type="button"
            className="w-full"
            disabled={!state.canCreate}
            aria-busy={phase !== "idle"}
            onClick={() => void state.create()}
          >
            {buttonText}
          </Button>
          <p className="text-xs text-muted-foreground">
            {wallet === null ? "Waiting for your wallet…" : "One signature. Gas is paid by your pension key."}
          </p>
        </div>

        {txHash !== null ? (
          <p className="text-xs text-muted-foreground">
            Transaction{" "}
            {txUrl !== null ? (
              <a
                className={cn(MONO, "inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline")}
                href={txUrl}
                rel="noreferrer noopener"
                target="_blank"
              >
                {shortHex(txHash)}
                <ExternalLink aria-hidden className="size-3" />
                <span className="sr-only">(opens the explorer in a new tab)</span>
              </a>
            ) : (
              <span className={cn(MONO, "break-all text-foreground")}>{txHash}</span>
            )}
          </p>
        ) : null}

        {created !== null ? (
          <Notice tone="ok">
            <strong>Pension created.</strong> <span className={cn(MONO, "break-all")}>{created}</span> is now a
            contract on chain.
          </Notice>
        ) : null}

        {failure !== null ? (
          <Notice tone="error">
            <strong>Nothing was created.</strong> <span className={cn(MONO, "break-all")}>{failure}</span> If you
            declined the network switch or the signature, that is all this is. If a contract error was named, that
            error is the real reason and retrying will not change it.
          </Notice>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default CreateVaultCard;

function Row({ label, tag, children }: { label: string; tag?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3">
      <dt className={cn(LABEL, "shrink-0 sm:w-24")}>{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
      {tag !== undefined ? (
        <Badge variant="outline" className="hidden shrink-0 sm:inline-flex">
          {tag}
        </Badge>
      ) : null}
    </div>
  );
}

/**
 * A sentence that explains a state. Errors are announced (role="alert");
 * the rest is polite. The only colour is the destructive token on an error's
 * lead — the page's accent is reserved for money put aside.
 */
function Notice({ tone, children }: { tone: "error" | "ok"; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-md border p-3 text-sm",
        tone === "error" ? "border-destructive/30 [&>strong]:text-destructive" : "bg-muted/50",
      )}
    >
      {children}
    </div>
  );
}
