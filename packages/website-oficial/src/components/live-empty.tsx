"use client";

import { Info } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useWalletsOpener } from "@/components/wallets-host";

/**
 * LIVE WITH NOTHING IN IT -- which is what Live truly is until a vault exists.
 *
 * Kept for the Solana vault screens, and rendered by nothing until they bring a
 * live loader: today the dashboard shell has no Live mode at all.
 *
 * THE RULE IT EXISTS FOR. A live loader that cannot read a pension must not answer
 * with the seeded example under a control the user set to "Live": that would put
 * a stranger's invented pension under a label promising theirs. The shell renders
 * this instead, with the loader's own reason as `notice` -- one sentence, written
 * once, where the fact is known.
 */
export function LiveEmpty({ notice }: { notice: string | null }) {
  const openWallets = useWalletsOpener();

  return (
    <div className="flex flex-1 items-start justify-center p-4 lg:p-6">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle className="text-base">Nothing saved yet</CardTitle>
          <CardDescription>
            {notice ?? "This pension key has no vault, so there is nothing to show."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Once a vault exists and a trading wallet is bound to it, every buy and sell puts a slice aside and
            it appears here. Nothing is invented in the meantime.
          </p>
          {/* null outside the host — the same guard the header makes. A button
              that cannot open anything is worse than no button. */}
          {openWallets === null ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" onClick={() => openWallets()}>
                Manage wallets
              </Button>
            </div>
          )}
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Switch to Mock to see what a running pension looks like. Those numbers are an example and belong to
            nobody.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
