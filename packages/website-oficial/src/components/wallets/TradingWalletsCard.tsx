"use client";

/**
 * THE TRADING WALLETS: every Privy embedded Solana wallet on this account, the
 * control that makes another and links it, and the one that imports a wallet
 * the person already uses and links it (ImportWalletPanel, owner 10-08).
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
 *
 * TEN WALLETS, CREATED OR IMPORTED (owner 10-08). Both buttons stop at
 * MAX_TRADING_WALLETS, and the import's preflight refuses at it too: the screen's
 * chain read asks about that many wallets, and one past it would never be read.
 */

import { usePrivy } from "@privy-io/react-auth";
import { Import, LoaderCircle, Plus } from "lucide-react";
import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { useSolanaConfig } from "@/app/providers";
import { Num } from "@/components/num";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { ImportAndLinkNote, ImportWalletPanel } from "@/components/wallets/ImportWalletPanel";
import { TradingWalletRow, type TradingWalletRowData } from "@/components/wallets/TradingWalletRow";
import { TxProgress, useStepStartedAt } from "@/components/wallets/TxProgress";
import { VAULT_CARD_ID } from "@/components/wallets/VaultScreen";
import { WalletsSectionContext } from "@/components/wallets/wallets-section-context";
import { useCreateAndLink } from "@/hooks/use-create-and-link";
import { useImportAndLink } from "@/hooks/use-import-and-link";
import { useVaultScreen } from "@/hooks/use-vault-state";
import { formatSol, rawFrom } from "@/lib/amounts";
import { pressPlan, stopStillHolds, type CreateAndLinkOutcome } from "@/lib/create-and-link";
import { importRequested, subscribeImportRequest, takeImportRequest } from "@/lib/import-intent";
import { MAX_TRADING_WALLETS, ROW_COPY, createRefusal, keeperSigners, seatProblem, tradingWalletsOf } from "@/lib/trading-wallets";
import { tradingWalletLabels } from "@/lib/wallet-labels";
import { CREATE_LINK_COPY, IMPORT_LINK_COPY, LINK_COPY, VAULT_COPY } from "@/lib/vault-copy";

/** The card's own words for a first look; the ids behind them stay under Advanced. */
const CARD_COPY = {
  /**
   * The seat's reach as its POLICY sets it, not as the keeper uses it: transactions made only of SaverFi's program
   * and Ed25519 signature checks. This said "bounded to moving SOL into your vault", which is what the keeper's code
   * does, not what the policy limits.
   */
  description:
    "The wallets you trade from, created here or imported from a wallet you already use. SaverFi's permission on " +
    "them lets its keeper send only transactions made of SaverFi's program and signature checks; each saving's " +
    "small network fee is paid from the wallet. Export a wallet's key to trade from Axiom or any Solana app.",
  advanced: ROW_COPY.advanced,
} as const;

export function TradingWalletsCard() {
  const showSection = useContext(WalletsSectionContext);
  const config = useSolanaConfig();
  const { user } = usePrivy();
  const screen = useVaultScreen();
  const { run, created, outcome, dismiss, write } = useCreateAndLink(config);
  const importer = useImportAndLink(config);
  const createStartedAt = useStepStartedAt(write.progress);
  const importStartedAt = useStepStartedAt(importer.write.progress);
  const [importing, setImporting] = useState(false);
  // The live next-step card's "Import a wallet I already use" opens this tab; the panel opens with it.
  const importAsked = useSyncExternalStore(subscribeImportRequest, importRequested, () => false);
  useEffect(() => {
    if (importAsked && takeImportRequest()) setImporting(true);
  }, [importAsked]);

  const rows = useMemo<TradingWalletRowData[]>(() => {
    const wallets = tradingWalletsOf(user);
    const known = (address: string | null): address is string => address !== null && !wallets.some((wallet) => wallet.address === address);
    // An imported wallet Privy's record does not list yet is named with the rest, so it can never share a name.
    const pendingImport = known(importer.imported) ? importer.imported : null;
    // The same names as the live dashboard's (src/lib/wallet-labels.ts), from Privy's own list.
    const labels = tradingWalletLabels([...wallets, ...(pendingImport === null ? [] : [{ address: pendingImport, imported: true }])]);
    const listed: TradingWalletRowData[] = wallets.map((wallet) => ({ ...wallet, listed: true, label: labels.get(wallet.address) ?? wallet.address }));
    if (known(created)) listed.push({ address: created, id: null, walletIndex: null, imported: false, listed: false, label: "New trading wallet" });
    if (pendingImport !== null) {
      listed.push({ address: pendingImport, id: null, walletIndex: null, imported: true, listed: false, label: labels.get(pendingImport) ?? "Imported wallet" });
    }
    return listed;
  }, [user, created, importer.imported]);
  // An account whose only Privy wallets are imported: Privy refuses to create one more (createRefusal).
  const cannotCreate = createRefusal(user);

  const problem = seatProblem(config);
  const seat = keeperSigners(config)?.[0] ?? null;
  const full = rows.length >= MAX_TRADING_WALLETS;

  const view = screen?.view ?? null;
  const state = view !== null && view.kind === "ready" ? view.state : null;
  const vaultRent = state === null ? null : rawFrom(state.rents?.vault);
  // What the press will do, in one sentence, before it is pressed: Phantom's window comes late, and never
  // unannounced — and a read that FAILED promises the create alone, since that is all the flow will do.
  const plan = pressPlan(view);
  // A stop that describes the chain is re-read against the chain as it is NOW: the owner follows
  // "Create your vault first", creates it, and the note that asked for it must go, not sit there
  // asserting under a button that has just started offering the link.
  const note = outcome !== null && stopStillHolds(outcome.stop, state) ? outcome : null;
  const importNote = importer.outcome !== null && stopStillHolds(importer.outcome.stop, state) ? importer.outcome : null;
  const ahead = plan.links ? CREATE_LINK_COPY.ahead(plan.linkRent === null ? null : formatSol(plan.linkRent)) : `${CREATE_LINK_COPY.aheadCreateOnly} ${plan.reason}`;
  const busy = write.running;
  // A link this screen sent and cannot confirm blocks the chained press too, wherever it was sent from:
  // a second link transaction while the first may still land is exactly what the screen promises not to offer.
  const blocked = busy || write.busyElsewhere || write.unconfirmed || write.awaitingAnyLink || importer.write.unconfirmed;
  const importBlocked = importer.write.running || importer.write.busyElsewhere || importer.write.unconfirmed || importer.write.awaitingAnyLink || write.unconfirmed;

  return (
    <Card>
      <CardHeader>
        {/* Column 1 explicitly: with the action moved to a row of its own, the header's second cell in row 1
            is free, and the grid's own placement would put the description up there beside the title. */}
        <CardTitle className="col-start-1">Trading wallets</CardTitle>
        <CardDescription className="col-start-1">{CARD_COPY.description}</CardDescription>
        {/*
         * THE ACTION DROPS BELOW THE DESCRIPTION ON A NARROW CARD. CardHeader is a
         * grid-cols-[1fr_auto] with the action in column 2, and every Button is
         * whitespace-nowrap: "Create wallet and link it" is 163px against the ~110px
         * of the "Create wallet" it replaced, and column 1 gives way rather than the
         * button. In the Manage wallets modal on a phone that left the description
         * 89px wide and 340px tall at 320px, 144px and 220px at 375px — measured on
         * this markup over the built CSS. Below a 28rem header the action takes a row
         * of its own, full width; from there up it is the top-right action it has
         * always been, and 768px is unchanged.
         */}
        <CardAction className="col-start-1 row-span-1 row-start-3 justify-self-stretch pt-1 @md/card-header:col-start-2 @md/card-header:row-span-2 @md/card-header:row-start-1 @md/card-header:justify-self-end @md/card-header:pt-0">
          <Button
            type="button"
            size="sm"
            className="w-full @md/card-header:w-auto"
            disabled={blocked || problem !== null || full || cannotCreate !== null}
            aria-busy={busy}
            // An explicit call: Privy's createWallet drops an argument that looks like a click event, and the wallet would be born without its seat.
            onClick={() => void run()}
          >
            {busy ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <Plus aria-hidden />}
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
        {/* The create's own promise steps aside while the import panel says its own, and gives way to why it cannot be kept. */}
        {problem === null && !full && !importing && cannotCreate === null ? <p className="text-xs text-muted-foreground">{ahead}</p> : null}
        {/* Kept while the import panel is open too: Create stays disabled there, and must say why. */}
        {problem === null && !full && cannotCreate !== null ? (
          <p data-create-refused="" className="text-xs text-muted-foreground">
            {cannotCreate}
          </p>
        ) : null}
        {problem === null && !full && !importing ? (
          <Button type="button" size="sm" variant="outline" disabled={importBlocked} aria-busy={importer.write.running} onClick={() => setImporting(true)}>
            {importer.write.running ? <LoaderCircle className="motion-safe:animate-spin" aria-hidden /> : <Import aria-hidden />}
            {importer.write.running ? IMPORT_LINK_COPY.running : IMPORT_LINK_COPY.button}
          </Button>
        ) : null}
        {importing && problem === null && !full ? (
          <ImportWalletPanel
            disabled={importBlocked}
            onImport={(request) => void importer.run(request)}
            onClose={() => setImporting(false)}
          />
        ) : null}
        {write.busyElsewhere ? <p className="text-xs text-muted-foreground">{LINK_COPY.busy}</p> : null}
        {write.awaitingAnyLink && !write.unconfirmed ? <p className="text-xs text-muted-foreground">{CREATE_LINK_COPY.linkAwaiting}</p> : null}
        {full && problem === null ? (
          <p className="text-xs text-muted-foreground">
            This page keeps at most <Num>{MAX_TRADING_WALLETS}</Num> trading wallets for one account, created or imported.
          </p>
        ) : null}

        <TxProgress
          progress={write.progress}
          successLabel={CREATE_LINK_COPY.done}
          startedAt={createStartedAt}
          onBuildAgain={() => void write.buildAgain()}
          onCheckAgain={() => void write.checkAgain()}
          // The note beside a stopped link says the wallet is safe; dismissing the one dismisses the other.
          onDismiss={() => {
            write.dismiss();
            dismiss();
          }}
        />
        {note !== null ? <CreateAndLinkNote outcome={note} vaultRent={vaultRent} onDismiss={dismiss} /> : null}

        <TxProgress
          progress={importer.write.progress}
          successLabel={IMPORT_LINK_COPY.done}
          startedAt={importStartedAt}
          onBuildAgain={() => void importer.write.buildAgain()}
          onCheckAgain={() => void importer.write.checkAgain()}
          onDismiss={() => {
            importer.write.dismiss();
            importer.dismiss();
          }}
        />
        {importNote !== null ? (
          <ImportAndLinkNote
            outcome={importNote}
            vaultRent={vaultRent}
            onGoToVault={showSection === null ? null : () => showSection("vault")}
            onDismiss={importer.dismiss}
          />
        ) : null}

        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No trading wallets yet. Create one and export its key to trade from Axiom or any Solana app, or import a wallet you already use.
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
        <CardFooter className="text-xs text-muted-foreground">
          {/* The operator's ids, folded away from a first look like each row's. */}
          <details className="w-full">
            <summary className="cursor-pointer">{CARD_COPY.advanced}</summary>
            <div className="mt-2 flex flex-wrap gap-x-1.5 gap-y-1">
              <span>New wallets seat the keeper&apos;s signer</span>
              <Num className="break-all">{seat.signerId}</Num>
              <span>with policy</span>
              <Num className="break-all">{seat.policyIds[0]}</Num>
            </div>
          </details>
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
 *
 * IT IS DISMISSIBLE, and the card drops it on its own once a stop that described
 * the chain no longer does (stopStillHolds): nothing here outlives what it says.
 *
 * THE WAY TO THE VAULT IS A TAB SWITCH inside the tabbed wallets screen: the
 * vault card sits in another panel there, hidden, and an anchor to it would go
 * nowhere (and seat-activity cancels every link click while a re-seat runs).
 * Rendered on its own, with no tabs around it, it is still the anchor.
 */
export function CreateAndLinkNote({
  outcome,
  vaultRent,
  onDismiss,
}: {
  readonly outcome: CreateAndLinkOutcome;
  readonly vaultRent: bigint | null;
  readonly onDismiss?: () => void;
}) {
  const showSection = useContext(WalletsSectionContext);
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
      <div className="flex flex-wrap gap-2">
        {needsVault ? (
          showSection !== null ? (
            <Button type="button" size="sm" variant="outline" onClick={() => showSection("vault")}>
              {CREATE_LINK_COPY.goToVault}
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" asChild>
              <a href={`#${VAULT_CARD_ID}`}>{CREATE_LINK_COPY.goToVault}</a>
            </Button>
          )
        ) : null}
        {onDismiss !== undefined ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => onDismiss()}>
            {VAULT_COPY.dismiss}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
