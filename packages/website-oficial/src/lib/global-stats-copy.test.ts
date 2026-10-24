// Every sentence the public dashboard says: the public name, the page's own
// vocabulary, and the promises a total may not make.

import { describe, expect, it } from "vitest";

import { GLOBAL_STATS_COPY } from "@/lib/global-stats-copy";

/** Every string the object can produce: its literals, and each function called with arguments that fit it. */
function everySentence(): string[] {
  const out: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === "string") out.push(value);
    else if (typeof value === "function") {
      const fn = value as (...args: unknown[]) => unknown;
      // Every copy function here takes already-formatted strings, or a count; a count of 1 reaches the singular.
      for (const sentence of [fn("ARG1", "ARG2"), fn(1)]) if (typeof sentence === "string") out.push(sentence);
    } else if (value !== null && typeof value === "object") for (const entry of Object.values(value)) walk(entry);
  };
  walk(GLOBAL_STATS_COPY);
  return out;
}

describe("the dashboard's copy", () => {
  const sentences = everySentence();

  it("has sentences to check, so a rename cannot make this pass by finding nothing", () => {
    expect(sentences.length).toBeGreaterThan(60);
  });

  it("carries the public name and never the old one", () => {
    expect(sentences.some((sentence) => sentence.includes("SaverFi"))).toBe(true);
    expect(sentences.filter((sentence) => /\bSIP\b/i.test(sentence) || /nuvem/i.test(sentence))).toEqual([]);
  });

  it("says pensions and settlements, never the machinery behind them", () => {
    expect(sentences.filter((sentence) => /\bkeeper\b/i.test(sentence) || /vault/i.test(sentence) || /\bPDA\b/.test(sentence))).toEqual([]);
  });

  it("calls an amount traded 'in buys and sells': 'Volume' is only ever the mode's name", () => {
    expect(sentences.filter((sentence) => /\bvolume\b/.test(sentence))).toEqual([]);
  });

  it("never puts a dollar on screen without a hover that says which price made it", () => {
    // The dollar value is a figure; the price that made it is its hover (owner, 10-24: no subtext).
    expect(GLOBAL_STATS_COPY.dollars("$27.96")).toBe("≈ $27.96");
    expect(GLOBAL_STATS_COPY.atLeastDollars("$27.96")).toBe("at least ≈ $27.96");
    expect(GLOBAL_STATS_COPY.dollarsHint).toBe("At today’s SOL price, not what it was worth on the day");
    expect(GLOBAL_STATS_COPY.sampleDollarsHint).toBe("At a sample SOL price");
    // Nothing else carries a dollar sign: every series and every other figure is in SOL or USDC.
    expect(sentences.filter((sentence) => sentence.includes("$"))).toEqual([]);
  });

  it("names the zone wherever it names days: the hover of the dates under the title, and of the strip's day", () => {
    for (const sentence of [GLOBAL_STATS_COPY.daysUtc, GLOBAL_STATS_COPY.strip.todayIsUtc]) expect(sentence, sentence).toMatch(/UTC/);
  });

  it("says nothing under a title or a figure: no description, caption or footnote is left to print", () => {
    // The kinds of sentence the owner asked to go (10-24). A caveat that must stay is a `hint` (a hover) or, on three cards, an `info` (a "?").
    const keys: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (value !== null && typeof value === "object") for (const [key, entry] of Object.entries(value)) walk(entry, path === "" ? key : `${path}.${key}`);
      else keys.push(path);
    };
    walk(GLOBAL_STATS_COPY, "");
    expect(keys.filter((key) => /(^|\.)(subtitle|description|caption|footnote|sampleFootnote|body|provenance|sheet)$/.test(key))).toEqual([]);
    expect(keys.filter((key) => /(^|\.)info$/.test(key)).sort()).toEqual(["leaders.info", "saved.info", "traded.info"]);
  });

  it("labels the sample as a sample", () => {
    expect(GLOBAL_STATS_COPY.sampleBadge).toMatch(/Sample/);
    expect(GLOBAL_STATS_COPY.sampleCardBadge).toMatch(/Sample/);
    expect(GLOBAL_STATS_COPY.sampleNotice).toMatch(/Not real pensions/);
  });

  it("has a reason for every way a figure can be missing, worded for a visitor", () => {
    const reasons = Object.values(GLOBAL_STATS_COPY.reason);
    expect(reasons).toHaveLength(10);
    for (const reason of reasons) {
      expect(reason.length).toBeGreaterThan(10);
      // No status codes, no variable names, no addresses.
      expect(reason, reason).not.toMatch(/\d|SIP_|https?:/);
    }
  });
});
