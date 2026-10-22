"use client";

/**
 * THE DOCS' CHROME (owner, 10-22: "una página simple como si fuera GitBook o
 * Mintlify"): a slim bar on top and the index on the left. Client components
 * for two reasons only: which page is current is read from the pathname, so it
 * follows every turn of the page without the layout re-rendering, and the
 * phone's drawer opens and closes.
 *
 * THE BAR IS NOT THE APP'S SiteHeader. That one carries the app's tabs, the
 * account and the Live|Mock control, and every one of them would be a door out
 * of the docs or a wallet SDK loaded to read a page. Here: the mark and the
 * name back to the site, a "Docs" label, "Open the app", and the theme switch
 * last, as in the app.
 *
 * BELOW lg THE INDEX IS A DRAWER, opened from the bar's leading button, the way
 * the app's own sidebar is. It closes as a page is chosen.
 */

import { useState } from "react";

import { Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { DocsNav } from "@/components/docs/docs-nav";
import { ModeToggle } from "@/components/mode-toggle";
import { SipMark } from "@/components/site-footer";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { docSlugOf, type DocSlug } from "@/lib/docs/pages";

function useCurrentDoc(): DocSlug | null {
  return docSlugOf(usePathname());
}

export function DocsTopBar() {
  const current = useCurrentDoc();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 h-14 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-[90rem] items-center gap-2 px-4 lg:px-6">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="-ml-1.5 lg:hidden" aria-label="Open the docs index">
              <Menu aria-hidden />
            </Button>
          </SheetTrigger>
          {/* Own close row, as in the app's header: the stock X would sit over the first group's label. */}
          <SheetContent side="left" showCloseButton={false} className="gap-0 bg-background p-0 data-[side=left]:w-80">
            <SheetHeader className="flex-row items-center justify-between border-b py-2 pr-2 pl-4">
              <SheetTitle className="text-sm">Docs</SheetTitle>
              <SheetClose asChild>
                <Button variant="ghost" size="icon" aria-label="Close the docs index">
                  <X aria-hidden />
                </Button>
              </SheetClose>
            </SheetHeader>
            <SheetDescription className="sr-only">Every page of the SaverFi docs, in reading order.</SheetDescription>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-5">
              <DocsNav current={current} onNavigate={() => setOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>

        <Link
          href="/"
          title="SaverFi — home"
          className="flex shrink-0 items-center gap-2 rounded-md font-semibold tracking-tight outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <SipMark className="h-5 w-auto" />
          <span>SaverFi</span>
        </Link>
        <Separator orientation="vertical" className="mx-1 h-5 data-vertical:self-center" />
        <span className="text-sm font-medium text-muted-foreground">Docs</span>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button size="sm" asChild>
            <Link href="/">Open the app</Link>
          </Button>
          <ModeToggle />
        </div>
      </div>
    </header>
  );
}

/** The index as the desktop's left column shows it; the column itself (sticky, scrolling on its own) is the layout's. */
export function DocsSidebar() {
  return <DocsNav current={useCurrentDoc()} />;
}
