"use client";

/**
 * The one question a saver answers: how much of every buy and sell is put
 * aside. Three presets, in basis points of notional.
 *
 * `RatePicker` is the bare control (the link dialog uses it before anything is
 * on chain). `RateControl` is the picker wired to a LINKED account: the trading
 * wallet signs `setMySavingsBps` itself when Privy holds it AND it can pay for
 * the transaction — it is their pension, and the contract lets the holder
 * retune without the admin — and the pension key signs
 * `setTradingAccountPolicy` otherwise. Ported from HEAD (fd927b0)
 * src/components/InviteTradingWallet.tsx (`retuneReserves`), profit presets
 * replaced by volume-mode rates.
 */

import type { ConnectedWallet } from "@privy-io/react-auth";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { Address } from "viem";

import { Num } from "@/components/num";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { VaultAccount } from "@/components/wallets/WalletsScreen";
import { personalVaultAbi } from "@/lib/abi";
import { ROBINHOOD_CHAIN_ID, robinhoodChain } from "@/lib/chain";
import { MONO } from "@/lib/classes";
import type { PublicConfig } from "@/lib/config";
import { pct } from "@/lib/format";
import { describeError } from "@/lib/wallets/judge";
import {
  RATE_PRESETS_BPS,
  isRatePreset,
  readClient,
  tradingPolicy,
  walletClientFor,
  type RatePresetBps,
} from "@/lib/wallets/policy";

/**
 * A ceiling for the one-storage-slot writes a trading wallet is ever asked to
 * sign here (`setMySavingsBps`, `revokeMyTradingAccount`). It prices the
 * signature; it is never sent as a gas limit.
 */
const HOLDER_WRITE_GAS_BUDGET = 200_000n;

/**
 * Whether the trading wallet can pay for the write it is about to be asked to
 * sign — and the reason this exists at all: a wallet BORN SEATED on this page
 * holds nothing, so the prompt would open on a transaction the chain cannot
 * accept, and "insufficient funds" arrives after the user has already approved
 * something. The admin path costs the pension key gas and works from the first
 * second, so the answer here only decides WHO signs.
 *
 * A read that fails answers TRUE. This is here to catch the wallet that is
 * certainly empty, not to become a new way for a flaky RPC to push every user
 * onto the pension key. Exported for TradingWalletRow's revoke, which asks the
 * same question about the same wallet.
 */
export async function walletCanPayItsOwnGas(
  client: ReturnType<typeof readClient>,
  address: Address,
): Promise<boolean> {
  try {
    const [balance, gasPrice] = await Promise.all([client.getBalance({ address }), client.getGasPrice()]);
    return balance >= gasPrice * HOLDER_WRITE_GAS_BUDGET;
  } catch {
    return true;
  }
}

/** Said wherever a wallet that holds nothing is the only signer available. */
export const NEEDS_GAS =
  "This wallet holds no ETH, so it cannot pay for a transaction of its own, and your pension key — which would pay " +
  "for it instead — is not connected in this browser. Connect the pension key, or send a little ETH to the wallet.";

export function RatePicker({
  value,
  onChange,
  disabled = false,
  label = "Rate",
}: {
  /** Basis points. A value outside the presets selects nothing — the truth is shown beside the picker. */
  value: number | null;
  onChange: (bps: RatePresetBps) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-label={label}
      disabled={disabled}
      value={value !== null && isRatePreset(value) ? String(value) : ""}
      onValueChange={(next) => {
        // Radix reports "" when the active item is pressed again; a rate cannot be unset.
        if (next === "") return;
        const bps = Number(next);
        if (isRatePreset(bps)) onChange(bps);
      }}
    >
      {RATE_PRESETS_BPS.map((bps) => (
        <ToggleGroupItem key={bps} value={String(bps)} aria-label={`${pct(bps)} of every buy and sell`} className={MONO}>
          {pct(bps)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function RateControl({
  config,
  admin,
  adminWallet,
  vault,
  account,
  wallet,
  onChanged,
}: {
  config: PublicConfig;
  admin: Address;
  adminWallet: ConnectedWallet | null;
  vault: Address;
  account: VaultAccount;
  /** The trading wallet as Privy connects it, or null when it cannot sign here. */
  wallet: ConnectedWallet | null;
  onChanged: () => void;
}) {
  const current = Number(account.savingsBps);
  // `_setSavingsBps` takes ACTIVE from the holder, ACTIVE or PAUSED from the
  // admin; PENDING and REVOKED carry the rate the invite fixed.
  const editable = account.status === "ACTIVE" || account.status === "PAUSED";
  const [pending, setPending] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function apply(bps: RatePresetBps) {
    if (bps === current || busy !== null) return;
    setFailure(null);
    setPending(bps);
    const chain = robinhoodChain(config.walletRpcUrl, config.explorerUrl);
    const client = readClient(config);
    try {
      // WHO SIGNS is decided by who can pay. `setMySavingsBps` is the holder's
      // own right, but a wallet with no ETH cannot exercise it, and a signature
      // that cannot pay for itself is never worth asking for.
      const holderMaySign = wallet !== null && account.status === "ACTIVE";
      let holderCanPay = false;
      if (holderMaySign) {
        setBusy("Checking the trading wallet can pay for its own transaction…");
        holderCanPay = await walletCanPayItsOwnGas(client, account.address);
      }

      let hash: `0x${string}`;
      if (wallet !== null && holderMaySign && holderCanPay) {
        // Best-effort: Privy's embedded provider is entitled to refuse a
        // signature for a chain it is not on; a connector without switchChain
        // is unaffected.
        setBusy("Switching the trading wallet to Robinhood Chain…");
        await wallet.switchChain(ROBINHOOD_CHAIN_ID).catch(() => undefined);
        const signer = await walletClientFor(wallet, account.address, chain);
        setBusy("The trading wallet is signing the new rate…");
        hash = await signer.writeContract({
          address: vault,
          abi: personalVaultAbi,
          functionName: "setMySavingsBps",
          args: [bps],
        });
      } else if (adminWallet !== null) {
        setBusy("Switching your pension key to Robinhood Chain…");
        await adminWallet.switchChain(ROBINHOOD_CHAIN_ID);
        const signer = await walletClientFor(adminWallet, admin, chain);
        setBusy("Sign the policy update with your pension key…");
        // The whole policy is rewritten: the rate from this control, the other
        // five from §0.6 — so retuning cannot leave a profit-era cap behind.
        hash = await signer.writeContract({
          address: vault,
          abi: personalVaultAbi,
          functionName: "setTradingAccountPolicy",
          args: [account.address, tradingPolicy(bps)],
        });
      } else if (holderMaySign) {
        throw new Error(NEEDS_GAS);
      } else {
        throw new Error("Neither the trading wallet nor your pension key can sign in this browser. Reconnect the pension key.");
      }
      setBusy("Waiting for the update to be included…");
      await client.waitForTransactionReceipt({ hash });
      onChanged();
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(null);
      setPending(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <RatePicker value={pending ?? current} onChange={(bps) => void apply(bps)} disabled={!editable || busy !== null} />
      {!isRatePreset(current) ? (
        <span className="text-xs text-muted-foreground">
          now <Num>{pct(current)}</Num>
        </span>
      ) : null}
      {!editable ? <span className="text-xs text-muted-foreground">Changes once linked</span> : null}
      {busy !== null ? (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
          <LoaderCircle className="size-3 animate-spin" aria-hidden />
          {busy}
        </span>
      ) : null}
      {failure !== null ? (
        <span role="alert" className="basis-full text-xs text-destructive">
          {failure}
        </span>
      ) : null}
    </div>
  );
}
