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

import { Info, LogOut, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LIVE_COPY } from "@/lib/live-copy";
import { cn } from "@/lib/utils";

/** Seconds until `at`, for a countdown; null when there is nothing to count down to. */
export function secondsUntil(at: number | null, now: number): number | null {
  if (at === null) return null;
  const left = Math.ceil((at - now) / 1_000);
  return left > 0 ? left : null;
}

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
 * Live, with nobody connected. The one state a visitor reaches by choosing Live
 * from the navbar, so it has to say what Live would show without showing any of it.
 */
export function LiveConnectCard({
  onConnect,
  onSeeSample,
  failure = null,
  disabled = false,
}: {
  readonly onConnect: () => void;
  readonly onSeeSample: () => void;
  /** Privy's own refusal, in words. Closing its dialog is not a failure. */
  readonly failure?: string | null;
  readonly disabled?: boolean;
}) {
  return (
    <Shell title={LIVE_COPY.connectTitle}>
      <CardHeader>
        <CardTitle className="text-base">{LIVE_COPY.connectTitle}</CardTitle>
        <CardDescription>{LIVE_COPY.connectBody}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={onConnect} disabled={disabled}>
            {LIVE_COPY.connectButton}
          </Button>
          <Button type="button" variant="outline" onClick={onSeeSample}>
            {LIVE_COPY.seeSample}
          </Button>
        </div>
        {failure !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {LIVE_COPY.connectFootnote}
        </p>
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
 */
export function LiveUnreadable({
  message,
  retryAt,
  now,
  onRetry,
}: {
  readonly message: string;
  readonly retryAt: number | null;
  readonly now: number;
  readonly onRetry: () => void;
}) {
  const left = secondsUntil(retryAt, now);
  return (
    <Shell title={LIVE_COPY.unreadableTitle}>
      <CardHeader>
        <CardTitle className="text-base">{LIVE_COPY.unreadableTitle}</CardTitle>
        <CardDescription role="status">{message === "" ? LIVE_COPY.unreadableBody : message}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{LIVE_COPY.unreadableBody}</p>
        <div>
          <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={left !== null}>
            <RefreshCw aria-hidden />
            {left === null ? LIVE_COPY.retry : LIVE_COPY.retryIn(left)}
          </Button>
        </div>
      </CardContent>
    </Shell>
  );
}
