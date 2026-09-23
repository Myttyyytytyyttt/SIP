// A FIGURE IS SET, NEVER SHORTENED.
//
// The live panel read like a ledger dump beside the sample because nine-decimal
// lamports were printed at one weight in every column. The fix sets the tail
// smaller — it must NOT be allowed to become a rounding, which is what this
// file is here to stop: for every input, the text a reader sees is character
// for character the text that went in.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Figure } from "@/components/live/Figure";

/** What a person actually reads: the markup with its tags taken away. */
const text = (value: string, keep?: number): string =>
  renderToStaticMarkup(createElement(Figure, keep === undefined ? { children: value } : { children: value, keep }))
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;/g, "'");

const html = (value: string): string => renderToStaticMarkup(createElement(Figure, { children: value }));

describe("nothing is lost", () => {
  it("reads back exactly what it was given", () => {
    for (const value of ["0.036634582", "1.723287901 SOL", "1,234.567890123", "0.1", "5", "—", "", "0.00000001", "+0.036634582 SOL", "−0.5 SOL"]) {
      expect(text(value), value).toBe(value);
    }
  });

  /** The whole point: a tail is a size, so a reader can still check Solscan. */
  it("keeps the digits past the cut on the page rather than in a tooltip", () => {
    expect(html("0.036634582")).toContain("34582");
    expect(html("0.036634582")).not.toContain("title=");
    expect(html("0.036634582")).not.toContain("…");
  });
});

describe("what steps down, and what does not", () => {
  it("keeps four decimals at full size and drops only the rest", () => {
    const markup = html("0.036634582");
    expect(markup).toContain("0.0366");
    expect(markup).toMatch(/<span class="text-\[0\.85em\]">34582<\/span>/);
  });

  /**
   * THE UNIT IS NOT PART OF THE NUMBER. A cut measured from the decimal point
   * lands mid-figure, so a naive split shrank the word too — "0.0366·34582 SOL"
   * with a 10px SOL reads as a typo, not as a smaller unit.
   */
  it("returns the unit word to full size after the digits", () => {
    const markup = html("1.723287901 SOL");
    expect(markup).toMatch(/<span class="text-\[0\.85em\]">87901<\/span> SOL/);
  });

  it("leaves a figure that is already short as one plain span", () => {
    expect(html("0.1 SOL")).toBe('<span>0.1 SOL</span>');
    expect(html("5")).toBe("<span>5</span>");
  });

  /** Commas group the whole part; the cut is measured from the point regardless. */
  it("measures the cut from the decimal point, not from the start", () => {
    expect(html("1,234.567890123")).toContain("1,234.5678");
    expect(html("1,234.567890123")).toContain(">90123<");
  });

  it("takes a different keep when a caller asks for one", () => {
    expect(html("0.036634582")).toContain("0.0366");
    expect(text("0.036634582", 2)).toBe("0.036634582");
    expect(renderToStaticMarkup(createElement(Figure, { children: "0.036634582", keep: 2 }))).toContain(">6634582<");
  });
});
