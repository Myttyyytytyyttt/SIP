// One mark for work in flight (WorkMark.tsx): which glyph each state wears,
// which ones turn and only for motion-safe, and that the glyph is never the only
// thing that says what it means.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WorkMark, type WorkState } from "@/components/live/WorkMark";
import { TONE_TILE } from "@/lib/classes";

const html = (props: Parameters<typeof WorkMark>[0]): string => renderToStaticMarkup(createElement(WorkMark, props));

describe("the glyph each state wears", () => {
  it.each([
    ["active", "lucide-loader-circle"],
    ["syncing", "lucide-loader-circle"],
    ["held", "lucide-pause"],
    ["slow", "lucide-clock"],
    ["gated", "lucide-hourglass"],
    ["done", "lucide-check"],
  ] as const satisfies readonly (readonly [WorkState, string])[])("%s → %s", (state, glyph) => {
    const out = html({ state });
    expect(out).toContain(glyph);
    expect(out).toContain(`data-work-mark="${state}"`);
    // Decoration: what it means is in the words beside it.
    expect(out).toMatch(/<svg[^>]*aria-hidden="true"/);
  });
});

describe("what turns", () => {
  it("turns only work under way, and only for motion-safe; under reduced motion a faint ring stands in", () => {
    const out = html({ state: "active" });
    expect(out).toMatch(/<svg[^>]*class="[^"]*motion-safe:animate-spin[^"]*"[^>]*data-work-loader=""/);
    expect(out).not.toMatch(/class="[^"]*(?<!motion-safe:)animate-spin/);
    expect(out).toContain("motion-reduce:ring-1 motion-reduce:ring-current/30");
  });

  it("stands every resting state still, with no ring", () => {
    for (const state of ["held", "slow", "gated", "done"] as const) {
      const out = html({ state });
      expect(out).not.toContain("animate-spin");
      expect(out).not.toContain("ring-1");
      expect(out).not.toContain("data-work-loader");
    }
  });

  it("stills a loader the page is no longer sure of, and drops its ring", () => {
    const out = html({ state: "active", still: true });
    expect(out).toContain('data-work-loader="still"');
    expect(out).not.toContain("animate-spin");
    expect(out).not.toContain("ring-1");
  });
});

describe("tone and size", () => {
  it("is the machinery's grey unless told otherwise, and a buy's blue when it is one", () => {
    expect(html({ state: "active" })).toContain(TONE_TILE.quiet);
    expect(html({ state: "active", tone: "invest" })).toContain(TONE_TILE.invest);
  });

  it("draws the row's 32 px square, or a bare 14 px glyph for a label's line", () => {
    expect(html({ state: "held" })).toMatch(/^<span class="relative flex size-8 /);
    const inline = html({ state: "gated", tile: false });
    expect(inline).toMatch(/^<svg[^>]*class="[^"]*size-3\.5/);
    expect(inline).not.toContain("size-8");
  });
});
