// MOTION FOR NOBODY WHO ASKED FOR NONE (10-09, G13). tw-animate-css has no
// reduced-motion handling of its own, and the shared pieces kept moving for
// people whose system asks for less: the skeleton's pulse, every wallet
// spinner, the progress bar's slide, the dialogs' zoom and the sheet's slide.
// Each now moves only under `motion-safe:` (or stops under `motion-reduce:`),
// so at default motion nothing changes by a pixel — and nothing here can lose
// its gate again without this failing.

import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";

/** The files whose motion was gated, from src/components. */
const GATED = [
  "ui/skeleton.tsx",
  "ui/dialog.tsx",
  "ui/sheet.tsx",
  // Three dialogs carry ui/dialog.tsx's classes as a copy of their own.
  "wallets/WalletsModal.tsx",
  "onboarding/OnboardingDialog.tsx",
  "rule-settings-dialog.tsx",
  "wallets/TxProgress.tsx",
  "wallets/TradingWalletRow.tsx",
  "wallets/TradingWalletsCard.tsx",
  "wallets/ImportWalletPanel.tsx",
  "live/LivePending.tsx",
] as const;

/** A class that moves something: a spin, a pulse, an entrance's zoom or slide. */
const MOVES = /(?:^|:)(?:animate-(?:spin|pulse|ping|bounce)|zoom-(?:in|out)-\d+|slide-(?:in-from|out-to)-[a-z]+-\d+)$/;

/** Every class token in a source file that moves something. */
function movingClasses(path: string): string[] {
  const source = readFileSync(new URL(`./${path}`, import.meta.url), "utf8");
  return source.split(/[\s"'`{}()?,]+/).filter((token) => MOVES.test(token));
}

describe("every moving class in the gated files is motion-safe", () => {
  it.each(GATED)("%s", (path) => {
    const moving = movingClasses(path);
    expect(moving.length, "a rename or a rewrite must not make this pass by finding nothing").toBeGreaterThan(0);
    expect(moving.filter((token) => !token.startsWith("motion-safe:"))).toEqual([]);
  });
});

describe("the shared pieces, rendered", () => {
  it("the skeleton pulses only for motion-safe, and keeps its block either way", () => {
    const html = renderToStaticMarkup(createElement(Skeleton, { className: "h-4 w-10" }));
    expect(html).toContain("motion-safe:animate-pulse");
    expect(html).not.toMatch(/class="(?:[^"]* )?animate-pulse/);
    expect(html).toContain("bg-muted");
  });

  it("the progress bar's fill stands at its value under reduced motion instead of sliding to it", () => {
    const html = renderToStaticMarkup(createElement(Progress, { value: 40 }));
    expect(html).toContain("transition-all motion-reduce:transition-none");
  });
});
