// The latency the ceiling bench injects: the same milliseconds every run, and
// the shape it was asked for.
//
// WHY EITHER PROPERTY MATTERS. A bench exists to be compared against itself —
// this change against last week's — and a sampler that draws differently every
// run cannot answer "did that help?". And a sampler whose p90 is not the p90 it
// was given is a bench reporting a tail nobody chose, which for a SEQUENTIAL
// sweep is most of the answer: the difference between a fleet that fits the
// window and one that does not is largely the tail.

import { describe, expect, it } from "vitest";
import { createLatency, mulberry32 } from "../src/bench/latency.js";
import { percentileMs } from "../src/sweep-cost.js";

const draws = (p50Ms: number, p90Ms: number, seed: number, count: number): number[] => {
  const sampler = createLatency({ p50Ms, p90Ms }, seed);
  return Array.from({ length: count }, () => sampler.next());
};

describe("the ceiling bench's injected latency", () => {
  it("is the same sequence for the same seed, and a different one for a different seed", () => {
    expect(draws(86, 122, 7, 50)).toEqual(draws(86, 122, 7, 50));
    expect(draws(86, 122, 7, 50)).not.toEqual(draws(86, 122, 8, 50));
  });

  it("is a constant when the p90 equals the p50 — which is what a flat bench asks for", () => {
    expect(new Set(draws(40, 40, 3, 100))).toEqual(new Set([40]));
  });

  it("lands on the p50 and the p90 it was given, which is the whole reason it is a distribution", () => {
    // The measured public-endpoint shape: 86.3 ms median against 122.4 ms at p90.
    const sample = draws(86.3, 122.4, 11, 20_000);
    const p50 = percentileMs(sample, 0.5)!;
    const p90 = percentileMs(sample, 0.9)!;
    expect(p50).toBeGreaterThan(86.3 * 0.95);
    expect(p50).toBeLessThan(86.3 * 1.05);
    expect(p90).toBeGreaterThan(122.4 * 0.95);
    expect(p90).toBeLessThan(122.4 * 1.05);
    // AND IT IS A TAIL, not a spread around the median: a lognormal's mean sits
    // above its median, and the sum of a few hundred of these is what fills a
    // sweep. A symmetric sampler would under-report every sweep in the table.
    const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
    expect(mean).toBeGreaterThan(p50);
    expect(Math.max(...sample)).toBeGreaterThan(p90);
  });

  it("never draws a negative call, however long the tail", () => {
    expect(draws(5, 400, 2, 5_000).every((ms) => ms > 0)).toBe(true);
  });

  it("refuses a p90 below its p50 rather than quietly swapping them", () => {
    expect(() => createLatency({ p50Ms: 120, p90Ms: 80 }, 1)).toThrow(/p90Ms must be/);
    expect(() => createLatency({ p50Ms: -1, p90Ms: 80 }, 1)).toThrow(/p50Ms must be/);
  });

  it("draws from mulberry32, which is deterministic and stays inside [0, 1)", () => {
    const first = Array.from({ length: 200 }, mulberry32(42));
    expect(first).toEqual(Array.from({ length: 200 }, mulberry32(42)));
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(new Set(first).size).toBeGreaterThan(190);
  });
});
