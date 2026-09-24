"use client";

/**
 * ONE TRADING WALLET: its address, what Privy records of its signers, and what can
 * be done about each — grant a missing seat, re-seat one that has a signer, re-read
 * an unknown one, export the key — and whether it saves into the vault (LinkControl).
 *
 * WHAT THE BADGE CAN KNOW. Privy's browser SDK says whether a wallet has a signer
 * (`delegated`), never which signer or which policy. So the row says "Linked" (a
 * signer, and a link) and never "Seated" or "can save": another key quorum, the keeper's signer without its
 * policy, or a legacy on-device delegation all look exactly like the keeper's seat
 * in Privy's record. This page never adds a signer without its policy, but the
 * Privy dashboard, an earlier build or another client of the same Privy app can.
 * The row prints the command that reads the binding itself, `privy-policy verify`,
 * with this wallet's Privy id and the keeper's policy id.
 *
 * A WRONG SIGNER IS THE WALLET OWNER'S TO FIX, and RE-SEAT is how: Privy's
 * removeSigners, which removes every signer on the wallet, then the grant
 * (reseatKeeperSeat). The commonest wrong signer is the keeper's own from before a
 * key rotation: the seat names the signer by id, so a new key leaves every wallet
 * seated before it with a signer nobody can use, and the badge cannot tell.
 *
 * RE-SEAT IS OFFERED ON EVERY "has-signer" ROW, BEHIND A PLAIN CONFIRMATION. Only
 * Privy's API can say which signer a wallet carries, and it needs the app secret,
 * which this web does not hold and refuses by name (src/lib/load-config.ts). So
 * the page cannot offer it only where the seat is wrong. The first press only asks;
 * the confirmation says it removes EVERY signer on this wallet, names what goes
 * back, and what the wallet is if the second step fails. A wallet Privy would not
 * remove per wallet (reseatRefusal) gets the button disabled, with the reason.
 *
 * THE PARTIAL STATE. A re-seat stopped after the removal leaves a wallet whose
 * record says no signer: the row reads "Needs permission", in red, and offers Grant SaverFi
 * permission — one press — on this render and after any reload, as long as Privy's
 * record still shows the wallet's server id. If it does not, the grant cannot reach
 * the wallet (grantRefusal): the button is disabled with the reason, and the stop's
 * own message ("id-dropped") says what happened. A stop is never shown as done.
 *
 * THE GRANT IS OFFERED ONLY FOR "missing". Privy's addSigners appends, so a grant
 * on a wallet that already has a signer could seat the keeper twice. An unknown seat
 * gets a re-read instead. For the same reason it is held back for a minute after an
 * add Privy accepted (GRANT_HOLD_MS): its record can lag behind the seat.
 *
 * THE LINK is the chain's record, read by the screen, not Privy's: a wallet can be
 * linked with or without a seat, and a seat puts nothing aside until it is linked.
 *
 * WHAT A NEW USER SEES, AND WHAT IS UNDER "ADVANCED" (09-24). The row leads with
 * one plain status — Ready, Not linked, Needs permission, Checking — built from
 * the seat and the link together, and only the controls that move it forward:
 * Grant, Link, Check again, Export key. The operator's tools — the Privy wallet
 * id, the privy-policy verify line, the signer's own note and Re-seat — sit in a
 * collapsed "Advanced" section: nothing is removed, because Re-seat is how a
 * wallet seated under a rotated key is recovered, but none of it reads like a
 * warning to someone who has just created their first wallet. The section opens
 * by itself while a re-seat is being confirmed or runs, so its progress is
 * never hidden.
 */

import { KeyRound, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useVaultScreen } from "@/hooks/use-vault-state";

import { useSolanaConfig } from "@/app/providers";
import { Num } from "@/components/num";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AddressLine } from "@/components/wallets/AddressLine";
import { LinkControl } from "@/components/wallets/LinkControl";
import { useExportTradingWallet } from "@/hooks/use-export-trading-wallet";
import { useKeeperSeat } from "@/hooks/use-keeper-seat";
import { LABEL } from "@/lib/classes";
import { GRANT_COPY, RESEAT_COPY, ROW_COPY, keeperSigners, seatProblem, type SeatStatus, type TradingWallet } from "@/lib/trading-wallets";

export interface TradingWalletRowData extends TradingWallet {
  /** False only for a wallet createWallet reported that Privy's record does not list yet. */
  readonly listed: boolean;
}

/** The seat as Privy records it, in the operator's own words: shown under Advanced. */
const SEAT_NOTE: Record<SeatStatus, string> = {
  "has-signer":
    "Privy records a signer on this wallet, but not whose it is or which policy bounds it. If the keeper's key has " +
    "been replaced since this wallet got its signer, the signer here is the old one: re-seat it.",
  missing: "Privy records no signer on this wallet, so nothing can be put aside from it.",
  unknown: "Privy's record does not list this wallet yet, so its seat cannot be read.",
};

/** What the chain read says of this wallet's link, as the row's status needs it: "unknown" makes no claim either way. */
export type RowLink = "this_vault" | "missing" | "other_vault" | "unknown";

/** The one status a person reads first: the seat, the link and the pause together. */
export type RowStatus = "linked" | "not-linked" | "elsewhere" | "paused" | "needs-permission" | "checking";

/**
 * NOTHING HERE CLAIMS MORE THAN THE READS SAY. Privy's record proves a signer
 * exists, never whose, so a linked wallet with one is "Linked", never "can save".
 * A link the chain read has not answered — loading, unreadable, not asked about
 * yet — is "Checking", never "Not linked". And a pause, of SaverFi or of the
 * vault, stops every settlement, so a linked wallet then says so.
 */
export function rowStatus(seat: SeatStatus, link: RowLink, paused: boolean): RowStatus {
  if (seat === "missing") return "needs-permission";
  if (seat === "unknown" || link === "unknown") return "checking";
  if (link === "other_vault") return "elsewhere";
  if (link === "missing") return "not-linked";
  return paused ? "paused" : "linked";
}

const STATUS: Record<RowStatus, { readonly badge: string; readonly variant: "outline" | "destructive" | "secondary"; readonly note: string | null; readonly className?: string }> = {
  linked: { badge: ROW_COPY.linked, variant: "outline", note: ROW_COPY.linkedNote, className: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400" },
  "not-linked": { badge: ROW_COPY.notLinked, variant: "outline", note: null },
  elsewhere: { badge: ROW_COPY.elsewhere, variant: "secondary", note: null },
  paused: { badge: ROW_COPY.paused, variant: "secondary", note: ROW_COPY.pausedNote },
  "needs-permission": { badge: ROW_COPY.needsPermission, variant: "destructive", note: ROW_COPY.needsPermissionNote },
  checking: { badge: ROW_COPY.checking, variant: "secondary", note: null },
};

export function TradingWalletRow({ row }: { row: TradingWalletRowData }) {
  const config = useSolanaConfig();
  const keeper = useKeeperSeat(row.address, config);
  const exporter = useExportTradingWallet(row.address);
  const screen = useVaultScreen();
  const chain = screen?.view.kind === "ready" ? screen.view.state : null;
  const entry = chain?.walletLinks.find((link) => link.wallet === row.address);
  const link: RowLink = entry === undefined || entry.status === "unreadable" ? "unknown" : entry.status;
  const paused = chain?.config.paused === true || chain?.vault.state?.paused === true;
  const statusKey = rowStatus(keeper.seat, link, paused);
  const status = STATUS[statusKey];
  // "Checking" says why: Privy's record, when that is what is missing; the chain read says its own words in the link control.
  const note = statusKey === "checking" && keeper.seat === "unknown" ? ROW_COPY.checkingNote : status.note;
  const refused = seatProblem(config) !== null;
  const keeperSeat = keeperSigners(config)?.[0] ?? null;
  // The re-seat's first press only asks: the confirmation below is what removes anything.
  const [confirming, setConfirming] = useState(false);
  const reseatable = keeper.seat === "has-signer" && row.listed;
  // One string, so the command renders as one piece of text.
  const verify = `privy-policy verify --wallet ${row.id ?? "<Privy wallet id>"} --policy ${keeperSigners(config)?.[0]?.policyIds[0] ?? "<policy id>"}`;

  // The operator's section OPENS by itself while a re-seat is confirmed or runs, and when one stops with a
  // way forward — and never closes by itself: a stop's message names Re-seat keeper, which lives in it.
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const advancedWanted = confirming || keeper.busy === "reseating" || (reseatable && keeper.failure !== null);
  useEffect(() => {
    if (advancedWanted && advancedRef.current !== null) advancedRef.current.open = true;
  }, [advancedWanted]);

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0" data-seat={keeper.seat} data-status={statusKey}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className={LABEL}>
          {row.walletIndex !== null ? (
            <>
              Trading wallet <Num>{row.walletIndex + 1}</Num>
            </>
          ) : row.listed ? (
            "Imported wallet"
          ) : (
            "New trading wallet"
          )}
        </div>
        <Badge variant={status.variant} className={status.className}>
          {status.badge}
        </Badge>
      </div>

      <AddressLine address={row.address} />

      {note !== null ? <p className="text-xs text-muted-foreground">{note}</p> : null}

      <div className="flex flex-wrap items-center gap-2">
        {keeper.seat === "missing" && keeper.busy !== "reseating" ? (
          <Button
            type="button"
            size="sm"
            disabled={keeper.busy !== null || refused || keeper.grantBlocked !== null || keeper.grantHeld}
            aria-busy={keeper.busy === "granting"}
            onClick={() => void keeper.grant()}
          >
            {keeper.busy === "granting" ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
            {keeper.busy === "granting" ? ROW_COPY.granting : ROW_COPY.grant}
          </Button>
        ) : null}
        {keeper.seat === "unknown" ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={keeper.busy !== null}
            aria-busy={keeper.busy === "checking"}
            onClick={() => void keeper.check()}
          >
            <RefreshCw className={keeper.busy === "checking" ? "animate-spin" : undefined} aria-hidden />
            Check again
          </Button>
        ) : null}
        {row.listed ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={exporter.busy}
            aria-busy={exporter.busy}
            // An explicit call: Privy's exportWallet with no address exports the wallet at HD index 0.
            onClick={() => void exporter.run()}
          >
            {exporter.busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <KeyRound aria-hidden />}
            {exporter.busy ? "Privy dialog open…" : "Export key"}
          </Button>
        ) : null}
      </div>

      {keeper.seat === "missing" && keeper.busy !== "reseating" && keeper.grantBlocked !== null && !refused ? (
        // The short form on a first look; Privy's full reason, in the operator's words, under Advanced.
        <p className="text-xs text-muted-foreground">{ROW_COPY.grantBlocked}</p>
      ) : null}
      {keeper.seat === "missing" && keeper.busy === null && keeper.grantHeld && keeper.grantBlocked === null && !refused ? (
        <p className="text-xs text-muted-foreground">{GRANT_COPY.held}</p>
      ) : null}
      {keeper.notice !== null ? (
        <p role="status" className="text-xs text-muted-foreground">
          {keeper.notice}
        </p>
      ) : null}
      {keeper.failure !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {keeper.failure}
        </p>
      ) : null}
      {exporter.failure !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {exporter.failure}
        </p>
      ) : null}

      {/* The link comes after the permission: a seat is what makes a link save anything. */}
      <LinkControl address={row.address} seat={keeper.seat} />

      {/* The operator's tools: all still here, folded away from a first look. */}
      <details ref={advancedRef} className="group rounded-md border px-3 py-1.5 text-xs" data-advanced={advancedWanted ? "wanted" : undefined}>
        <summary className="cursor-pointer text-muted-foreground">{ROW_COPY.advanced}</summary>
        <div className="mt-2 space-y-2 text-muted-foreground">
          {row.id !== null ? (
            <div className="flex flex-wrap items-center gap-x-1.5">
              <span>Privy wallet id</span>
              <Num className="break-all">{row.id}</Num>
            </div>
          ) : null}
          <p>{SEAT_NOTE[keeper.seat]}</p>
          {keeper.seat === "has-signer" ? (
            <p>
              To confirm it is the keeper&apos;s signer, bounded by its policy, run <Num className="break-all">{verify}</Num>
            </p>
          ) : null}

          {/* Kept up for the whole re-seat: the badge turns Needs permission halfway through, and the spinner must not go with it. */}
          {((reseatable && confirming) || keeper.busy === "reseating") && keeperSeat !== null ? (
            <ReseatConfirm
              signerId={keeperSeat.signerId}
              policyId={keeperSeat.policyIds[0] ?? ""}
              busy={keeper.busy === "reseating"}
              disabled={keeper.busy !== null || refused || keeper.reseatBlocked !== null}
              onConfirm={() => {
                void keeper.reseat().finally(() => setConfirming(false));
              }}
              onCancel={() => setConfirming(false)}
            />
          ) : null}
          {reseatable && !confirming ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={keeper.busy !== null || refused || keeper.reseatBlocked !== null}
              onClick={() => setConfirming(true)}
            >
              <RotateCcw aria-hidden />
              {RESEAT_COPY.button}
            </Button>
          ) : null}
          {reseatable && keeper.reseatBlocked !== null && !refused ? <p>{keeper.reseatBlocked}</p> : null}
          {/* Never mid re-seat: "nothing was added… reload" there would send the owner away while the add is in flight. */}
          {keeper.seat === "missing" && keeper.busy !== "reseating" && keeper.grantBlocked !== null && !refused ? <p>{keeper.grantBlocked}</p> : null}
        </div>
      </details>
    </li>
  );
}

/**
 * THE RE-SEAT'S CONFIRMATION, in plain words: it removes EVERY signer on this
 * wallet, what goes back (the ids, so the owner can match them in the Privy
 * dashboard), and what the wallet is if the second step fails. Only its first
 * button calls Privy.
 */
export function ReseatConfirm({
  signerId,
  policyId,
  busy,
  disabled,
  onConfirm,
  onCancel,
}: {
  readonly signerId: string;
  readonly policyId: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <div role="group" aria-label={RESEAT_COPY.confirmTitle} className="space-y-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs">
      <p className="font-medium">{RESEAT_COPY.confirmTitle}</p>
      <p className="text-muted-foreground">{RESEAT_COPY.confirmBody}</p>
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground">
        <span>Signer</span>
        <Num className="break-all">{signerId}</Num>
        <span>with policy</span>
        <Num className="break-all">{policyId}</Num>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="destructive" disabled={disabled} aria-busy={busy} onClick={() => onConfirm()}>
          {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
          {busy ? RESEAT_COPY.running : RESEAT_COPY.confirm}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onCancel()}>
          {RESEAT_COPY.cancel}
        </Button>
      </div>
    </div>
  );
}
