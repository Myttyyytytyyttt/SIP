"use client";

/**
 * WHAT STANDS AT THE RIGHT OF THE BAR when somebody is connected — the pension
 * key, what it is worth, and the way out.
 *
 * IT LIVES HERE BECAUSE TWO HEADERS WEAR IT. The dashboard builds it from its
 * own state machine; /leaderboard, which is a public page outside that frame,
 * builds it from Privy directly. Two copies of this would be two chips that
 * agree until one of them is edited — and one of the things they agree about is
 * WHEN A FIGURE MAY BE SHOWN AT ALL, which is a rule worth exactly one home.
 */

import { LogOut } from "lucide-react";

import { CopyButton } from "@/components/copy-button";
import { Num } from "@/components/num";
import { Button } from "@/components/ui/button";
import { formatUsd } from "@/lib/amounts";
import { LIVE_COPY } from "@/lib/live-copy";
import type { LiveView } from "@/hooks/use-live-dashboard";
import { shortAddress } from "@/lib/vault-copy";

/**
 * What the pension is worth, or null when no figure may be claimed.
 *
 * A READ WHOSE VAULT FAILED IS STILL "ready": prices and token accounts come
 * back fine on a partial RPC failure, so reading `kind === "ready"` alone put a
 * dollar figure in the bar of the very screen that says the pension could not
 * be read. The stage the page branches on is the stage this reads.
 */
export function worthFrom(view: LiveView): bigint | null {
  if (view.kind !== "ready" || view.data.stage === "vault_unreadable") return null;
  return view.data.worthNowUsdcRaw;
}

/**
 * The connected pension key: its short address, a copy button, and WHAT THE
 * PENSION IS WORTH.
 *
 * THE BALANCE REPLACED A SOLSCAN LINK. The link was the third way to reach the
 * same explorer from that screen and answered a question nobody had in the
 * chrome; the balance is the one number somebody wants following them around.
 * A null shows nothing rather than a zero — a pension whose worth could not be
 * read has not lost its money.
 */
export function PensionKeyChip({ address, worthUsdcRaw }: { readonly address: string; readonly worthUsdcRaw: bigint | null }) {
  return (
    <span className="hidden items-center gap-1.5 rounded-md border px-2 py-1 sm:inline-flex">
      <Num className="text-xs">{shortAddress(address)}</Num>
      <CopyButton value={address} />
      {worthUsdcRaw === null ? null : (
        <>
          <span aria-hidden className="h-3.5 w-px bg-border" />
          <Num className="text-xs font-medium">{formatUsd(worthUsdcRaw)}</Num>
          <span className="sr-only">{LIVE_COPY.worthNow}</span>
        </>
      )}
    </span>
  );
}

export function DisconnectButton({ onDisconnect }: { readonly onDisconnect: () => void }) {
  return (
    <>
      <Button size="sm" variant="outline" className="hidden sm:inline-flex" onClick={onDisconnect}>
        {LIVE_COPY.disconnect}
      </Button>
      <Button size="sm" variant="outline" className="sm:hidden" aria-label={LIVE_COPY.disconnect} onClick={onDisconnect}>
        <LogOut aria-hidden />
      </Button>
    </>
  );
}
