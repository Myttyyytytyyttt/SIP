import { Skeleton } from "@/components/ui/skeleton";

/** The route's skeleton while the server reads the environment: the same frame the page paints. */
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
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-4 p-4 lg:p-6" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-36 w-full rounded-xl" />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </main>
    </div>
  );
}
