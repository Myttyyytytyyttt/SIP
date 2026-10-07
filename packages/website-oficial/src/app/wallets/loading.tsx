import { Skeleton } from "@/components/ui/skeleton";
import { WalletsTabsSkeleton } from "@/components/wallets/WalletsTabsSkeleton";

/**
 * The route's skeleton while the server reads the environment: the same frame the
 * page paints, with the wallets screen's shape inside it (WalletsTabsSkeleton,
 * which the screen paints again while Privy loads, so nothing jumps between).
 */
export default function WalletsLoading() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 h-14 border-b bg-background/95">
        <div className="flex h-14 items-center gap-3 px-4 lg:px-6">
          <Skeleton className="size-8 rounded-lg" />
          <Skeleton className="h-5 w-24" />
          <Skeleton className="ml-auto size-8 rounded-lg" />
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 p-4 lg:p-6" aria-busy="true" aria-label="Loading">
        <WalletsTabsSkeleton />
      </main>
    </div>
  );
}
