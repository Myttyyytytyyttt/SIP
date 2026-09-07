"use client";

/**
 * Bring in a wallet the user already trades with.
 *
 * The reverse arrow of the export button: the key the user pastes goes from
 * this page straight into Privy's enclave, HPKE-encrypted CLIENT-SIDE by the
 * SDK — it never reaches our server and never appears in a request we could
 * log. "Connect your wallet" cannot do this job: the pull is a transaction the
 * trading wallet itself signs, every time, so a wallet that is merely connected
 * would link fine and then never put aside a cent. Import is the only shape
 * that keeps the product's promise, and the user keeps their own copy — the
 * same address goes on working wherever it lives.
 *
 * IT STOPS AT THE IMPORT, DELIBERATELY. The wallet then appears in the list
 * with the Link button and the seat repair the rest of the page already
 * provides. A second link flow here would be a second copy of the one that works.
 *
 * THE KEEPER'S SEAT RIDES ALONG (`additionalSigners`) — but only in Privy's
 * TEE mode; on-device apps drop it silently. So the seat is READ BACK from the
 * user record after the import, and a wallet that arrived unseated says so by
 * name instead of being shown as saving.
 *
 * Ported from HEAD (fd927b0) src/components/InviteTradingWallet.tsx
 * (`importRun`) and src/components/WalletsPanel.tsx (`ImportBox`).
 */

import { useImportWallet, usePrivy, useUser } from "@privy-io/react-auth";
import { LoaderCircle, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { getAddress, type Address } from "viem";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { seatOf } from "@/components/wallets/SeatStatus";
import { LABEL } from "@/lib/classes";
import type { PublicConfig } from "@/lib/config";
import { shortHex } from "@/lib/format";
import type { VaultByAccountResponse, VaultByAdminResponse } from "@/lib/api-types";
import { parseTagged } from "@/lib/serialize";
import { describeError, judgePastedKey } from "@/lib/wallets/judge";
import { SEAT_NOT_CONFIGURED, seatSigners } from "@/lib/wallets/policy";

const ONE_IMPORT =
  "Privy holds one imported wallet per account, and this account already has one. Link that wallet from the list, or create a fresh one instead.";

export function ImportWalletDialog({
  config,
  admin,
  vault,
  embedded,
  onImported,
  disabled = false,
}: {
  config: PublicConfig;
  admin: Address;
  vault: Address;
  /** Every wallet Privy already holds for this user, so a re-paste is caught before the SDK refuses it. */
  embedded: readonly Address[];
  onImported: (address: Address) => void;
  disabled?: boolean;
}) {
  const { user } = usePrivy();
  const { refreshUser } = useUser();
  const { importWallet } = useImportWallet();

  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const judged = useMemo(() => judgePastedKey(key), [key]);
  const problem = judged !== null && "problem" in judged ? judged.problem : null;
  const preview = judged !== null && "address" in judged ? judged.address : null;

  /** Every exit clears the key: an error must never wait on screen with the pasted key behind it. */
  function leave(next: boolean) {
    if (busy !== null) return;
    setKey("");
    setOpen(next);
    if (!next) {
      setFailure(null);
      setNotice(null);
    }
  }

  async function run() {
    if (judged === null || !("key" in judged)) return;
    const { key: privateKey, address } = judged;
    // Out of state BEFORE anything is awaited: nothing after this line needs
    // it from state, so nothing after this line gets to keep it there.
    setKey("");
    setFailure(null);
    setNotice(null);

    // Knowable BEFORE the paste goes anywhere. Never an EMPTY policyIds array —
    // Privy reads that as FULL permission, and an imported wallet arrives
    // already funded.
    const signers = seatSigners(config);
    if (signers === null) {
      setFailure(`${SEAT_NOT_CONFIGURED} Your key was not imported.`);
      return;
    }

    // PRIVY ALLOWS ONE IMPORTED WALLET PER USER (the hook errors on a second).
    // Said here in our words, before the paste is wasted. Ethereum only: a
    // Solana import on the same account must not block every EVM import.
    const prior = (user?.linkedAccounts ?? []).find(
      (account) =>
        account.type === "wallet" &&
        account.chainType === "ethereum" &&
        account.imported === true &&
        account.address.toLowerCase() !== address.toLowerCase(),
    );
    if (prior !== undefined) {
      setFailure(ONE_IMPORT);
      return;
    }

    // The vault refuses an address that is both pension key and trading
    // account, so refuse it here with words instead of letting the invite
    // revert on chain.
    if (address.toLowerCase() === admin.toLowerCase()) {
      setFailure(
        "That key belongs to your pension key — the wallet that OWNS the savings. The protocol rejects an address " +
          "that is both owner and trading account. Paste the key of the wallet you trade with.",
      );
      return;
    }

    // Already inside Privy — a retry after a half-finished attempt, or a key
    // that was imported before. Importing again would error; what the user
    // wants is the rest of the sequence, and that lives on the row.
    if (embedded.some((held) => held.toLowerCase() === address.toLowerCase())) {
      setNotice(`${shortHex(address)} is already in your list below — link it from there.`);
      return;
    }

    setBusy("Checking this wallet is free to link…");
    try {
      // ASKED OF THE CHAIN BEFORE THE KEY GOES ANYWHERE, and asked TWICE,
      // because there are two ways an address is already spoken for and each
      // one costs the user a different amount to discover late:
      //
      //  · activeVaultOf — linking is globally exclusive, so a wallet that
      //    already feeds a DIFFERENT vault would sail through import and then
      //    revert two signatures deep.
      //  · vaultOfAdmin — a pension key CANNOT also be a trading account
      //    (_requireNotVaultAdmin). We already refuse THIS vault's own admin by
      //    name, but another vault's admin passed straight through: the invite
      //    lands, the acceptance reverts, and the wallet is stuck PENDING for
      //    the invite's whole 24 h — an admin-only cancel away from being
      //    invitable again. Both answers must be known before the key moves.
      //
      // An unreadable answer is not a free wallet.
      const [freeResponse, adminResponse] = await Promise.all([
        fetch(`/api/vault?account=${address}`, { cache: "no-store" }),
        fetch(`/api/vault?admin=${address}`, { cache: "no-store" }),
      ]);
      const [freeText, adminText] = await Promise.all([freeResponse.text(), adminResponse.text()]);
      if (!freeResponse.ok || !adminResponse.ok) {
        const status = freeResponse.ok ? adminResponse.status : freeResponse.status;
        throw new Error(`Could not check whether this wallet is free to link (HTTP ${status}). Nothing was imported.`);
      }
      const { activeVaultOf } = parseTagged<VaultByAccountResponse>(freeText);
      if (activeVaultOf !== null && BigInt(activeVaultOf) !== 0n && activeVaultOf.toLowerCase() !== vault.toLowerCase()) {
        throw new Error(
          `That wallet already feeds a different pension (${shortHex(activeVaultOf)}). A wallet can put aside into ` +
            "one pension at a time — revoke it there first, or import a different one.",
        );
      }
      const { vault: ownedVault } = parseTagged<VaultByAdminResponse>(adminText);
      if (ownedVault !== null && BigInt(ownedVault) !== 0n) {
        throw new Error(
          `That key OWNS a pension of its own (${shortHex(ownedVault)}) — it is a pension key, not a trading wallet. ` +
            "The protocol rejects an address that is both, so this one could be invited and would then fail to " +
            "accept. Paste the key of the wallet you trade with.",
        );
      }

      setBusy("Encrypting your key into the signing enclave…");
      // ATTACHED ATOMICALLY: the imported wallet is born with the keeper's
      // policy-bound seat, no window where it sits inside Privy unconstrained.
      const imported = await importWallet({
        privateKey,
        additionalSigners: signers.map((signer) => ({ signerId: signer.signerId, policyIds: [...signer.policyIds] })),
      });
      const importedAddress = getAddress(imported.address);

      // THE SEAT, READ BACK. `additionalSigners` is honoured only when the
      // Privy app runs in TEE mode; on-device apps import the wallet and drop
      // the signer without a word. The user record is the fact.
      setBusy("Reading the seat back from Privy…");
      const fresh = await refreshUser().catch(() => null);
      const seated = seatOf(fresh ?? user, importedAddress);
      onImported(importedAddress);
      if (seated !== true) {
        setFailure(
          `${shortHex(importedAddress)} was imported, but Privy did NOT attach the keeper's seat. Imports are only ` +
            "seated when the Privy app runs in TEE mode (Dashboard → Wallets → Advanced). Nothing can be put aside " +
            "from it until it is authorised — use Authorise on its row, or fix the app's execution mode.",
        );
        return;
      }
      setNotice(`${shortHex(importedAddress)} is in your list below, seated. Link it from there.`);
    } catch (error) {
      const message = describeError(error);
      setFailure(/already has an imported wallet/i.test(message) ? ONE_IMPORT : message);
    } finally {
      // Also on failure: a pasted key must never sit in component state while
      // an error message waits for the user to come back and read it.
      setKey("");
      setBusy(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={leave}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          <Upload aria-hidden />
          Import a wallet
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={busy === null}>
        <DialogHeader>
          <DialogTitle>Import a wallet you already trade with</DialogTitle>
          <DialogDescription>
            Paste its private key. It leaves this page already encrypted, straight into Privy&apos;s signing enclave — it
            never reaches our servers. The keeper gets its policy-bound seat in the same motion; you link it after.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="import-key" className={LABEL}>
            Private key
          </Label>
          <Input
            id="import-key"
            type="password"
            autoComplete="new-password"
            data-1p-ignore
            data-bwignore
            data-lpignore="true"
            spellCheck={false}
            disabled={busy !== null}
            aria-invalid={problem !== null}
            aria-describedby="import-key-note"
            placeholder="0x… (64 hex characters — what your wallet's Export shows)"
            className="font-mono"
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />
          <p id="import-key-note" className="text-xs" aria-live="polite">
            {problem !== null ? (
              <span className="text-destructive">{problem}</span>
            ) : preview !== null ? (
              <>
                This imports <Num>{shortHex(preview)}</Num>. Check it is the wallet you expect before continuing.
              </>
            ) : (
              <span className="text-muted-foreground">
                Your copy of the key keeps working — same wallet, same apps. If it came from a Telegram bot, the
                bot&apos;s operator holds a copy too; only your pension key can withdraw the savings either way.
              </span>
            )}
          </p>
        </div>

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
        {notice !== null ? (
          <p className="text-sm" aria-live="polite">
            {notice}
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={busy !== null}>
              {notice !== null ? "Close" : "Cancel"}
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={busy !== null || preview === null}
            aria-busy={busy !== null}
            onClick={() => void run()}
          >
            {busy !== null ? <LoaderCircle className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
            {busy !== null ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
