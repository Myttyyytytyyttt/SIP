"use client";

/**
 * THE TRADING WALLETS: every Privy embedded Solana wallet on this account, and
 * the control that makes another.
 *
 * THE LIST IS PRIVY'S RECORD OF THE USER, read on every render (tradingWalletsOf).
 * One exception: a wallet createWallet has just reported that the record does not
 * list yet is shown as such, rather than vanishing between the create and Privy's
 * refresh. Each row reads what Privy records of its signer (TradingWalletRow).
 *
 * A REFUSAL IS VISIBLE. With the keeper's seat not configured the create button is
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
import { useCreateTradingWallet } from "@/hooks/use-create-trading-wallet";
import { MAX_TRADING_WALLETS, keeperSigners, seatProblem, tradingWalletsOf } from "@/lib/trading-wallets";

export function TradingWalletsCard() {
  const config = useSolanaConfig();
  const { user } = usePrivy();
  const { create, busy, failure, created } = useCreateTradingWallet(config);

  const rows = useMemo<TradingWalletRowData[]>(() => {
    const listed = tradingWalletsOf(user).map((wallet) => ({ ...wallet, listed: true }));
    if (created === null || listed.some((row) => row.address === created)) return listed;
    return [...listed, { address: created, id: null, walletIndex: null, imported: false, listed: false }];
  }, [user, created]);

  const problem = seatProblem(config);
  const seat = keeperSigners(config)?.[0] ?? null;
  const full = rows.length >= MAX_TRADING_WALLETS;

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
            disabled={busy || problem !== null || full}
            aria-busy={busy}
            // An explicit call: Privy's createWallet drops an argument that looks like a click event, and the wallet would be born without its seat.
            onClick={() => void create()}
          >
            {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : <Plus aria-hidden />}
            {busy ? "Creating…" : "Create wallet"}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-3">
        {problem !== null ? (
          <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {problem}
          </p>
        ) : null}
        {failure !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        {full && problem === null ? (
          <p className="text-xs text-muted-foreground">
            This page creates at most <Num>{MAX_TRADING_WALLETS}</Num> trading wallets for one account.
          </p>
        ) : null}

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
