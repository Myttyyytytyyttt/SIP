"use client";

/**
 * THE VAULT CARD: the pension key's vault, or the form that creates it.
 *
 * FOUR STATES. Loading: a skeleton. Unreadable (the route did not answer, or its
 * vault read failed): words and Retry, and never the create form, because the
 * vault may exist. No vault: the mode choice with each mode's honest rule, the
 * limits, the live rent, and Create vault. A vault: its rule, address, balance,
 * what can be withdrawn, and whether it is paused.
 *
 * VOLUME IS NOT OFFERED until VOLUME_MODE_OFFERED says so: its option is greyed
 * with "Coming soon" and the reason, and the build route refuses mode 1 as well.
 *
 * WHAT IS SIGNED is what the form shows: the flow sends these exact limits, and
 * checks the built transaction carries them before Phantom is asked.
 */

import {
  DEFAULT_VAULT_POLICY,
  MODE_PROFIT,
  MODE_VOLUME,
  SIGNATURE_FEE_LAMPORTS,
  VOLUME_MODE_OFFERED,
  ownerComputeBudget,
  priorityFeeLamports,
} from "@sip/solana-core/client";
import { RefreshCw } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Num } from "@/components/num";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { AddressLine } from "@/components/wallets/AddressLine";
import { TxProgress } from "@/components/wallets/TxProgress";
import { VAULT_CARD_ID } from "@/components/wallets/VaultScreen";
import { useVaultWrite } from "@/hooks/use-vault-actions";
import { useVaultScreen } from "@/hooks/use-vault-state";
import { AmountError, SOL_DECIMALS, formatSol, formatUnits, formatUsd, parseUnits, rawFrom, usdcRawForLamports } from "@/lib/amounts";
import { LABEL } from "@/lib/classes";
import { cn } from "@/lib/utils";
import type { VaultStateJson } from "@/lib/vault-api";
import { PROFIT_RATE, VAULT_COPY, VOLUME_RATE, ratePercent } from "@/lib/vault-copy";

type VaultWrite = ReturnType<typeof useVaultWrite>;

/**
 * The anchor sits on the section, not on one state's form: the trading wallets
 * card sends a wallet with no vault to "#vault", and that link must resolve
 * whichever of the four states this card is in — a read that failed shows no
 * form, and a button pointing at nothing does nothing.
 */
export function VaultCard({ volumeOffered = VOLUME_MODE_OFFERED }: { readonly volumeOffered?: boolean }) {
  const screen = useVaultScreen();
  if (screen === null) return null;
  return (
    <section id={VAULT_CARD_ID} className="scroll-mt-4">
      <VaultCardBody volumeOffered={volumeOffered} />
    </section>
  );
}

function VaultCardBody({ volumeOffered }: { readonly volumeOffered: boolean }) {
  const screen = useVaultScreen();
  const write = useVaultWrite("vault");
  if (screen === null) return null;
  const { view } = screen;

  const progress = (
    <TxProgress
      progress={write.progress}
      successLabel={VAULT_COPY.created}
      onBuildAgain={() => void write.buildAgain()}
      onCheckAgain={() => void write.checkAgain()}
      onDismiss={() => write.dismiss()}
    />
  );

  if (view.kind === "loading") {
    return (
      <Card aria-busy="true" aria-label={VAULT_COPY.loading}>
        <CardHeader>
          <CardTitle>{VAULT_COPY.title}</CardTitle>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (view.kind === "unreadable" || view.state.vault.status === "unreadable") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{VAULT_COPY.title}</CardTitle>
          <CardDescription role="alert">{VAULT_COPY.unreadable}</CardDescription>
          <CardAction>
            <Button type="button" variant="outline" size="sm" onClick={() => screen.refresh()}>
              <RefreshCw aria-hidden />
              {VAULT_COPY.retry}
            </Button>
          </CardAction>
        </CardHeader>
        {write.progress.phase !== "idle" ? <CardContent>{progress}</CardContent> : null}
      </Card>
    );
  }

  const { state } = view;
  return state.vault.status === "missing" ? (
    <CreateVault state={state} volumeOffered={volumeOffered} write={write} progress={progress} />
  ) : (
    <VaultSummary state={state} write={write} progress={progress} />
  );
}

type Limits = { readonly ok: true; readonly maxContribution: bigint; readonly walletReserve: bigint } | { readonly ok: false; readonly message: string };

function readLimits(maxText: string, reserveText: string): Limits {
  try {
    const maxContribution = parseUnits(maxText, SOL_DECIMALS, VAULT_COPY.mostPerSettlement);
    const walletReserve = parseUnits(reserveText, SOL_DECIMALS, VAULT_COPY.alwaysLeft);
    if (maxContribution === 0n) return { ok: false, message: VAULT_COPY.zeroSettlement };
    return { ok: true, maxContribution, walletReserve };
  } catch (error) {
    if (error instanceof AmountError) return { ok: false, message: error.message };
    throw error;
  }
}

function CreateVault({ state, volumeOffered, write, progress }: { readonly state: VaultStateJson; readonly volumeOffered: boolean; readonly write: VaultWrite; readonly progress: ReactNode }) {
  const [chosen, setChosen] = useState<number>(DEFAULT_VAULT_POLICY.mode);
  const [maxText, setMaxText] = useState(() => formatUnits(DEFAULT_VAULT_POLICY.maxContribution, SOL_DECIMALS));
  const [reserveText, setReserveText] = useState(() => formatUnits(DEFAULT_VAULT_POLICY.walletReserve, SOL_DECIMALS));

  const mode = chosen === MODE_VOLUME && volumeOffered ? MODE_VOLUME : MODE_PROFIT;
  const limits = readLimits(maxText, reserveText);
  const shownMax = limits.ok ? formatSol(limits.maxContribution) : maxText.trim();
  const shownReserve = limits.ok ? formatSol(limits.walletReserve) : reserveText.trim();
  const usdcPerSol = rawFrom(state.prices?.usdcRawPerSol);
  const rent = rawFrom(state.rents?.vault);
  const fees = SIGNATURE_FEE_LAMPORTS + priorityFeeLamports(ownerComputeBudget("create_vault_v2"));
  const blocked = write.running || write.busyElsewhere || write.unconfirmed;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{VAULT_COPY.title}</CardTitle>
        <CardDescription>
          {VAULT_COPY.noVault}. {VAULT_COPY.noVaultDescription}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <fieldset className="space-y-3" disabled={blocked}>
          <legend className={cn(LABEL, "mb-2")}>{VAULT_COPY.modeLegend}</legend>
          <label className="flex items-start gap-2">
            <input type="radio" name="vault-mode" value={MODE_PROFIT} checked={mode === MODE_PROFIT} onChange={() => setChosen(MODE_PROFIT)} className="mt-1 size-4 shrink-0 accent-primary" />
            <span className="space-y-1">
              <span className="block text-sm font-medium">{VAULT_COPY.profitLabel}</span>
              <span className="block text-xs text-muted-foreground">{VAULT_COPY.profitRule(PROFIT_RATE, shownMax, shownReserve)}</span>
            </span>
          </label>
          <label className={cn("flex items-start gap-2", !volumeOffered && "text-muted-foreground")}>
            <input
              type="radio"
              name="vault-mode"
              value={MODE_VOLUME}
              checked={mode === MODE_VOLUME}
              disabled={!volumeOffered}
              onChange={() => setChosen(MODE_VOLUME)}
              className="mt-1 size-4 shrink-0 accent-primary"
            />
            <span className="space-y-1">
              <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {VAULT_COPY.volumeLabel}
                {!volumeOffered ? <Badge variant="secondary">{VAULT_COPY.comingSoon}</Badge> : null}
              </span>
              <span className="block text-xs text-muted-foreground">{volumeOffered ? VAULT_COPY.volumeRule(VOLUME_RATE, shownMax, shownReserve) : VAULT_COPY.volumeComing}</span>
            </span>
          </label>
        </fieldset>

        <details className="rounded-md border px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">{VAULT_COPY.limits}</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <LimitField
              id="vault-max-contribution"
              label={VAULT_COPY.mostPerSettlement}
              value={maxText}
              onChange={setMaxText}
              disabled={blocked}
              hint={limits.ok && usdcPerSol !== null ? VAULT_COPY.aboutUsd(formatUsd(usdcRawForLamports(limits.maxContribution, usdcPerSol))) : null}
            />
            <LimitField id="vault-wallet-reserve" label={VAULT_COPY.alwaysLeft} value={reserveText} onChange={setReserveText} disabled={blocked} hint={null} />
          </div>
        </details>

        <p className="text-xs text-muted-foreground">{VAULT_COPY.bothModes(rent === null ? "some" : formatSol(rent))}</p>
        <p className="text-xs">{rent === null ? VAULT_COPY.costUnknown : VAULT_COPY.cost(formatSol(rent), formatSol(fees))}</p>
        {!limits.ok ? (
          <p role="alert" className="text-xs text-destructive">
            {limits.message}
          </p>
        ) : null}

        <Button
          type="button"
          disabled={blocked || !limits.ok}
          aria-busy={write.running}
          // An explicit object: the flow gets the limits shown, never a click event.
          onClick={() => {
            if (limits.ok) void write.createVault({ mode, maxContribution: limits.maxContribution, walletReserve: limits.walletReserve });
          }}
        >
          {write.running ? VAULT_COPY.creating : VAULT_COPY.create}
        </Button>
        {progress}
      </CardContent>
    </Card>
  );
}

function LimitField({
  id,
  label,
  value,
  onChange,
  disabled,
  hint,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly hint: string | null;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={id} inputMode="decimal" autoComplete="off" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} className="font-mono" />
        <span className="text-sm text-muted-foreground">SOL</span>
      </div>
      {hint !== null ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function createdDate(seconds: string | undefined): string | null {
  const value = Number(seconds);
  return Number.isSafeInteger(value) && value > 0 ? new Date(value * 1_000).toISOString().slice(0, 10) : null;
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className={LABEL}>{label}</dt>
      <dd>
        <Num>{children}</Num>
      </dd>
    </div>
  );
}

/**
 * THE CAP PER SETTLEMENT, AFTER THE VAULT IS MADE.
 *
 * It used to be choosable only at creation: maxContribution was a createVault
 * field and no action changed it afterwards. setPolicy carries it now.
 *
 * ALL SIX FIELDS TRAVEL, because set_policy_v2 writes all six. What is NOT
 * offered here is as deliberate as what is: the mode, the two rates and the
 * paused flag are read from the vault and sent back EXACTLY as they stand, so
 * changing a limit cannot quietly change how the vault saves. Only the two
 * lamport amounts are editable, and only through the same readLimits the
 * creation form uses — one rule, one place.
 *
 * AND THE NONCE IS SAID BEFORE THE BUTTON, not after. Every set_policy_v2 bumps
 * vault.policy_nonce, which invalidates settlements already in flight; the
 * owner reads that above the button rather than discovering it as a delay.
 */
function ChangeLimits({ state, account, write }: { readonly state: VaultStateJson; readonly account: NonNullable<VaultStateJson["vault"]["state"]>; readonly write: VaultWrite }) {
  const storedMax = rawFrom(account.maxContribution) ?? 0n;
  const storedReserve = rawFrom(account.walletReserve) ?? 0n;
  const [maxText, setMaxText] = useState(() => formatUnits(storedMax, SOL_DECIMALS));
  const [reserveText, setReserveText] = useState(() => formatUnits(storedReserve, SOL_DECIMALS));
  const [open, setOpen] = useState(false);

  const limits = readLimits(maxText, reserveText);
  const blocked = write.running || write.busyElsewhere || write.unconfirmed;
  const usdcPerSol = rawFrom(state.prices?.usdcRawPerSol);
  // A rule identical to the stored one still bumps the nonce, so there is
  // nothing to gain by signing it: the button says so rather than spending a
  // signature and delaying a settlement for no change at all.
  const unchanged = limits.ok && limits.maxContribution === storedMax && limits.walletReserve === storedReserve;

  return (
    <details
      className="rounded-md border px-3 py-2 text-xs"
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-sm font-medium">{VAULT_COPY.changeLimits}</summary>
      <div className="mt-3 space-y-3">
        <p className="text-muted-foreground">{VAULT_COPY.changeLimitsHint}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <LimitField
            id="vault-change-max-contribution"
            label={VAULT_COPY.mostPerSettlement}
            value={maxText}
            onChange={setMaxText}
            disabled={blocked}
            hint={limits.ok && usdcPerSol !== null ? VAULT_COPY.aboutUsd(formatUsd(usdcRawForLamports(limits.maxContribution, usdcPerSol))) : null}
          />
          <LimitField id="vault-change-wallet-reserve" label={VAULT_COPY.alwaysLeft} value={reserveText} onChange={setReserveText} disabled={blocked} hint={null} />
        </div>
        {!limits.ok ? (
          <p role="alert" className="text-destructive">
            {limits.message}
          </p>
        ) : null}
        <p className="rounded-md border border-amber-600/30 bg-amber-600/5 px-3 py-2">{VAULT_COPY.nonceNotice}</p>
        {unchanged ? <p className="text-muted-foreground">{VAULT_COPY.limitsUnchanged}</p> : null}
        <Button
          type="button"
          disabled={!limits.ok || unchanged || blocked}
          aria-busy={write.running}
          onClick={() => {
            if (!limits.ok || unchanged) return;
            // THE VAULT'S CURRENT MODE, RATES AND PAUSED FLAG GO BACK UNTOUCHED:
            // set_policy_v2 writes every field, so leaving one out would mean
            // overwriting it with a guess.
            void write.setPolicy({
              mode: account.skimMode,
              skimBps: account.skimBps,
              volumeBps: account.volumeBps,
              paused: account.paused,
              maxContribution: limits.maxContribution,
              walletReserve: limits.walletReserve,
            });
          }}
        >
          {write.running ? VAULT_COPY.savingLimits : VAULT_COPY.saveLimits}
        </Button>
      </div>
    </details>
  );
}

function VaultSummary({ state, write, progress }: { readonly state: VaultStateJson; readonly write: VaultWrite; readonly progress: ReactNode }) {
  const { vault } = state;
  const account = vault.state;
  const volume = account?.skimMode === MODE_VOLUME;
  const rate = account === undefined ? "" : ratePercent(volume ? account.volumeBps : account.skimBps);
  const max = formatSol(rawFrom(account?.maxContribution) ?? 0n);
  const reserve = formatSol(rawFrom(account?.walletReserve) ?? 0n);
  const created = createdDate(account?.createdAt);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{VAULT_COPY.title}</CardTitle>
        <CardDescription>{`${volume ? "Volume" : "Profit"} · ${rate}`}</CardDescription>
        {account?.paused === true ? (
          <CardAction>
            <Badge variant="destructive">{VAULT_COPY.paused}</Badge>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <div className={LABEL}>{VAULT_COPY.address}</div>
          <AddressLine address={vault.address} />
        </div>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Fact label={VAULT_COPY.balance}>{formatSol(rawFrom(vault.lamports) ?? 0n)} SOL</Fact>
          <Fact label={VAULT_COPY.withdrawable}>{formatSol(rawFrom(vault.withdrawableLamports) ?? 0n)} SOL</Fact>
          {created !== null ? <Fact label={VAULT_COPY.createdOn}>{created}</Fact> : null}
        </dl>
        <p className="text-xs text-muted-foreground">{volume ? VAULT_COPY.volumeRule(rate, max, reserve) : VAULT_COPY.profitRule(rate, max, reserve)}</p>
        {account !== undefined ? <ChangeLimits state={state} account={account} write={write} /> : null}
        {progress}
      </CardContent>
    </Card>
  );
}
