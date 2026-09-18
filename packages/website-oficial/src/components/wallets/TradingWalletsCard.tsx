"use client";

/**
 * THE TRADING WALLETS: every Privy embedded Solana wallet on this account, and
 * the one control that makes another and links it.
 *
 * ONE PRESS, END TO END. "Create wallet and link it" creates the wallet inside
 * Privy with the keeper's seat and goes straight on to the link: the trading
 * wallet's consent, Phantom's approval, the co-signature, the send. The card says
 * all of that BEFORE the press, because Phantom's window opens partway through,
 * long after the click, and an unannounced signature request is not acceptable.
 * The chain is src/lib/create-and-link.ts; each step shows in TxProgress.
 *
 * THE LIST IS PRIVY'S RECORD OF THE USER, read on every render (tradingWalletsOf).
 * One exception: a wallet createWallet has just reported that the record does not
 * list yet is shown as such, rather than vanishing between the create and Privy's
 * refresh. Each row reads what Privy records of its signer (TradingWalletRow).
 *
 * A STOP AFTER THE CREATE IS NOT A FAILURE OF THE CREATE. Once Privy answers, the
 * wallet is real whatever happens next, so the card says so in the same breath as
 * what stopped, and the wallet's own row carries Link to vault. What the card
 * never claims is the seat: it was asked for at creation, and only the row's
 * badge reads Privy's record — which can say a signer exists, never whose.
 *
 * A READ THAT FAILED IS NOT A READ IN FLIGHT. While the chain is still being read
 * the whole press is offered — the flow reads it again after the create. Once the
 * read has FAILED, the button says "Create wallet" and the card says the read's
 * own words: promising a link, a Phantom prompt and rent that the flow will not
 * reach is worse than offering less.
 *
 * NO VAULT, NO SILENT VAULT. Linking needs a vault, and a vault costs rent that
 * never comes back and carries a mode and limits the owner chooses. With none,
 * the press still creates the wallet and the card says the vault comes first,
 * with the way to it.
 *
 * A REFUSAL IS VISIBLE. With the keeper's seat not configured the button is
 * disabled and the card names the missing variables: a trading wallet without the
 * seat cannot put anything aside, and a signer without its policy would be
 * unbounded (src/lib/trading-wallets.ts).
 */

import { usePrivy } from "@privy-io/react-auth";
import { LoaderCircle, Plus } from "lucide-react";
import { useMemo } from "react";

import { useSolanaConfig } from "@/app/providers";
import { Num } from "@/components/num";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { TradingWalletRow, type TradingWalletRowData } from "@/components/wallets/TradingWalletRow";
import { TxProgress } from "@/components/wallets/TxProgress";
import { VAULT_CARD_ID } from "@/components/wallets/VaultScreen";
import { useCreateAndLink } from "@/hooks/use-create-and-link";
import { useVaultScreen } from "@/hooks/use-vault-state";
import { formatSol, rawFrom } from "@/lib/amounts";
import { pressPlan, type CreateAndLinkOutcome } from "@/lib/create-and-link";
import { MAX_TRADING_WALLETS, keeperSigners, seatProblem, tradingWalletsOf } from "@/lib/trading-wallets";
import { CREATE_LINK_COPY, LINK_COPY } from "@/lib/vault-copy";

export function TradingWalletsCard() {
  const config = useSolanaConfig();
  const { user } = usePrivy();
  const screen = useVaultScreen();
  const { run, created, outcome, write } = useCreateAndLink(config);

  const rows = useMemo<TradingWalletRowData[]>(() => {
    const listed = tradingWalletsOf(user).map((wallet) => ({ ...wallet, listed: true }));
    if (created === null || listed.some((row) => row.address === created)) return listed;
    return [...listed, { address: created, id: null, walletIndex: null, imported: false, listed: false }];
  }, [user, created]);

  const problem = seatProblem(config);
  const seat = keeperSigners(config)?.[0] ?? null;
  const full = rows.length >= MAX_TRADING_WALLETS;

  const view = screen?.view ?? null;
  const state = view !== null && view.kind === "ready" ? view.state : null;
  const vaultRent = state === null ? null : rawFrom(state.rents?.vault);
  // What the press will do, in one sentence, before it is pressed: Phantom's window comes late, and never
  // unannounced — and a read that FAILED promises the create alone, since that is all the flow will do.
  const plan = pressPlan(view);
  const ahead = plan.links ? CREATE_LINK_COPY.ahead(plan.linkRent === null ? null : formatSol(plan.linkRent)) : `${CREATE_LINK_COPY.aheadCreateOnly} ${plan.reason}`;
  const busy = write.running;
  // A link this screen sent and cannot confirm blocks the chained press too, wherever it was sent from:
  // a second link transaction while the first may still land is exactly what the screen promises not to offer.
  const blocked = busy || write.busyElsewhere || write.unconfirmed || write.awaitingAnyLink;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trading wallets</CardTitle>
        <CardDescription>
          The wallets you trade from. Each is created inside Privy with the keeper&apos;s seat: its permission to put a
          slice of your trading aside, bounded by the keeper&apos;s policy. Export a wallet&apos;s key to trade from Axiom
          or any Solana app; the seat stays.
        </CardDescription>
        <CardAction>
          <Button
            type="button"
            size="sm"
            disabled={blocked || problem !== null || full}
            aria-busy={busy}
            // An explicit call: Privy's createWallet drops an argument that looks like a click event, and the wallet would be born without its seat.
            onClick={() => void run()}
          >
            {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
            {busy ? CREATE_LINK_COPY.running : plan.links ? CREATE_LINK_COPY.button : CREATE_LINK_COPY.buttonCreateOnly}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        {problem !== null ? (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {problem}
          </p>
        ) : null}
        {problem === null && !full ? <p className="text-xs text-muted-foreground">{ahead}</p> : null}
        {write.busyElsewhere ? <p className="text-xs text-muted-foreground">{LINK_COPY.busy}</p> : null}
        {write.awaitingAnyLink && !write.unconfirmed ? <p className="text-xs text-muted-foreground">{CREATE_LINK_COPY.linkAwaiting}</p> : null}
        {full && problem === null ? (
          <p className="text-xs text-muted-foreground">
            This page creates at most <Num>{MAX_TRADING_WALLETS}</Num> trading wallets for one account.
          </p>
        ) : null}

        <TxProgress
          progress={write.progress}
          successLabel={CREATE_LINK_COPY.done}
          onBuildAgain={() => void write.buildAgain()}
          onCheckAgain={() => void write.checkAgain()}
          onDismiss={() => write.dismiss()}
        />
        {outcome !== null ? <CreateAndLinkNote outcome={outcome} vaultRent={vaultRent} /> : null}

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No trading wallets yet. Create one, then export its key to trade from Axiom or any Solana app.
          </p>
        ) : (
          <ul className="divide-y">
            {rows.map((row) => (
              <TradingWalletRow key={row.address} row={row} />
            ))}
          </ul>
        )}
      </CardContent>

      {seat !== null ? (
        <CardFooter className="flex-wrap gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <span>New wallets seat the keeper&apos;s signer</span>
          <Num className="break-all">{seat.signerId}</Num>
          <span>with policy</span>
          <Num className="break-all">{seat.policyIds[0]}</Num>
        </CardFooter>
      ) : null}
    </Card>
  );
}

/**
 * What the press ended in, in the card's own words.
 *
 * NOTHING IS SAID WHEN PRIVY'S DIALOG WAS SIMPLY CLOSED (message null): that is a
 * choice, not a failure, and nothing was created.
 *
 * WHENEVER A WALLET WAS CREATED, that comes first and in full — the wallet is
 * real and in the list, with its seat shown there as Privy records it — and the
 * reason the chain stopped comes after it. A link that ran and stopped has its own
 * words in TxProgress already; this only adds that the wallet is there.
 */
export function CreateAndLinkNote({ outcome, vaultRent }: { readonly outcome: CreateAndLinkOutcome; readonly vaultRent: bigint | null }) {
  const { stop, created, link } = outcome;
  if (stop === null) {
    if (link === null || link.ok) return null;
    return (
      <p role="status" data-outcome="link-stopped" className="text-xs text-muted-foreground">
        {CREATE_LINK_COPY.created} {CREATE_LINK_COPY.inTheList}
      </p>
    );
  }
  if (stop.message === null) return null;

  const needsVault = stop.gate === "needs_vault";
  return (
    <div role="alert" data-outcome={stop.kind} className="space-y-2 rounded-md border px-3 py-2 text-xs">
      {created !== null ? (
        <p>
          {CREATE_LINK_COPY.created} {CREATE_LINK_COPY.inTheList}
        </p>
      ) : null}
      {needsVault ? <p className="font-medium">{CREATE_LINK_COPY.needsVaultTitle}</p> : null}
      <p className="text-muted-foreground">{needsVault ? CREATE_LINK_COPY.needsVault(vaultRent === null ? null : formatSol(vaultRent)) : stop.message}</p>
      {needsVault ? (
        <Button type="button" size="sm" variant="outline" asChild>
          <a href={`#${VAULT_CARD_ID}`}>{CREATE_LINK_COPY.goToVault}</a>
        </Button>
      ) : null}
    </div>
  );
}
