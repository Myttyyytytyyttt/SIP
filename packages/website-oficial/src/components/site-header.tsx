"use client";

import { useState } from "react";

import { PanelLeft, X } from "lucide-react";
import Link from "next/link";

import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { WalletActivity } from "@/components/wallet-activity";
import { useWalletsOpener } from "@/components/wallets-host";
import { WalletMenu } from "@/components/wallet-menu";
import { cn } from "@/lib/utils";
import type { ActivityEvent, Wallet } from "@/mocks";

type NavItem = { label: string; href: string; current: boolean; className?: string };

const NAV: readonly NavItem[] = [
  { label: "Pension", href: "#", current: true },
  // Its target is the aside, which exists only from lg; between md and lg the link would go nowhere (the sheet button is the way in there).
  { label: "Activity", href: "#activity", current: false, className: "hidden lg:inline-flex" },
  { label: "Docs", href: "#", current: false },
];

/**
 * The top bar: wordmark, nav, theme toggle, wallet. Below `lg` the sidebar
 * is gone, so the leading button opens the same WalletActivity in a sheet.
 */
export function SiteHeader({
  wallet,
  activity,
  now,
  control = null,
}: {
  wallet: Wallet;
  activity: readonly ActivityEvent[];
  now: string;
  /** The Live/Mock control. A slot, so the header stays ignorant of what it switches. */
  control?: React.ReactNode;
}) {
  // THE SHEET IS CONTROLLED SO IT CAN GET OUT OF THE WAY. Below lg this sheet is
  // where "Manage wallets" lives, and a modal opened from inside a sheet is the
  // nested-overlay problem again — two focus traps, and Escape closing the wrong
  // one. So the sheet closes itself first and the host opens the one modal.
  const [sheetOpen, setSheetOpen] = useState(false);
  const openWallets = useWalletsOpener();

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
            <SheetDescription className="sr-only">What the wallet did, newest first.</SheetDescription>
            <WalletActivity
              wallet={wallet}
              activity={activity}
              now={now}
              id="activity-sheet"
              className="min-h-0 flex-1"
              {...(openWallets === null
                ? {}
                : {
                    onManageWallets: () => {
                      setSheetOpen(false);
                      openWallets();
                    },
                  })}
            />
          </SheetContent>
        </Sheet>

        <div className="flex items-baseline gap-2">
          <h1 className="font-semibold tracking-tight">SIP</h1>
          <span className="hidden text-xs text-muted-foreground sm:inline">Self Implemented Pension</span>
        </div>

        <nav aria-label="Main" className="ml-6 hidden items-center gap-1 md:flex">
          {NAV.map((item) => (
            <Button
              key={item.label}
              variant="ghost"
              size="sm"
              asChild
              className={cn(item.current ? "text-foreground" : "text-muted-foreground", item.className)}
            >
              <Link href={item.href} aria-current={item.current ? "page" : undefined}>
                {item.label}
              </Link>
            </Button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {control}
          <ModeToggle />
          <WalletMenu wallet={wallet} />
        </div>
      </div>
    </header>
  );
}
