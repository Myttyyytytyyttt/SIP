/**
 * A SIGNATURE THE PAGE DOES NOT SHOW YET, IN ONE LINE (10-09, plan B4):
 * "Vault created · reading it from Solana…" where the next-step card's Create
 * stood, "Signed · updating your pension…" on the first-buy card once its
 * success line is gone — a turning mark while an update may bring it, and past
 * the cap the still clock and "Signed at 14:32 UTC · not on this page yet"
 * (last-write-context.ts). The words say the state; the mark is decoration,
 * and stands still for reduced motion.
 *
 * NOT A LIVE REGION. What landed was said by the success line that announced
 * it; this only stands in for the button that would sign it again.
 */

import { WorkMark } from "@/components/live/WorkMark";
import { syncWords, type WriteSync } from "@/components/live/last-write-context";
import { cn } from "@/lib/utils";

export function SyncLine({ sync, syncing, className }: { readonly sync: WriteSync; readonly syncing: string; readonly className?: string }) {
  const late = sync.state === "late";
  return (
    <p className={cn("flex items-center gap-2 text-sm text-muted-foreground", className)} data-syncing={sync.state}>
      <WorkMark state={late ? "slow" : "syncing"} tile={false} />
      {/* Dated against this browser's day: the landing is this browser's moment, not the snapshot's. */}
      <span>{syncWords(sync, syncing, Date.now())}</span>
    </p>
  );
}
