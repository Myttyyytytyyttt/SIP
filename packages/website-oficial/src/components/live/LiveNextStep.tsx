"use client";

/**
 * THE ONE THING TO DO NEXT, and never a number.
 *
 * A pension that has not started yet has no figures worth showing, and the
 * failure this card exists to prevent is a screen full of honest zeroes that
 * reads as "it is broken". So each stage says what is missing, what it costs,
 * and which button fixes it — and the panels behind it stay hidden until there
 * is something real in them.
 *
 * IT NEVER OFFERS TO CREATE WHAT MAY ALREADY EXIST. `vault_unreadable` is not a
 * stage this card handles: a read that failed says nothing about whether a vault
 * is there, and a Create button on that state asks for a signature the chain
 * must refuse. The frame routes that to the unreadable card instead.
 *
 * THE COST IS NAMED BEFORE THE BUTTON IS PRESSED. Creating a vault spends rent
 * that does not come back, so the sentence carries the figure the chain just
 * quoted, and says plainly when it could not be read.
 */

import { Circle, CircleCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatSol } from "@/lib/amounts";
import { LIVE_COPY } from "@/lib/live-copy";
import type { LiveDashboard } from "@/lib/live-types";
import { cn } from "@/lib/utils";
import { VAULT_COPY, ratePercent, shortAddress } from "@/lib/vault-copy";

function Step({ label, done }: { readonly label: string; readonly done: boolean }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {done ? <CircleCheck className="size-4 text-emerald-700 dark:text-emerald-400" aria-hidden /> : <Circle className="size-4 text-muted-foreground" aria-hidden />}
      <span className={done ? "text-muted-foreground line-through" : undefined}>{label}</span>
      <span className="sr-only">{done ? "done" : "not done yet"}</span>
    </li>
  );
}

export function LiveNextStep({
  data,
  pensionKey,
  seatProblem = null,
  onOpenWallets,
  className,
}: {
  readonly data: LiveDashboard;
  readonly pensionKey: string;
  /** Why no trading wallet can be created on this deployment, when that is so. */
  readonly seatProblem?: string | null;
  readonly onOpenWallets: () => void;
  readonly className?: string;
}) {
  const { stage, vault, wallets, policy, rents, protocolPaused } = data;
  // `active` needs no card, and `vault_unreadable` is the frame's to handle.
  if (stage === "active" || stage === "vault_unreadable") return null;

  const shell = (title: string, description: string, children?: React.ReactNode) => (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      {children === undefined ? null : <CardContent className="space-y-4">{children}</CardContent>}
    </Card>
  );

  if (stage === "no_vault") {
    const copy = LIVE_COPY.noVault;
    const short = shortAddress(pensionKey);
    const body = rents.vault === null ? `${copy.bodyNoRent(short)} ${VAULT_COPY.costUnknown}` : copy.body(short, formatSol(rents.vault));
    return shell(
      copy.title,
      body,
      <>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={onOpenWallets}>
            {copy.create}
          </Button>
          <Button type="button" variant="outline" asChild>
            <a href="/wallets">{copy.openWallets}</a>
          </Button>
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">{copy.checklist}</p>
          <ul className="space-y-1.5">
            <Step label={copy.steps[0]} done={vault.exists} />
            <Step label={copy.steps[1]} done={wallets.length > 0} />
            <Step label={copy.steps[2]} done={wallets.some((wallet) => wallet.linkStatus === "this_vault")} />
            <Step label={copy.steps[3]} done={policy.status === "exists"} />
          </ul>
        </div>
      </>,
    );
  }

  if (stage === "no_trading_wallet") {
    const copy = LIVE_COPY.noTradingWallet;
    // A deployment with no keeper seat cannot create one: say why, offer nothing.
    if (seatProblem !== null) return shell(copy.title, seatProblem);
    return shell(
      copy.title,
      copy.body,
      <Button type="button" onClick={onOpenWallets}>
        {copy.create}
      </Button>,
    );
  }

  if (stage === "not_linked") {
    const copy = LIVE_COPY.notLinked;
    // The protocol's own state comes first: linking cannot work either way.
    if (protocolPaused === null) return shell(copy.title, copy.needsConfig);
    if (protocolPaused) return shell(copy.title, copy.paused);
    return shell(
      copy.title,
      // The link's rent is not in this snapshot, so the figure is left out
      // rather than guessed; the modal quotes it before anything is signed.
      copy.bodyNoRent(String(wallets.length)),
      <Button type="button" onClick={onOpenWallets}>
        {copy.link}
      </Button>,
    );
  }

  // waiting_first_settlement
  const rate = vault.rateBps === null ? null : ratePercent(vault.rateBps);
  const short = wallets.filter((wallet) => wallet.canSettle === false && wallet.linkStatus === "this_vault");
  return shell(
    LIVE_COPY.waiting.title,
    rate === null ? LIVE_COPY.waiting.body("its rate") : LIVE_COPY.waiting.body(rate),
    short.length === 0 ? undefined : (
      <ul className="space-y-1.5">
        {short.map((wallet) => (
          <li key={wallet.address} className={cn("text-sm text-amber-700 dark:text-amber-400")}>
            {wallet.label}: {vault.walletReserve === null ? "" : LIVE_COPY.reserveNote(formatSol(vault.walletReserve))}
          </li>
        ))}
      </ul>
    ),
  );
}
