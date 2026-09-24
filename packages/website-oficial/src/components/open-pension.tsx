/**
 * The door back into the app — the whole of what a stranger's bar needs.
 *
 * IT LIVES ALONE FOR A REASON. It used to sit in leaderboard-account.tsx, and
 * that module statically imports the Privy provider: importing this one link
 * from there dragged the entire wallet SDK into the public page's bundle for
 * every reader. Measured: 13 chunks and 810 KB became 29 and 3.5 MB, of which
 * 1.96 MB was a wallet SDK nobody without a session would ever use.
 */

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { urlWithMode, type UrlMode } from "@/lib/dashboard-mode";

/** `mode`: the one the visitor came from, so a stranger who was in the sample goes back to it rather than to the landing. */
export function OpenPension({ returning, mode = null }: { readonly returning: boolean; readonly mode?: UrlMode | null }) {
  return (
    <Button asChild size="sm" variant={returning ? "default" : "outline"}>
      <Link href={mode === null ? "/" : urlWithMode("/", mode)}>{returning ? "Back to my pension" : "Open my pension"}</Link>
    </Button>
  );
}
