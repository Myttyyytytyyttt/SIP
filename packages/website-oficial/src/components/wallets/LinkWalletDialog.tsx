"use client";

/**
 * Link a trading wallet to the pension — without the wallet ever needing gas.
 *
 * The gas point is the whole design. A freshly minted wallet holds nothing, so
 * asking it to send `acceptTradingAccount()` would strand every user at step
 * one. `acceptTradingAccountBySig` exists for exactly this: the trading wallet
 * SIGNS (free), and anyone may submit. Here the pension key submits, because it
 * is the one already paying for the invite.
 *
 *   1 of 2  pension key signs `inviteTradingAccount` (rate + §0.6 policy)
 *           read `vaultId` / `getTradingAccount` BACK from chain
 *           trading wallet signs `AcceptTradingAccount` (EIP-712, free)
 *   2 of 2  pension key signs `acceptTradingAccountBySig`
 *
 * EVERY WRITE IS SIMULATED FIRST, through the same transport, from the address
 * that will sign it. A revert here costs the PENSION KEY gas and reaches the
 * user as whatever the wallet chose to say about it — "An unknown RPC error
 * occurred", most often. Simulated first, the vault's own error arrives by name
 * (TradingAccountAlreadyLinked, InvalidState, InviteExpired…) before a
 * signature is asked for and before anything is spent. Same discipline as the
 * createVault preview in /api/create-vault.
 *
 * A PENDING account is not invited again — `_requireInvitable` refuses PENDING
 * — so the flow resumes at the acceptance; an EXPIRED invite is cleared with
 * `cancelTradingAccountInvitation` first (the only exit from PENDING).
 *
 * Ported from HEAD (fd927b0) src/components/InviteTradingWallet.tsx `link()`.
 */

import type { ConnectedWallet } from "@privy-io/react-auth";
import { Link2, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { getAddress, type Address, type Hex } from "viem";

import { Num } from "@/components/num";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { RatePicker } from "@/components/wallets/RateControl";
import type { VaultAccount } from "@/components/wallets/WalletsScreen";
import { personalVaultAbi } from "@/lib/abi";
import { ROBINHOOD_CHAIN_ID, robinhoodChain } from "@/lib/chain";
import { LABEL } from "@/lib/classes";
import type { PublicConfig } from "@/lib/config";
import { pct, shortHex } from "@/lib/format";
import { describeError } from "@/lib/wallets/judge";
import {
  ACCEPT_TYPES,
  DEFAULT_RATE_BPS,
  INVITE_TTL_SECONDS,
  PLATFORM_ID,
  acceptDomain,
  cancelInviteAbi,
  isRatePreset,
  nowSeconds,
  readClient,
  tradingPolicy,
  walletClientFor,
  type RatePresetBps,
} from "@/lib/wallets/policy";

const STEPS = [
  "You sign the invite (1 of 2)",
  "The trading wallet signs its acceptance — it pays nothing",
  "You sign the activation (2 of 2)",
] as const;

export function LinkWalletDialog({
  config,
  admin,
  adminWallet,
  vault,
  wallet,
  account,
  onLinked,
  onOpenChange,
  disabled = false,
}: {
  config: PublicConfig;
  admin: Address;
  adminWallet: ConnectedWallet | null;
  vault: Address;
  /** The trading wallet as Privy connects it — the only shape that can sign the acceptance here. */
  wallet: ConnectedWallet;
  /** What the vault currently holds for this address, or null when nothing. */
  account: VaultAccount | null;
  onLinked: () => void;
  /**
   * Whether the dialog is on screen. The row uses it to keep this component
   * mounted after linking succeeds — the account turns ACTIVE, the row's own
   * "can this be linked?" goes false, and the last step would otherwise be
   * unmounted before anybody read it.
   */
  onOpenChange?: (open: boolean) => void;
  disabled?: boolean;
}) {
  const address = getAddress(wallet.address);
  const pending = account?.status === "PENDING";
  const invitedBps = account !== null ? Number(account.savingsBps) : null;

  const [open, setOpen] = useState(false);
  const [rate, setRate] = useState<RatePresetBps>(
    invitedBps !== null && isRatePreset(invitedBps) ? invitedBps : DEFAULT_RATE_BPS,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [step, setStep] = useState<0 | 1 | 2 | 3>(pending ? 1 : 0);
  /** Latched once THIS dialog's invite landed, so a retry after a refused acceptance skips it. */
  const [invited, setInvited] = useState(pending);
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [expired, setExpired] = useState(false);

  /**
   * A write, asked of the chain before the user is asked for anything.
   *
   * The reason comes FIRST and the reassurance second: describeError caps what
   * it returns, so a named revert placed behind a sentence of ours is the part
   * that gets cut. viem's own message reads the same whether the call reverted
   * in a simulation or in a mined transaction, hence the second half.
   */
  async function simulated(what: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      throw new Error(`${describeError(error)} — ${what} would revert, so nothing was signed and nothing was spent.`);
    }
  }

  async function adminClient() {
    if (adminWallet === null) {
      throw new Error("Your pension key is not connected in this browser. Reconnect it, then link again.");
    }
    setBusy("Switching your pension key to Robinhood Chain…");
    await adminWallet.switchChain(ROBINHOOD_CHAIN_ID);
    return walletClientFor(adminWallet, admin, robinhoodChain(config.walletRpcUrl, config.explorerUrl));
  }

  async function link() {
    setFailure(null);
    setExpired(false);
    const chain = robinhoodChain(config.walletRpcUrl, config.explorerUrl);
    const client = readClient(config);
    try {
      const pensionKey = await adminClient();

      if (!invited) {
        setStep(0);
        // ONE deadline for both calls. Called twice, nowSeconds() can differ by
        // a second, and a simulation of a different transaction proves nothing
        // about the one that gets signed.
        const deadline = nowSeconds() + INVITE_TTL_SECONDS;
        const invite = {
          address: vault,
          abi: personalVaultAbi,
          functionName: "inviteTradingAccount",
          args: [address, PLATFORM_ID, tradingPolicy(rate), deadline],
        } as const;
        setBusy("Checking the invite would be accepted…");
        await simulated("The invite", () => client.simulateContract({ ...invite, account: admin }));
        setBusy("Sign to invite the wallet (1 of 2)…");
        const inviteHash = await pensionKey.writeContract(invite);
        setBusy("Waiting for the invite to be included…");
        await client.waitForTransactionReceipt({ hash: inviteHash });
        setInvited(true);
      }

      // Read the invite back rather than assuming what was written: the digest
      // must match the nonce and epoch the CONTRACT now holds, not the ones the
      // browser thinks it sent.
      setStep(1);
      setBusy("Reading the invite back from chain…");
      const [vaultId, tradingAccount] = await Promise.all([
        client.readContract({ address: vault, abi: personalVaultAbi, functionName: "vaultId" }),
        client.readContract({ address: vault, abi: personalVaultAbi, functionName: "getTradingAccount", args: [address] }),
      ]);
      if (Number(tradingAccount.inviteDeadline) <= nowSeconds()) {
        setExpired(true);
        throw new Error("The invite has expired. Clear it below, then link again.");
      }

      setBusy("Your trading wallet is signing its acceptance (free)…");
      // THE SIGNER SWITCHES CHAINS TOO. The typed data names its own chainId,
      // so a correct provider would not care; Privy's embedded provider is
      // entitled to refuse a signature for a chain it is not on, and refuses it
      // as "An unknown RPC error occurred", which is what a freshly generated
      // wallet met here. Best-effort: a wallet already on the right chain, or
      // one whose connector has no switchChain, is unaffected.
      await wallet.switchChain(ROBINHOOD_CHAIN_ID).catch(() => undefined);
      const tradingClient = await walletClientFor(wallet, address, chain);
      const signature: Hex = await tradingClient.signTypedData({
        account: address,
        domain: acceptDomain(vault),
        types: ACCEPT_TYPES,
        primaryType: "AcceptTradingAccount",
        message: {
          vaultId,
          vault,
          tradingWallet: address,
          inviteNonce: tradingAccount.inviteNonce,
          adminEpoch: tradingAccount.inviteAdminEpoch,
          deadline: tradingAccount.inviteDeadline,
        },
      });

      setStep(2);
      const accept = {
        address: vault,
        abi: personalVaultAbi,
        functionName: "acceptTradingAccountBySig",
        args: [address, tradingAccount.inviteDeadline, signature],
      } as const;
      // The one write whose failure the user could not otherwise read: a bad
      // signature, an expired invite or an address that is a vault admin all
      // revert here, after the wallet has already signed.
      setBusy("Checking the acceptance would be accepted…");
      await simulated("The activation", () => client.simulateContract({ ...accept, account: admin }));
      setBusy("Sign to activate it (2 of 2)…");
      const acceptHash = await pensionKey.writeContract(accept);
      setBusy("Waiting for activation…");
      await client.waitForTransactionReceipt({ hash: acceptHash });

      setStep(3);
      setDone(true);
      onLinked();
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(null);
    }
  }

  /** The only exit from PENDING: REVOKED, from which the wallet can be invited again. */
  async function clearExpired() {
    setFailure(null);
    try {
      const pensionKey = await adminClient();
      const client = readClient(config);
      const cancel = {
        address: vault,
        abi: cancelInviteAbi,
        functionName: "cancelTradingAccountInvitation",
        args: [address],
      } as const;
      setBusy("Checking the invite can be cleared…");
      await simulated("Clearing the invite", () => client.simulateContract({ ...cancel, account: admin }));
      setBusy("Sign to clear the expired invite…");
      const hash = await pensionKey.writeContract(cancel);
      setBusy("Waiting for the clear to be included…");
      await client.waitForTransactionReceipt({ hash });
      setExpired(false);
      setInvited(false);
      setStep(0);
      onLinked();
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A signature in flight is not abandoned by an Escape key.
        if (busy !== null) return;
        setOpen(next);
        onOpenChange?.(next);
        if (!next) {
          setFailure(null);
          setDone(false);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" size="sm" disabled={disabled}>
          <Link2 aria-hidden />
          {pending ? "Finish linking" : "Link"}
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={busy === null}>
        <DialogHeader>
          <DialogTitle>
            Link <Num>{shortHex(address)}</Num> to your pension
          </DialogTitle>
          <DialogDescription>
            Two signatures from your pension key; the trading wallet signs once and pays nothing. From then on its
            rate of every buy and sell is put aside.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className={LABEL}>Rate</div>
          {invited ? (
            <p className="text-sm">
              Invited at <Num>{invitedBps !== null ? pct(invitedBps) : pct(rate)}</Num> — the rate is fixed by the invite and can be changed once linked.
            </p>
          ) : (
            <RatePicker value={rate} onChange={setRate} disabled={busy !== null} label="Rate" />
          )}
        </div>

        <ol className="space-y-1 text-sm" aria-label="Steps">
          {STEPS.map((text, index) => (
            <li
              key={text}
              className={
                index < step || done
                  ? "text-muted-foreground line-through"
                  : index === step
                    ? "text-foreground"
                    : "text-muted-foreground"
              }
            >
              <Num className="mr-2 text-xs">{index + 1}</Num>
              {text}
            </li>
          ))}
        </ol>

        {busy !== null ? (
          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            {busy}
          </p>
        ) : null}
        {failure !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        {done ? (
          <p className="text-sm" aria-live="polite">
            <Num>{shortHex(address)}</Num> is linked and active. Fund it and trade.
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={busy !== null}>
              {done ? "Close" : "Cancel"}
            </Button>
          </DialogClose>
          {expired ? (
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void clearExpired()}>
              Clear the expired invite
            </Button>
          ) : null}
          {!done ? (
            <Button type="button" disabled={busy !== null || expired} aria-busy={busy !== null} onClick={() => void link()}>
              {busy !== null ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
              {invited ? "Finish linking" : "Link it"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
