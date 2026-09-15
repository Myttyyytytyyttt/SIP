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
 * Clicking opens an inline panel, never a dialog (Privy's own dialogs open over
 * this screen, which is sometimes itself a dialog), that says what three
 * signatures will do and what they cost.
 */

import { solscanAccount } from "@sip/solana-core/client";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TxProgress } from "@/components/wallets/TxProgress";
import { useVaultWrite } from "@/hooks/use-vault-actions";
import { useVaultScreen } from "@/hooks/use-vault-state";
import { formatSol, rawFrom } from "@/lib/amounts";
import type { SeatStatus } from "@/lib/trading-wallets";
import type { VaultStateJson } from "@/lib/vault-api";
import { LINK_COPY, VAULT_COPY } from "@/lib/vault-copy";

/** Why this pension key cannot link a wallet right now, from the chain; null when it can. */
function chainBlocker(state: VaultStateJson): string | null {
  if (state.vault.status === "missing") return LINK_COPY.needsVault;
  if (state.vault.status === "unreadable") return VAULT_COPY.unreadable;
  if (state.config.status === "missing") return LINK_COPY.needsConfig;
  if (state.config.status === "unreadable") return LINK_COPY.unreadable;
  if (state.config.paused === true) return LINK_COPY.paused;
  return null;
}

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
  // A wallet the read did not ask about (Privy's record does not list it yet): nothing to say about its link.
  if (link === undefined) return null;

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

  const blocker = chainBlocker(view.state) ?? (write.busyElsewhere ? LINK_COPY.busy : null);
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
