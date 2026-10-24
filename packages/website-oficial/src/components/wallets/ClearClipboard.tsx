"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { TERMINAL_COPY } from "@/lib/terminal-handoff";

/** How long "Clipboard cleared" stays: the key can be copied again right after, so the label must not outlive the moment. */
export const CLEARED_MS = 2_000;

/** Write nothing over the clipboard. "failed" when there is no clipboard or the browser refused the write. */
export async function clearClipboard(clipboard: Pick<Clipboard, "writeText"> | undefined): Promise<"cleared" | "failed"> {
  if (clipboard === undefined) return "failed";
  try {
    await clipboard.writeText("");
    return "cleared";
  } catch {
    return "failed";
  }
}

/**
 * CLEAR CLIPBOARD, pressed after the paste. A write needs this window's focus
 * (Firefox and Safari also want a press), so it is a button in whichever window
 * the person is looking at: the clipboard is
 * that window's own (the floating guide passes its window's). It says what it
 * cannot reach, and when the browser refused.
 */
export function ClearClipboard({ clipboard }: { readonly clipboard: () => Clipboard | undefined }) {
  const [state, setState] = useState<"idle" | "cleared" | "failed">("idle");
  useEffect(() => {
    if (state !== "cleared") return;
    const timer = setTimeout(() => setState("idle"), CLEARED_MS);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <div className="space-y-1">
      <Button type="button" size="sm" variant="ghost" onClick={() => void clearClipboard(clipboard()).then(setState)}>
        {state === "cleared" ? TERMINAL_COPY.cleared : TERMINAL_COPY.clear}
      </Button>
      <p className="text-muted-foreground">{state === "failed" ? TERMINAL_COPY.clearFailed : TERMINAL_COPY.clearNote}</p>
    </div>
  );
}
