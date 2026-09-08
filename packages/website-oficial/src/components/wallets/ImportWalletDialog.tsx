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
 * TWO FRAMES, ONE BODY. The wallets modal cannot open this as a Dialog: a
 * Dialog inside a Dialog stacks two overlays and two focus traps, and a single
 * Escape then closes whichever one Radix happened to put on top. So the flow
 * lives in `<ImportWalletView>` — form, status and buttons, NO overlay — and
 * the wrapper at the bottom of this file picks the frame: a Dialog on the
 * /wallets route, and inside the modal a button that asks the shell
 * (`useWalletsView()`) to put this body in place of the list.
 *
 * WHY A SEPARATE VIEW rather than one component with a `mode` prop: the
 * preflights below are the part that must not drift, and they stay in exactly
 * one place, mounted the same way in both frames. What the frames actually
 * disagree about is who draws the heading and the way back — so that is all
 * the wrapper decides, and every refusal, every message and the key-clearing
 * are the same code either way.
 *
 * Ported from HEAD (fd927b0) src/components/InviteTradingWallet.tsx
 * (`importRun`) and src/components/WalletsPanel.tsx (`ImportBox`).
 */

import { useImportWallet, usePrivy, useUser } from "@privy-io/react-auth";
import { LoaderCircle, Upload } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { getAddress, type Address } from "viem";

import { Num } from "@/components/num";
import { Button } from "@/components/ui/button";
import {
  Dialog,
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
import { useWalletsView } from "@/components/wallets/WalletsScreen";
import { LABEL } from "@/lib/classes";
import type { PublicConfig } from "@/lib/config";
import { shortHex } from "@/lib/format";
import type { VaultByAccountResponse, VaultByAdminResponse } from "@/lib/api-types";
import { parseTagged } from "@/lib/serialize";
import { describeError, judgePastedKey } from "@/lib/wallets/judge";
import { SEAT_NOT_CONFIGURED, seatSigners } from "@/lib/wallets/policy";

const ONE_IMPORT =
  "Privy holds one imported wallet per account, and this account already has one. Link that wallet from the list, or create a fresh one instead.";

/**
 * What both wallet views need from whatever holds them — the wallets modal's
 * view switcher, or the Dialog wrappers in this file and LinkWalletDialog.
 * It lives here, and not in a third file, because these two components are the
 * only ones that have this shape.
 */
export interface WalletViewShell {
  /** Leave this view: back to the wallets list, or close the dialog. */
  onClose: () => void;
  /**
   * A key is moving or a signature is in flight. The container must not let an
   * Escape key, a backdrop click or a back button take the view away while
   * this is true — the dialog wrapper below refuses exactly that.
   */
  onBusyChange?: (busy: boolean) => void;
  /**
   * The failure the view is currently showing, in its own words, or null when
   * there is none. The view renders it either way; a container that moves the
   * user somewhere else can carry the reason along.
   */
  onFailure?: (message: string | null) => void;
  /**
   * "dialog" on the /wallets route, "inline" inside the wallets modal. It
   * changes the way-out copy and the footer's chrome; nothing else.
   */
  frame?: "dialog" | "inline";
}

export function ImportWalletView({
  config,
  admin,
  vault,
  embedded,
  onImported,
  onClose,
  onBusyChange,
  onFailure,
  frame = "dialog",
}: WalletViewShell & {
  config: PublicConfig;
  admin: Address;
  vault: Address;
  /** Every wallet Privy already holds for this user, so a re-paste is caught before the SDK refuses it. */
  embedded: readonly Address[];
  onImported: (address: Address) => void;
}) {
  const { user } = usePrivy();
  const { refreshUser } = useUser();
  const { importWallet } = useImportWallet();

  const [key, setKey] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const judged = useMemo(() => judgePastedKey(key), [key]);
  const problem = judged !== null && "problem" in judged ? judged.problem : null;
  const preview = judged !== null && "address" in judged ? judged.address : null;

  // Two ids: nothing stops a container from mounting this view while the
  // route's dialog is also on screen, and a duplicated id points the label at
  // the wrong input.
  const keyId = useId();
  const noteId = `${keyId}-note`;

  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // The dialog frame gets this from Radix. The inline frame swapped one view
    // for another inside a modal that was already open, so nothing moved focus.
    if (frame === "inline") inputRef.current?.focus();
  }, [frame]);

  useEffect(() => {
    onBusyChange?.(busy !== null);
  }, [busy, onBusyChange]);
  useEffect(() => {
    onFailure?.(failure);
  }, [failure, onFailure]);

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

  /** Leaving is leaving, whichever frame holds this: the key goes first. */
  function leave() {
    if (busy !== null) return;
    setKey("");
    onClose();
  }

  // Its own grid, so the body spaces itself wherever it is put: DialogContent
  // brings `grid gap-4`, the modal's body brings whatever it brings.
  return (
    <div className="grid gap-4">
      <div className="space-y-2">
        <Label htmlFor={keyId} className={LABEL}>
          Private key
        </Label>
        <Input
          id={keyId}
          ref={inputRef}
          type="password"
          autoComplete="new-password"
          data-1p-ignore
          data-bwignore
          data-lpignore="true"
          spellCheck={false}
          disabled={busy !== null}
          aria-invalid={problem !== null}
          aria-describedby={noteId}
          placeholder="0x… (64 hex characters — what your wallet's Export shows)"
          className="font-mono"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <p id={noteId} className="text-xs" aria-live="polite">
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

      {/* Stock DialogFooter in both frames — it is a plain div; inline, only its
          dialog-edge bleed and fill are dropped. */}
      <DialogFooter className={frame === "inline" ? "mx-0 mb-0 rounded-none bg-transparent" : undefined}>
        <Button type="button" variant="outline" disabled={busy !== null} onClick={leave}>
          {notice !== null ? (frame === "inline" ? "Back to wallets" : "Close") : "Cancel"}
        </Button>
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
    </div>
  );
}

/**
 * The frame around that body.
 *
 * On /wallets there is no shell, so this is a trigger and an overlay, exactly
 * as it always was. Inside the wallets modal `useWalletsView()` answers, and
 * the trigger asks the SHELL to change view instead of opening a second
 * Dialog — the body then renders in place of the list, under the modal's own
 * header and back control.
 */
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
  const shell = useWalletsView();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (shell !== null) {
    return shell.view.kind === "import" ? (
      <ImportWalletView
        config={config}
        admin={admin}
        vault={vault}
        embedded={embedded}
        onImported={onImported}
        onClose={shell.back}
        frame="inline"
      />
    ) : (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => shell.show({ kind: "import" })}
      >
        <Upload aria-hidden />
        Import a wallet
      </Button>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // A key in flight is not abandoned by an Escape key. Closing unmounts
        // the view, which is what clears the pasted key on the way out.
        if (busy) return;
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          <Upload aria-hidden />
          Import a wallet
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Import a wallet you already trade with</DialogTitle>
          <DialogDescription>
            Paste its private key. It leaves this page already encrypted, straight into Privy&apos;s signing enclave — it
            never reaches our servers. The keeper gets its policy-bound seat in the same motion; you link it after.
          </DialogDescription>
        </DialogHeader>
        <ImportWalletView
          config={config}
          admin={admin}
          vault={vault}
          embedded={embedded}
          onImported={onImported}
          onClose={() => setOpen(false)}
          onBusyChange={setBusy}
        />
      </DialogContent>
    </Dialog>
  );
}
