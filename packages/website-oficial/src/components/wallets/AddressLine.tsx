/**
 * A Solana address on one line: the whole of it (it wraps on a phone rather than
 * hiding characters someone may need to compare), a copy button, and a Solscan
 * link when the string is a real public key.
 */

import { solscanAccount } from "@sip/solana-core/client";
import { ExternalLink } from "lucide-react";

import { CopyButton } from "@/components/copy-button";
import { Num } from "@/components/num";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function AddressLine({ address, className }: { address: string; className?: string }) {
  const explorer = solscanAccount(address);

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-1", className)}>
      <Num className="min-w-0 break-all text-sm">{address}</Num>
      <CopyButton value={address} />
      {explorer !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-xs" asChild>
              <a href={explorer} target="_blank" rel="noreferrer" aria-label="View on Solscan">
                <ExternalLink aria-hidden />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent>View on Solscan</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
