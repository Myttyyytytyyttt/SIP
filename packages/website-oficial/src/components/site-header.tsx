"use client";

import { useState } from "react";

import { PanelLeft, X } from "lucide-react";
import Link from "next/link";

import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * The top bar: wordmark, nav, the Live|Mock control, the theme toggle, the
 * account. Below `lg` the sidebar is gone, so the leading button opens whatever
 * that state's sidebar is in a sheet.
 *
 * THE SIDEBAR ARRIVES AS A SLOT, not as mock data. This header used to take a
 * `wallet` and an `activity` array and render the example's feed itself, which
 * meant every state — including a connected person's own pension — had the
 * sample's wallet wired into the header. Now Mock passes the sample's feed, Live
 * passes the real one, and the header knows nothing about either.
 *
 * `account` IS REQUIRED. It used to fall back to the example's fake wallet menu,
 * so a page that forgot to pass one showed a made-up address that looked signed
 * in. There is no fallback: a Privy session exists or it does not.
 */
export function SiteHeader({
  activitySheet,
  control = null,
  contributions = null,
  account,
  current = "pension",
}: {
  /** This state's sidebar, for the sheet below lg. */
  activitySheet: React.ReactNode;
  /** The Live/Mock control. A slot, so the header stays ignorant of what it switches. */
  control?: React.ReactNode;
  /**
   * The last few contributions, for the bar's spare width. SHOWN ONLY AWAY FROM
   * THE PENSION: there the same settlements are already on screen in full, and
   * repeating them in the chrome would be noise. A slot, like everything else
   * here — the header knows nothing about what is in it.
   */
  contributions?: React.ReactNode;
  /** Connect, Disconnect, the pension key, or a placeholder while Privy is asked. */
  account: React.ReactNode;
  readonly current?: "pension" | "activity" | "leaderboard";
}) {
  // THE SHEET IS CONTROLLED SO IT CAN GET OUT OF THE WAY. Below lg this sheet is
  // where "Manage wallets" lives, and a modal opened from inside a sheet is the
  // nested-overlay problem again — two focus traps, and Escape closing the wrong
  // one. So the sheet closes itself first and the host opens the one modal.
  const [sheetOpen, setSheetOpen] = useState(false);

  const nav = [
    { label: "Pension", href: "/", current: current === "pension", className: undefined },
    { label: "Activity", href: "/activity", current: current === "activity", className: undefined },
    // A REAL PAGE, AND A PUBLIC ONE: /leaderboard mounts no Privy provider, so
    // this link works for a visitor who has never connected anything.
    { label: "Leaderboard", href: "/leaderboard", current: current === "leaderboard", className: undefined },
    { label: "Docs", href: "#", current: false, className: undefined },
  ];

  return (
    <header className="sticky top-0 z-40 h-14 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open activity">
              <PanelLeft aria-hidden />
            </Button>
          </SheetTrigger>
          {/* bg-background, not the stock bg-popover: the feed's sticky day headers paint bg-background and would band in dark mode. */}
          <SheetContent side="left" showCloseButton={false} className="gap-0 bg-background p-0 data-[side=left]:w-80">
            {/* Own close row: the stock X sits absolute top-right, over the wallet block's Manage wallets link. First tabbable too, so opening focuses it, not the copy button (whose tooltip would pop). */}
            <SheetHeader className="flex-row items-center justify-between border-b py-2 pl-4 pr-2">
              <SheetTitle className="text-sm">Activity</SheetTitle>
              <SheetClose asChild>
                <Button variant="ghost" size="icon" aria-label="Close activity">
                  <X aria-hidden />
                </Button>
              </SheetClose>
            </SheetHeader>
            <SheetDescription className="sr-only">What this pension did, newest first.</SheetDescription>
            {activitySheet}
          </SheetContent>
        </Sheet>

        <div className="flex items-baseline gap-2">
          <h1 className="font-semibold tracking-tight">SaverFi</h1>
        </div>

        <nav aria-label="Main" className="ml-6 hidden items-center gap-1 md:flex">
          {nav.map((item) => (
            <Button key={item.label} variant="ghost" size="sm" asChild className={cn(item.current ? "text-foreground" : "text-muted-foreground", item.className)}>
              <Link href={item.href} aria-current={item.current ? "page" : undefined}>
                {item.label}
              </Link>
            </Button>
          ))}
        </nav>

        <div className="ml-auto flex min-w-0 items-center gap-2">
          {current === "pension" ? null : contributions}
          {/*
            A RULE AND SOME AIR, so the strip reads as its own thing rather than
            as more buttons. It is drawn only when there is a strip to separate.
          */}
          {current === "pension" || contributions === null ? null : (
            <span aria-hidden className="mx-1 hidden h-5 w-px shrink-0 bg-border md:block" />
          )}
          {control}
          <ModeToggle />
          {account}
        </div>
      </div>
    </header>
  );
}
