"use client";

import Image from "next/image";
import { usePrivy } from "@privy-io/react-auth";

import { ModeToggle } from "@/components/mode-toggle";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * WHAT SOMEBODY SEES BEFORE THEY CONNECT: a mark, a sentence, and one button.
 *
 * This replaces a deliberate old behaviour, and the reason is worth keeping.
 * page.tsx used to render the seeded mock to every visitor, arguing that an
 * empty chart "looks broken" and a stranger's numbers would be worse. Both
 * halves of that were right, and this is the third option neither considered:
 * show nothing that could be mistaken for anybody's money, and ask.
 *
 * The sentence is the one the wallets modal already makes (WalletsScreen: "the
 * wallet you connect owns the pension. Only it can withdraw"), because the first
 * thing a person needs to know about a permissionless pension is who can take
 * the money out, and the answer is the reason to connect at all.
 */
export function Landing() {
  const { ready, login } = usePrivy();

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 items-center gap-3 px-4 lg:px-6">
        <span className="flex items-center gap-2 font-semibold tracking-tight">
          <Image src="/logo/sip-mark-white.png" alt="" width={20} height={20} className="dark:invert-0 invert" priority />
          SIP
        </span>
        <span className="hidden text-sm text-muted-foreground sm:inline">Self Implemented Pension</span>
        <div className="ml-auto">
          <ModeToggle />
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 pb-24">
        <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">A pension you keep</h1>
            <p className="text-sm text-muted-foreground">
              A slice of every trade goes into a vault only your own key can open. The team never holds your funds.
            </p>
          </div>

          {/* The skeleton is the same width as the button it becomes, so the
              column does not jump when Privy finishes deciding. */}
          {ready ? (
            <Button type="button" size="lg" className="w-48" onClick={() => login()}>
              Connect
            </Button>
          ) : (
            <Skeleton className="h-10 w-48 rounded-md" />
          )}
        </div>
      </main>
    </div>
  );
}
