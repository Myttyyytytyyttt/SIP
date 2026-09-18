"use client";

/**
 * LINKING ONE TRADING WALLET TO THE VAULT, inside its row.
 *
 * WHAT THE CHAIN SAYS, NOT WHAT WAS ASKED: the badge and the button come from
 * /api/solana-vault's walletLinks. Linked to this vault: a badge and the link on
 * Solscan. Linked to another vault: words and no button, because only that
 * vault's owner can unlink it. Unreadable: words and no button. Not linked: Link
 * to vault, disabled with the reason while there is no vault, while SIP's program
 * is not configured or is paused, or while another write runs on the screen.
 *
 * THE PENSION KEY IS NEVER OFFERED. Its row gets no control at all: the program,
 * the verifier, the build route and the flow each refuse it as well.
 *
 * A WALLET THE READ HAS NOT COVERED IS NEVER DROPPED. A wallet created a moment
 * ago is not in Privy's record yet, so the chain read has not been asked about it
 * and nothing can be said about its link. The row still says that, with Check
 * again, rather than rendering nothing: after a chained create-and-link stops,
 * this is the row the wallet must be found in.
 *
 * Clicking opens an inline panel, never a dialog (Privy's own dialogs open over
 * this screen, which is sometimes itself a dialog), that says what three
 * signatures will do and what they cost.
 */

import { solscanAccount } from "@sip/solana-core/client";
import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TxProgress } from "@/components/wallets/TxProgress";
import { useVaultWrite } from "@/hooks/use-vault-actions";
import { useVaultScreen } from "@/hooks/use-vault-state";
import { formatSol, rawFrom } from "@/lib/amounts";
import { linkGate } from "@/lib/create-and-link";
import type { SeatStatus } from "@/lib/trading-wallets";
import { CREATE_LINK_COPY, LINK_COPY } from "@/lib/vault-copy";

export function LinkControl({ address, seat }: { readonly address: string; readonly seat: SeatStatus }) {
  const screen = useVaultScreen();
  const write = useVaultWrite(`link:${address}`);
  const [open, setOpen] = useState(false);
  if (screen === null || address === screen.pensionKey || screen.view.kind === "loading") return null;

  const progress = (
    <TxProgress
      progress={write.progress}
      successLabel={LINK_COPY.done}
      onBuildAgain={() => void write.buildAgain()}
      onCheckAgain={() => void write.checkAgain()}
      onDismiss={() => write.dismiss()}
    />
  );

  const { view } = screen;
  if (view.kind === "unreadable") {
    return (
      <div className="space-y-2" data-link="unreadable">
        <p className="text-xs text-muted-foreground">{LINK_COPY.unreadable}</p>
        {progress}
      </div>
    );
  }

  const link = view.state.walletLinks.find((entry) => entry.wallet === address);
  // A wallet the read did not ask about (Privy's record does not list it yet): nothing may be
  // claimed about its link, and nothing may be offered from an unknown state — but the row says so.
  if (link === undefined) {
    return (
      <div className="space-y-2" data-link="unread">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">{CREATE_LINK_COPY.notReadYet}</p>
          <Button type="button" size="xs" variant="ghost" disabled={write.running} onClick={() => screen.refresh()}>
            <RefreshCw aria-hidden />
            {CREATE_LINK_COPY.check}
          </Button>
        </div>
        {progress}
      </div>
    );
  }

  if (link.status === "this_vault") {
    const explorer = solscanAccount(link.link);
    return (
      <div className="space-y-2" data-link="this_vault">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{LINK_COPY.linked}</Badge>
          {explorer !== null ? (
            <a href={explorer} target="_blank" rel="noreferrer" className="text-xs underline underline-offset-4">
              {LINK_COPY.viewLink}
            </a>
          ) : null}
        </div>
        {progress}
      </div>
    );
  }

  if (link.status === "other_vault" || link.status === "unreadable") {
    return (
      <div className="space-y-2" data-link={link.status}>
        <p className="text-xs text-muted-foreground">{link.status === "other_vault" ? LINK_COPY.otherVault : LINK_COPY.unreadable}</p>
        {progress}
      </div>
    );
  }

  const blocker = linkGate(view.state)?.message ?? (write.busyElsewhere ? LINK_COPY.busy : null);
  const disabled = blocker !== null || write.running || write.unconfirmed;
  const linkRent = rawFrom(view.state.rents?.link);

  return (
    <div className="space-y-2" data-link="missing">
      {seat !== "has-signer" ? <p className="text-xs text-muted-foreground">{LINK_COPY.noSigner}</p> : null}
      {open && blocker === null ? (
        <div className="space-y-2 rounded-md border px-3 py-2">
          <p className="text-xs">{LINK_COPY.panel(linkRent === null ? "some" : formatSol(linkRent))}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={disabled} aria-busy={write.running} onClick={() => void write.link(address)}>
              {LINK_COPY.linkThis}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={write.running} onClick={() => setOpen(false)}>
              {LINK_COPY.cancel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
            {LINK_COPY.link}
          </Button>
          {blocker !== null ? <p className="text-xs text-muted-foreground">{blocker}</p> : null}
        </div>
      )}
      {progress}
    </div>
  );
}
