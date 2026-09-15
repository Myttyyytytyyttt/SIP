/**
 * A Solana address on one line: the whole of it (it wraps on a phone rather than
 * hiding characters someone may need to compare), a copy button, and a Solscan
 * link when the string is a real public key.
 *
 * THE CONTROLS STAY BESIDE THE ADDRESS. A 32–44 character address in mono is
 * wider than a phone's card, so it wraps; the address therefore shrinks and wraps
 * inside its own column while the buttons never shrink, instead of the whole row
 * wrapping and leaving the copy button alone on a line below.
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
    <div className={cn("flex min-w-0 items-start gap-1", className)}>
      {/* leading-6 matches the icon buttons' 24px, so the first line and the buttons share a centre. */}
      <Num className="min-w-0 break-all text-sm leading-6">{address}</Num>
      <div className="flex shrink-0 items-center">
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
    </div>
  );
}
