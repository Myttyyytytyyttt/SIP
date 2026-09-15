"use client";

/**
 * ONE TRADING WALLET: its address, what Privy records of its signers, and what can
 * be done about each — grant a missing seat, re-read an unknown one, export the key.
 *
 * WHAT THE BADGE CAN KNOW. Privy's browser SDK says whether a wallet has a signer
 * (`delegated`), never which signer or which policy. So the badge says "Has a
 * signer" and never "Seated": another key quorum, the keeper's signer without its
 * policy, or a legacy on-device delegation all look exactly like the keeper's seat
 * in Privy's record. This page never adds a signer without its policy, but the
 * Privy dashboard, an earlier build or another client of the same Privy app can.
 * The row prints the command that reads the binding itself, `privy-policy verify`,
 * with this wallet's Privy id and the keeper's policy id.
 *
 * A WRONG SIGNER IS THE WALLET OWNER'S TO FIX: Privy's removeSigners, which removes
 * every signer on the wallet, then the grant. This page does not offer the removal.
 *
 * THE GRANT IS OFFERED ONLY FOR "missing". Privy's addSigners appends, so a grant
 * on a wallet that already has a signer could seat the keeper twice. An unknown seat
 * gets a re-read instead.
 */

import { KeyRound, LoaderCircle, RefreshCw } from "lucide-react";

import { useSolanaConfig } from "@/app/providers";
import { Num } from "@/components/num";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AddressLine } from "@/components/wallets/AddressLine";
import { useExportTradingWallet } from "@/hooks/use-export-trading-wallet";
import { useKeeperSeat } from "@/hooks/use-keeper-seat";
import { LABEL } from "@/lib/classes";
import { keeperSigners, seatProblem, type SeatStatus, type TradingWallet } from "@/lib/trading-wallets";

export interface TradingWalletRowData extends TradingWallet {
  /** False only for a wallet createWallet reported that Privy's record does not list yet. */
  readonly listed: boolean;
}

const SEAT: Record<SeatStatus, { readonly badge: string; readonly variant: "outline" | "destructive" | "secondary"; readonly note: string }> = {
  "has-signer": {
    badge: "Has a signer",
    variant: "outline",
    note: "Privy records a signer on this wallet, but not whose it is or which policy bounds it.",
  },
  missing: {
    badge: "No seat",
    variant: "destructive",
    note: "Privy records no signer on this wallet, so nothing can be put aside from it.",
  },
  unknown: {
    badge: "Seat unknown",
    variant: "secondary",
    note: "Privy's record does not list this wallet yet, so its seat cannot be read.",
  },
};

export function TradingWalletRow({ row }: { row: TradingWalletRowData }) {
  const config = useSolanaConfig();
  const keeper = useKeeperSeat(row.address, config);
  const exporter = useExportTradingWallet(row.address);
  const seat = SEAT[keeper.seat];
  const refused = seatProblem(config) !== null;
  // One string, so the command renders as one piece of text.
  const verify = `privy-policy verify --wallet ${row.id ?? "<Privy wallet id>"} --policy ${keeperSigners(config)?.[0]?.policyIds[0] ?? "<policy id>"}`;

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0" data-seat={keeper.seat}>
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
        <Badge variant={seat.variant}>{seat.badge}</Badge>
      </div>

      <AddressLine address={row.address} />

      {row.id !== null ? (
        <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
          <span>Privy wallet id</span>
          <Num className="break-all">{row.id}</Num>
        </div>
      ) : null}

      <p className="text-xs text-muted-foreground">{seat.note}</p>
      {keeper.seat === "has-signer" ? (
        <p className="text-xs text-muted-foreground">
          To confirm it is the keeper&apos;s signer, bounded by its policy, run <Num className="break-all">{verify}</Num>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {keeper.seat === "missing" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={keeper.busy !== null || refused}
            aria-busy={keeper.busy === "granting"}
            onClick={() => void keeper.grant()}
          >
            {keeper.busy === "granting" ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
            {keeper.busy === "granting" ? "Granting…" : "Grant keeper permission"}
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
    </li>
  );
}
