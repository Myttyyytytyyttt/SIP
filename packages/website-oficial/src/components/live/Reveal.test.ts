// Something that comes and goes without shoving the page (Reveal.tsx): no
// animation on the first paint, nothing mounted while closed, and nothing
// usable on its way out.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Reveal, RevealFrame, revealLook } from "@/components/live/Reveal";

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
