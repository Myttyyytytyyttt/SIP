// Something that comes and goes without shoving the page (Reveal.tsx): no
// animation on the first paint, nothing mounted while closed, and nothing
// usable on its way out.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { HeightSwap, Reveal, RevealFrame, revealFrameClass, revealLook, swapMoves } from "@/components/live/Reveal";

const CARD = createElement("button", { type: "button" }, "Create");

describe("the first paint", () => {
  it("draws what is open simply open: grown, unclipped, usable — nothing to animate from", () => {
    const html = renderToStaticMarkup(createElement(Reveal, { open: true, children: CARD }));
    expect(html).toContain("grid-rows-[1fr] opacity-100");
    expect(html).not.toContain("overflow-hidden");
    expect(html).not.toContain("inert");
    expect(html).not.toContain("aria-hidden");
    expect(html).toContain("Create");
  });

  it("draws nothing at all for what is closed: an empty row would still take the column's gap", () => {
    expect(renderToStaticMarkup(createElement(Reveal, { open: false, children: CARD }))).toBe("");
  });

  it("in a gap-4 column, lets the gap out once open", () => {
    expect(renderToStaticMarkup(createElement(Reveal, { open: true, inGap: true, children: CARD }))).toContain("mt-0");
  });
});

describe("its life, frame by frame", () => {
  it("grows from a collapsed frame when asked to open, and collapses before it goes", () => {
    expect(revealLook(true, "closed")).toBe("collapsed");
    expect(revealLook(true, "closing")).toBe("collapsed");
    expect(revealLook(true, "growing")).toBe("grown");
    expect(revealLook(true, "open")).toBe("grown");
    expect(revealLook(false, "open")).toBe("collapsed");
    expect(revealLook(false, "growing")).toBe("collapsed");
    expect(revealLook(false, "closing")).toBe("collapsed");
    expect(revealLook(false, "closed")).toBe("gone");
  });

  it("on its way out cannot be pressed, focused or read out, and is clipped to its shrinking row", () => {
    const html = renderToStaticMarkup(createElement(RevealFrame, { grown: false, clipped: true, leaving: true, inGap: true, children: CARD }));
    expect(html).toMatch(/^<div[^>]* inert=""/);
    expect(html).toMatch(/^<div[^>]* aria-hidden="true"/);
    expect(html).toContain("grid-rows-[0fr] opacity-0");
    expect(html).toContain("-mt-4");
    expect(html).toContain('class="min-h-0 overflow-hidden"');
  });

  it("stands still under reduced motion: the transition is gated, the end states are the same", () => {
    const html = renderToStaticMarkup(createElement(RevealFrame, { grown: true, clipped: false, leaving: false, inGap: false, children: CARD }));
    expect(html).toContain("motion-reduce:transition-none");
  });
});

describe("joining a page already drawn (appear)", () => {
  it("starts from its collapsed frame, inert, to grow from — where a first paint would be simply open", () => {
    const html = renderToStaticMarkup(createElement(Reveal, { open: true, appear: true, inGap: true, children: CARD }));
    expect(html).toContain("grid-rows-[0fr] opacity-0");
    expect(html).toContain("-mt-4");
    expect(html).toContain('class="min-h-0 overflow-hidden"');
    // Collapsed on its way IN is usable the moment it is grown: not inert, not hidden.
    expect(html).not.toContain("inert");
    expect(html).not.toContain("aria-hidden");
  });

  it("is still nothing when it is not wanted", () => {
    expect(renderToStaticMarkup(createElement(Reveal, { open: false, appear: true, children: CARD }))).toBe("");
  });
});

describe("a box that stays mounted around what comes and goes (revealFrameClass)", () => {
  it("is the Reveal's own frame, so both look the same at every moment", () => {
    const html = renderToStaticMarkup(createElement(RevealFrame, { grown: true, clipped: false, leaving: false, inGap: true, children: CARD }));
    expect(html).toContain(`class="${revealFrameClass({ grown: true, inGap: true })}"`);
  });

  it("drops the transition for the first collapsed frame after nothing, and only for it", () => {
    expect(revealFrameClass({ grown: false, inGap: true, still: true })).toBe("grid grid-rows-[0fr] opacity-0 -mt-4");
    expect(revealFrameClass({ grown: false, inGap: true })).toContain("transition-[grid-template-rows,opacity,margin-top]");
  });
});

describe("one card becoming another (HeightSwap)", () => {
  it("draws its card plainly on the first paint: no held height, no fade", () => {
    const html = renderToStaticMarkup(createElement(HeightSwap, { swapKey: "waiting_first_settlement", children: CARD }));
    expect(html).toBe('<div><div><button type="button">Create</button></div></div>');
  });

  it("moves the box only for a new key, a different height, and motion allowed", () => {
    const before = { key: "waiting_first_settlement", height: 180 };
    expect(swapMoves({ before, key: "active", height: 240, reduced: false })).toBe(true);
    expect(swapMoves({ before, key: "waiting_first_settlement", height: 240, reduced: false })).toBe(false);
    expect(swapMoves({ before, key: "active", height: 180, reduced: false })).toBe(false);
    expect(swapMoves({ before, key: "active", height: 240, reduced: true })).toBe(false);
    // Nothing measured before (the first commit): nothing to move from.
    expect(swapMoves({ before: { key: "no_vault", height: null }, key: "active", height: 240, reduced: false })).toBe(false);
  });
});
