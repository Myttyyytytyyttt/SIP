"use client";

/**
 * THE LIVE DASHBOARD BEFORE IT HAS A PENSION TO SHOW — every state that holds no
 * numbers, in one file because they are one family: a card, a sentence that says
 * exactly what is and is not known, and the one control that helps.
 *
 * NONE OF THEM EVER SHOWS A NUMBER. That is the whole point of their existing:
 * a Live panel that cannot read a pension must not fall back to the seeded
 * example, because that puts a stranger's invented savings under a label
 * promising the visitor their own.
 *
 * They import '@/lib/live-copy' and nothing from '@/mocks': there is no sample
 * data anywhere in this file to reach for by accident.
 */

import { LogOut, RefreshCw } from "lucide-react";

import { RetryButton, useReadyAt } from "@/components/live/RetryButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LIVE_COPY } from "@/lib/live-copy";
import { cn } from "@/lib/utils";

function Shell({ title, children, className }: { readonly title: string; readonly children: React.ReactNode; readonly className?: string }) {
  return (
    <div className={cn("flex flex-1 items-start justify-center p-4 lg:p-6", className)}>
      <Card className="w-full max-w-lg">{children}</Card>
    </div>
  );
}

/**
 * Privy has not answered yet. A skeleton with the same shape the real panel has,
 * so the page does not jump when it arrives — and NOT the sample, which is what
 * the server used to paint before Privy could say who was looking.
 */
export function LiveLoading({ label = LIVE_COPY.checking }: { readonly label?: string }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-4 p-4 lg:gap-6 lg:p-6" aria-busy="true" role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      <Skeleton className="h-10 w-full rounded-md" />
      <Skeleton className="h-28 w-full rounded-xl" />
      <div className="grid gap-4 lg:gap-6 md:grid-cols-[minmax(16rem,20rem)_1fr] lg:grid-cols-1 xl:grid-cols-[minmax(16rem,20rem)_1fr]">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    </div>
  );
}

/** Privy took longer than anyone should wait. Says what to do, and names the host to unblock. */
export function LivePrivyStalled({ onSeeSample }: { readonly onSeeSample: () => void }) {
  return (
    <Shell title={LIVE_COPY.stalledTitle}>
      <CardHeader>
        <CardTitle className="text-base">{LIVE_COPY.stalledTitle}</CardTitle>
        <CardDescription>{LIVE_COPY.stalledBody}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
          <RefreshCw aria-hidden />
          {LIVE_COPY.reload}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onSeeSample}>
          {LIVE_COPY.viewSample}
        </Button>
      </CardContent>
    </Shell>
  );
}

/**
 * Signed in, with no external Solana wallet to be a pension key. Privy ignores
 * login() for a user who is already signed in, so Disconnect is the ONE control
 * that helps here — offering Connect would be a button that does nothing.
 */
export function LiveKeylessCard({ onDisconnect }: { readonly onDisconnect: () => void }) {
  return (
    <Shell title={LIVE_COPY.keylessTitle}>
      <CardHeader>
        <CardTitle className="text-base">{LIVE_COPY.keylessTitle}</CardTitle>
        <CardDescription>{LIVE_COPY.keylessBody}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button type="button" variant="outline" size="sm" onClick={onDisconnect}>
          <LogOut aria-hidden />
          {LIVE_COPY.disconnect}
        </Button>
      </CardContent>
    </Shell>
  );
}

/** This deployment has no Solana configuration, so Live cannot exist here at all. */
export function LiveUnavailableCard({ onConnect, onSeeSample }: { readonly onConnect: () => void; readonly onSeeSample: () => void }) {
  return (
    <Shell title={LIVE_COPY.unavailableTitle}>
      <CardHeader>
        <CardTitle className="text-base">{LIVE_COPY.unavailableTitle}</CardTitle>
        <CardDescription>{LIVE_COPY.unavailableBody}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        {/* Without a configuration this opens the setup checklist, which names what is missing. */}
        <Button type="button" onClick={onConnect}>
          {LIVE_COPY.connect}
        </Button>
        <Button type="button" variant="outline" onClick={onSeeSample}>
          {LIVE_COPY.seeSample}
        </Button>
      </CardContent>
    </Shell>
  );
}

/**
 * Connected, and the chain could not be read. NEVER shown as "no vault": a read
 * that failed says nothing about whether a vault exists, and offering to create
 * one here would ask for a signature the chain must refuse.
 *
 * THE CARD'S OWN SENTENCE IS SAID ONCE. Under the title goes the reason, when
 * there is one beyond it ("Too many requests from this browser just now."),
 * and the card's sentence under that. A vault the snapshot could not read has
 * no reason of its own — the caller passed the card's sentence as the message,
 * and it was printed twice, one line under the other (G10).
 *
 * The retry counts down to when a press reads at once (RetryButton.tsx):
 * `readKey` changes with every read that finishes, which is what moves it.
 */
export function LiveUnreadable({
  message,
  retryAt,
  readKey,
  onRetry,
}: {
  readonly message: string;
  readonly retryAt: number | null;
  /** Changes each time a read finishes, good or failed (RetryButton.tsx readKeyOf). */
  readonly readKey: unknown;
  readonly onRetry: () => void;
}) {
  const readyAt = useReadyAt(readKey);
  const reason = message === "" || message === LIVE_COPY.unreadableBody ? null : message;
  return (
    <Shell title={LIVE_COPY.unreadableTitle}>
      <CardHeader>
        <CardTitle className="text-base">{LIVE_COPY.unreadableTitle}</CardTitle>
        <CardDescription role="status">{reason ?? LIVE_COPY.unreadableBody}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {reason === null ? null : <p className="text-sm text-muted-foreground">{LIVE_COPY.unreadableBody}</p>}
        <div>
          <RetryButton retryAt={retryAt} readyAt={readyAt} onRetry={onRetry} icon />
        </div>
      </CardContent>
    </Shell>
  );
}
