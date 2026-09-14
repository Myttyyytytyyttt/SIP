"use client";

/**
 * THE WALLETS MODAL, until the Solana wallet screens exist.
 *
 * "Manage wallets" still opens a modal, never a navigation, and it says what is
 * true: nothing here can move funds yet.
 */

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function SolanaWalletsPendingModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader className="text-left">
          <DialogTitle>Solana wallets are on their way</DialogTitle>
          <DialogDescription>
            This deployment runs on Solana. The screens for your pension key, your vault and your trading wallets are
            the next release. Nothing here can move funds yet.
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
