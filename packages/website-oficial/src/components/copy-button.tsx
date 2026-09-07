"use client";

import { Check, Copy, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useFlash } from "@/hooks/use-flash";

type Status = "idle" | "copied" | "failed";

const ICON = { idle: Copy, copied: Check, failed: X } as const;
const TEXT = { idle: "Copy", copied: "Copied", failed: "Copy failed" } as const;

/**
 * The one client part of the wallet block: a tiny ghost button that writes
 * `value` to the clipboard and says so for a moment. The clipboard call lives
 * inside the handler only, so the server render never touches `navigator`.
 *
 * A refusal (insecure context, denied permission, no clipboard API) flashes
 * the same way with "Copy failed" — silence would read as success, most of
 * all to someone hearing the live region instead of seeing the icon.
 */
export function CopyButton({ value }: { value: string }) {
  const [on, flash] = useFlash(1500);
  const [outcome, setOutcome] = useState<Exclude<Status, "idle">>("copied");
  const status: Status = on ? outcome : "idle";
  const Icon = ICON[status];

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setOutcome("copied");
    } catch {
      setOutcome("failed");
    }
    flash();
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Copy address"
          onClick={() => void copy()}
        >
          <Icon aria-hidden />
          <span className="sr-only" aria-live="polite">
            {status === "idle" ? "" : TEXT[status]}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{TEXT[status]}</TooltipContent>
    </Tooltip>
  );
}
