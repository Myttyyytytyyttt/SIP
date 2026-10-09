// The live page's marks in globals.css (10-09): the wash on a new row, the
// breathing dot, the one ping. Three rules keep them honest:
//
//   - every one of them that moves stands still under reduced motion;
//   - only the wash and the ping paint (a background or a box-shadow), and both
//     are children of their own, never a class on a host whose focus ring or
//     hover ground an unlayered rule would override;
//   - the sample's entrance, `.rise-in`, is the very bytes it was before them.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const CSS = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

interface Rule {
  readonly selector: string;
  readonly body: string;
  /** The at-rules it sits inside, outermost first. */
  readonly within: readonly string[];
}

/** Every rule with declarations, with the at-rules around it. Comments go first; nothing here nests deeper than @media. */
function rules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "{") {
      const prelude = text.slice(start, index).trim();
      if (prelude.startsWith("@") && !prelude.startsWith("@keyframes")) {
        stack.push(prelude);
        start = index + 1;
        continue;
      }
      // A rule (or a whole @keyframes block): its body runs to the matching brace.
      let depth = 1;
      let end = index + 1;
      while (depth > 0 && end < text.length) {
        if (text[end] === "{") depth += 1;
        else if (text[end] === "}") depth -= 1;
        end += 1;
      }
      out.push({ selector: prelude, body: text.slice(index + 1, end - 1), within: [...stack] });
      index = end - 1;
      start = end;
    } else if (char === "}") {
      stack.pop();
      start = index + 1;
    } else if (char === ";") {
      // A statement (an @import, a theme variable): never part of a selector.
      start = index + 1;
    }
  }
  return out;
}

const REDUCED = "@media (prefers-reduced-motion: reduce)";
const ALL = rules(CSS);
const LIVE = ALL.filter((rule) => rule.selector.includes(".live-"));
/** A property set in a body: `animation` itself, not `animation-play-state`. */
const sets = (body: string, property: string): boolean => new RegExp(`(?:^|[;\\s])${property}\\s*:`).test(body);
/** The `.live-*` classes a selector names. */
const liveClasses = (selector: string): string[] => selector.match(/\.live-[a-z-]+/g) ?? [];

describe("the live marks", () => {
  it("are there to check, so a rename cannot make this pass by finding nothing", () => {
    expect(LIVE.map((rule) => rule.selector)).toEqual(expect.arrayContaining([".live-wash", ".live-breathe", ".live-ping"]));
  });

  it("each stand still under reduced motion", () => {
    const moving = new Set(LIVE.filter((rule) => !rule.within.includes(REDUCED) && sets(rule.body, "animation")).flatMap((rule) => liveClasses(rule.selector)));
    expect([...moving].sort()).toEqual([".live-breathe", ".live-ping", ".live-wash"]);
    const stilled = new Set(
      LIVE.filter((rule) => rule.within.includes(REDUCED) && (/animation\s*:\s*none/.test(rule.body) || /display\s*:\s*none/.test(rule.body))).flatMap((rule) =>
        liveClasses(rule.selector),
      ),
    );
    for (const name of moving) expect(stilled.has(name), name).toBe(true);
  });

  it("leave a still equivalent of the wash under reduced motion: a tint, not nothing", () => {
    const wash = LIVE.find((rule) => rule.within.includes(REDUCED) && rule.selector === ".live-wash");
    expect(wash?.body).toMatch(/background-color\s*:\s*color-mix/);
  });

  it("paint only from the wash and the ping, never from a class on a host", () => {
    const painting = LIVE.filter((rule) => !rule.selector.startsWith("@keyframes") && (sets(rule.body, "background") || sets(rule.body, "background-color") || sets(rule.body, "box-shadow")));
    expect(painting.length).toBeGreaterThan(0);
    for (const rule of painting) {
      const subject = rule.selector.trim().split(/\s+/).at(-1) ?? "";
      expect(subject, rule.selector).toMatch(/^\.live-(?:wash|ping)(?:\[[^\]]*\])*$/);
    }
  });

  it("step the wash's edge aside while its host has keyboard focus, in every motion mode, so the inset ring stays whole", () => {
    const aside = LIVE.find((rule) => rule.selector === ":focus-visible > .live-wash");
    expect(aside?.within).toEqual([]);
    expect(aside?.body).toMatch(/box-shadow\s*:\s*none/);
    // Never display:none: on blur the fade would start over, a second and false arrival.
    expect(aside?.body).not.toMatch(/display\s*:/);
  });

  it("wait under the tab loader, as rise-in does", () => {
    expect(LIVE.some((rule) => rule.selector === ":root[data-turning] .live-wash" && /animation-play-state\s*:\s*paused/.test(rule.body))).toBe(true);
  });
});

describe("the sample's entrance", () => {
  it("is byte for byte what it was before the live marks", () => {
    expect(CSS).toContain(RISE_IN);
  });
});

/** globals.css's rise-in block and its reduced-motion block at 4ab56ae, before the live marks arrived. */
const RISE_IN = `/* THE ENTRANCE: each block rises a few pixels into place as it fades in — a
   slow, small movement, and staggered, so a page arrives rather than appears.
   \`backwards\` keeps a delayed block invisible until its turn, and lets go once
   it has arrived: a block left holding a transform would trap anything fixed
   inside it. Under the tab loader it waits (route-loader.tsx sets
   data-turning), so the page arrives as the loader lifts, not behind it. */
@keyframes rise-in {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.99);
  }
}
.rise-in {
  animation: rise-in 600ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
  animation-delay: var(--rise, 0ms);
}
:root[data-turning] .rise-in {
  animation-play-state: paused;
}
.rise-d1 { --rise: 70ms; }
.rise-d2 { --rise: 140ms; }
.rise-d3 { --rise: 210ms; }

/* Motion is decoration here, never information: none at all for whoever asked for none. */
@media (prefers-reduced-motion: reduce) {
  .rise-in,
  .app-loader-ring,
  .app-loader-mark {
    animation: none;
  }
}
`;
