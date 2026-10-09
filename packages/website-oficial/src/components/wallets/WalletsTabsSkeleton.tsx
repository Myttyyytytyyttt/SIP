import { Skeleton } from "@/components/ui/skeleton";
import { WALLETS_SECTIONS } from "@/lib/wallets-sections";

/**
 * THE TABBED SCREEN'S SHAPE, BEFORE IT CAN BE DRAWN: a strip of tabs over the
 * panel below md, a rail beside it from md up.
 *
 * ONE SHAPE FOR THE TWO WAITS ON /wallets. The route's loading.tsx paints it
 * while the server reads the environment, and WalletsScreen paints it again
 * while Privy is not ready yet. When they differed, the page went rail, then
 * full width, then rail again. No hooks and no "use client", so the server
 * route and the client screen can both mount it.
 *
 * IT SAYS WHAT IT WAITS FOR (10-09), in words a sighted person reads: the pulse
 * alone says nothing, and stands still for anyone who asked for less motion.
 * Neither wait is a read of Solana — the server's, then Privy's — so the words
 * claim none. They are hidden from a screen reader, which both hosts already
 * tell (ScreenSkeleton's status line, the route's labelled main): said twice,
 * the one wait would sound like two.
 */

/** Kept here rather than in vault-copy: the server route draws this too, and that module brings the Solana catalogue with it. */
export const WALLETS_LOADING = "Loading your wallets…";

export function WalletsTabsSkeleton() {
  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <div className="flex gap-2 overflow-hidden border-b px-2 pb-1.5 md:w-52 md:shrink-0 md:flex-col md:gap-0.5 md:border-r md:border-b-0 md:p-2 md:pr-1">
        {WALLETS_SECTIONS.map((section) => (
          <Skeleton key={section} className="h-7 w-24 shrink-0 md:h-9 md:w-full" />
        ))}
      </div>
      <div className="min-w-0 flex-1 space-y-4">
        <p aria-hidden="true" className="text-sm text-muted-foreground">
          {WALLETS_LOADING}
        </p>
        <Skeleton className="h-36 w-full rounded-xl" />
        <Skeleton className="h-44 w-full rounded-xl" />
      </div>
    </div>
  );
}
