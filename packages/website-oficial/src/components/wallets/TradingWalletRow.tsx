"use client";

/**
 * One trading wallet: where it came from, whether the keeper can sign for it,
 * whether the vault knows it, its rate, and what can be done about each.
 *
 * REVOKE IS THE HOLDER'S FIRST. The contract lets the trading wallet leave on
 * its own (`revokeMyTradingAccount`) — it is their pension — so that is the
 * signature asked for whenever Privy holds the wallet AND the wallet can pay
 * for it. It often cannot: a wallet born on this page holds no ETH, and the
 * admin's `revokeTradingAccount` exists for exactly that, paid by the pension
 * key. Without the fallback, leaving required funding a wallet you were done
 * with.
 *
 * Ported from HEAD (fd927b0) src/components/WalletsPanel.tsx (the row) and
 * src/components/TradingWalletSettings.tsx (the named-error discipline).
 */

import type { ConnectedWallet } from "@privy-io/react-auth";
import { ExternalLink, LoaderCircle, Unlink } from "lucide-react";
import { useState } from "react";
import type { Address } from "viem";

import { CopyButton } from "@/components/copy-button";
import { Num } from "@/components/num";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ExportWalletButton } from "@/components/wallets/ExportWalletButton";
import { LinkWalletDialog } from "@/components/wallets/LinkWalletDialog";
import { NEEDS_GAS, RateControl, walletCanPayItsOwnGas } from "@/components/wallets/RateControl";
import { SeatStatus } from "@/components/wallets/SeatStatus";
import type { LinkProbe, WalletRow } from "@/components/wallets/TradingWalletsList";
import { personalVaultAbi } from "@/lib/abi";
import { ROBINHOOD_CHAIN_ID, explorerAddressUrl, robinhoodChain } from "@/lib/chain";
import { LABEL } from "@/lib/classes";
import type { PublicConfig } from "@/lib/config";
import { shortHex } from "@/lib/format";
import { describeError } from "@/lib/wallets/judge";
import { readClient, walletClientFor } from "@/lib/wallets/policy";

const ORIGIN_LABEL = { created: "Created", imported: "Imported", external: "External" } as const;

/**
 * The admin's side of leaving. It is absent from src/lib/abi.ts, which carries
 * the reads and writes WEB_WALLETS.md §3 listed and this was not one of them;
 * the fragment lives beside the only button that sends it.
 */
const adminRevokeAbi = [
  {
    type: "function",
    name: "revokeTradingAccount",
    inputs: [{ name: "account", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/** The link status in one word, from the vault's account or the probe that stands in for it. */
function linkage(row: WalletRow, probe: LinkProbe): { text: string; variant: "outline" | "secondary"; detail?: string } {
  if (row.account !== null) {
    switch (row.account.status) {
      case "ACTIVE":
        return { text: "Active", variant: "outline" };
      case "PAUSED":
        return { text: "Paused", variant: "secondary" };
      case "PENDING":
        return { text: "Pending", variant: "secondary", detail: "Invited; the acceptance has not been signed." };
      case "REVOKED":
        return { text: "Revoked", variant: "secondary" };
    }
  }
  switch (probe.kind) {
    case "checking":
      return { text: "Checking…", variant: "secondary" };
    case "free":
      return { text: "Not linked", variant: "secondary" };
    case "here":
      return { text: "Active", variant: "outline", detail: "Linked here, but missing from the log scan — its rate could not be read." };
    case "elsewhere":
      return { text: "Linked elsewhere", variant: "secondary", detail: `Feeds a different pension: ${shortHex(probe.vault)}.` };
    case "unknown":
      return { text: "Unknown", variant: "secondary", detail: `Could not read the link: ${probe.error}` };
    case "listed":
      // Unreachable: a listed row carries its account and returned above. Said
      // as "Unknown" rather than left for TypeScript to guess.
      return { text: "Unknown", variant: "secondary" };
  }
}

export function TradingWalletRow({
  row,
  probe,
  config,
  admin,
  adminWallet,
  vault,
  onChanged,
}: {
  row: WalletRow;
  probe: LinkProbe;
  config: PublicConfig;
  admin: Address;
  adminWallet: ConnectedWallet | null;
  vault: Address;
  onChanged: () => void;
}) {
  const { address, origin, wallet, held, account } = row;
  const link = linkage(row, probe);
  const explorer = explorerAddressUrl(config.explorerUrl, address);

  const status = account?.status ?? null;
  const canLink = wallet !== null && (status === "PENDING" || status === "REVOKED" || (status === null && probe.kind === "free"));
  // Either signer can end it, so the button is offered whenever one of them is
  // here — the wallet's own revoke is preferred, and `revoke()` decides.
  const canRevoke = (wallet !== null || adminWallet !== null) && (status === "ACTIVE" || status === "PAUSED");

  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * The link dialog is mounted while it is OPEN, not only while linking is
   * still possible. Linking succeeds, `onChanged` refetches, the account turns
   * ACTIVE and `canLink` goes false — which used to unmount the dialog on the
   * very frame it had something to say, so "linked and active" was a state no
   * user ever saw.
   */
  const [linking, setLinking] = useState(false);

  async function revoke() {
    setFailure(null);
    try {
      const chain = robinhoodChain(config.walletRpcUrl, config.explorerUrl);
      const client = readClient(config);

      let holderCanPay = false;
      if (wallet !== null) {
        setBusy("Checking the trading wallet can pay for its own transaction…");
        holderCanPay = await walletCanPayItsOwnGas(client, address);
      }

      let hash: `0x${string}`;
      if (wallet !== null && holderCanPay) {
        setBusy("Switching the trading wallet to Robinhood Chain…");
        await wallet.switchChain(ROBINHOOD_CHAIN_ID).catch(() => undefined);
        const signer = await walletClientFor(wallet, address, chain);
        setBusy("The trading wallet is signing its revoke…");
        hash = await signer.writeContract({
          address: vault,
          abi: personalVaultAbi,
          functionName: "revokeMyTradingAccount",
        });
      } else if (adminWallet !== null) {
        setBusy("Switching your pension key to Robinhood Chain…");
        await adminWallet.switchChain(ROBINHOOD_CHAIN_ID);
        const signer = await walletClientFor(adminWallet, admin, chain);
        setBusy("Sign the revoke with your pension key…");
        hash = await signer.writeContract({
          address: vault,
          abi: adminRevokeAbi,
          functionName: "revokeTradingAccount",
          args: [address],
        });
      } else {
        throw new Error(NEEDS_GAS);
      }

      setBusy("Waiting for the revoke to be included…");
      await client.waitForTransactionReceipt({ hash });
      setConfirming(false);
      onChanged();
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="space-y-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Num className="text-sm">{shortHex(address)}</Num>
        <CopyButton value={address} />
        {explorer !== null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-xs" asChild>
                <a href={explorer} target="_blank" rel="noreferrer" aria-label="View on explorer">
                  <ExternalLink aria-hidden />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent>View on explorer</TooltipContent>
          </Tooltip>
        ) : null}
        <Badge variant="outline">{ORIGIN_LABEL[origin]}</Badge>
        {link.detail !== undefined ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant={link.variant} tabIndex={0}>
                {link.text}
              </Badge>
            </TooltipTrigger>
            <TooltipContent>{link.detail}</TooltipContent>
          </Tooltip>
        ) : (
          <Badge variant={link.variant}>{link.text}</Badge>
        )}
        <div className="ml-auto">
          <SeatStatus address={address} config={config} held={held} onChanged={onChanged} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={LABEL}>Rate</span>
          {account !== null ? (
            <RateControl
              config={config}
              admin={admin}
              adminWallet={adminWallet}
              vault={vault}
              account={account}
              wallet={wallet}
              onChanged={onChanged}
            />
          ) : (
            <span className="text-xs text-muted-foreground">{probe.kind === "here" ? "unknown" : "Set when linked"}</span>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {(canLink || linking) && wallet !== null ? (
            <LinkWalletDialog
              config={config}
              admin={admin}
              adminWallet={adminWallet}
              vault={vault}
              wallet={wallet}
              account={account}
              onLinked={onChanged}
              onOpenChange={setLinking}
              disabled={busy !== null}
            />
          ) : null}
          {held ? <ExportWalletButton address={address} disabled={busy !== null} /> : null}
          {canRevoke && !confirming ? (
            <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirming(true)}>
              <Unlink aria-hidden />
              Revoke
            </Button>
          ) : null}
          {canRevoke && confirming ? (
            <>
              <Button type="button" variant="destructive" size="sm" disabled={busy !== null} aria-busy={busy !== null} onClick={() => void revoke()}>
                {busy !== null ? <LoaderCircle className="animate-spin" aria-hidden /> : <Unlink aria-hidden />}
                {busy !== null ? "Revoking…" : "Confirm revoke"}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {confirming && busy === null ? (
        <p className="text-xs text-muted-foreground">
          Revoking stops anything being put aside from this wallet. It keeps its funds; what it already put aside stays in
          the pension. It can be linked again later.
        </p>
      ) : null}
      {busy !== null ? (
        <p className="inline-flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
          <LoaderCircle className="size-3 animate-spin" aria-hidden />
          {busy}
        </p>
      ) : null}
      {failure !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      ) : null}
    </li>
  );
}
