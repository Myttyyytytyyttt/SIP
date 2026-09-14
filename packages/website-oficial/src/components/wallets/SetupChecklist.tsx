/**
 * WHAT IS MISSING, IN ONE LIST — rendered in two containers.
 *
 * `loadConfig` collects every problem instead of throwing on the first, so the
 * operator fixes the whole environment in one pass. This is that list, and
 * NOTHING ELSE: no card, no heading, no "not configured" sentence. The /wallets
 * route wraps it in a Card whose header says so; the dashboard modal wraps it in
 * a Dialog whose header says so. A component that painted its own title would
 * have printed it twice inside the modal.
 *
 * Plain, no "use client": it renders text. That is what lets the server
 * component and the client modal share it.
 *
 * Keyed by position as well as variable: one variable can carry several
 * problems (one per bad SIP_SOLANA_RPC_URLS entry), and the list never reorders.
 */

import { Num } from "@/components/num";
import type { ConfigProblem } from "@/lib/config";

export function SetupChecklist({ problems }: { problems: readonly ConfigProblem[] }) {
  return (
    <ol className="space-y-3 text-sm">
      {problems.map((problem, index) => (
        <li key={`${index}:${problem.variable}`} className="space-y-0.5">
          <div>
            <Num className="font-medium">{problem.variable}</Num> — {problem.message}
          </div>
          <div className="text-xs text-muted-foreground">{problem.howToFix}</div>
        </li>
      ))}
    </ol>
  );
}
