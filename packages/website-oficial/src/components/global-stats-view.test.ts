// The public dashboard as a visitor reads it: the real page never prints a
// figure it could not read, never prints the sample's numbers, and never
// names the machinery; the sample says it is one on every card.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { buildGlobalStats, known, unavailable, type GlobalStatsModel } from "@/lib/global-stats-model";
import { SAMPLE_USDC_RAW_PER_SOL, sampleGlobalStatsBody } from "@/lib/global-stats-sample";
import type { LeaderboardBodyResult } from "@/lib/leaderboard";

// recharts is drawn in the browser; here each chart card is a marker with its id.
vi.mock("@/components/global-stats-chart", () => ({
  StackedBarsCard: (props: { readonly id: string }) => createElement("div", null, `CHART:${props.id}`),
}));

const { GlobalStatsView, heroSol } = await import("@/components/global-stats-view");

const NOW = "2026-10-06T18:30:00.000Z";
const RULES = { participation: 10, sizeFactor: 5, sizeCap: 25, sizeUnit: 1_000_000, streakPerDay: 2, streakCap: 20 };
const SHELF = { offered: ["SPYx", "ANTHROPIC"], listed: 9, symbolOf: { mintA: "SPYx", mintB: "ANTHROPIC" } };

/** Today's production payload: one pension, nine settlements. */
const today = (coverage: Record<string, unknown> = { subjects: 1, settlements: 9, firstDay: "2026-09-19", lastDay: "2026-09-25" }): LeaderboardBodyResult => ({
  ok: true,
  body: {
    computedAt: "2026-10-06T18:27:00.000Z",
    seasonStart: "2026-10-05T00:00:00.000Z",
    unit: "lamports",
    rules: { ahorro: RULES, volumen: RULES },
    coverage,
    boards: {
      total: { season: [], all: [{ rank: 1, subject: "pension-0", points: 1, activeDays: 3, bestStreak: 2, settles: 9, amountRaw: "186400000", volumeRaw: "18975900000" }] },
      ahorro: { season: [], all: [] },
      volumen: { season: [], all: [] },
    },
  },
});

const live = (feed: LeaderboardBodyResult = today(), price = known("150000000")): GlobalStatsModel => buildGlobalStats({ source: "live", feed, price, shelf: SHELF });
const sampleModel = (): GlobalStatsModel =>
  buildGlobalStats({ source: "sample", feed: { ok: true, body: sampleGlobalStatsBody(NOW, ["mintA", "mintB"]) }, price: known(SAMPLE_USDC_RAW_PER_SOL), shelf: SHELF });
const render = (model: GlobalStatsModel): string => renderToStaticMarkup(createElement(GlobalStatsView, { model, now: NOW }));
/** The markup of one card, by its data-card: up to the next card, so a capture can never span two. */
function card(html: string, id: string): string {
  const start = html.indexOf(`data-card="${id}"`);
  if (start === -1) return "";
  const next = html.indexOf('data-card="', start + 1);
  const markup = html.slice(start, next === -1 ? undefined : next);
  expect(markup.match(/data-card="/g)).toHaveLength(1);
  return markup;
}

describe("the live page with today's keeper", () => {
  const html = render(live());

  it("shows the real totals, the traded one as an approximation", () => {
    expect(html).toContain("0.1864");
    expect(html).toContain("Put aside so far");
    expect(html).toContain("≈ $27.96 at today’s SOL price");
    // The "≈" sits right before the figure itself, not anywhere in the card.
    expect(card(html, "traded")).toMatch(/>≈<\/span><span[^>]*>18\.9759<\/span>/);
    expect(html).toContain("Days are UTC");
    expect(html).toContain("Updated 3m ago");
    expect(html).toContain("Settlements from Sep 19, 2026 to Sep 25, 2026");
  });

  it("names what is not published once, with the way to the sample, and draws no empty chart", () => {
    expect(html.match(/Daily charts are not available yet/g)).toHaveLength(1);
    expect(html).toContain('href="/dashboard?mode=mock"');
    expect(html).not.toContain("CHART:");
    expect(html).not.toContain('data-card="invested"');
  });

  it("says nothing about a sample, and shows none of its figures", () => {
    expect(html).not.toMatch(/Sample/);
    const sample = sampleModel();
    const sampleSaved = sample.saved.kind === "known" ? heroSol(sample.saved.value.lamports).text : "unreachable";
    expect(html).not.toContain(sampleSaved);
  });

  it("never names the machinery or the variable behind it", () => {
    expect(html).not.toMatch(/keeper/i);
    expect(html).not.toContain("SIP_SOLANA");
  });
});

describe("what the live page does with what it could not read", () => {
  it("a price it could not read is no dollar line, never $0", () => {
    const html = render(live(today(), unavailable("price-unconfigured")));
    expect(html).toContain("No dollar value: this deployment cannot read the SOL price.");
    expect(html).not.toContain("$");
    expect(html).toContain("0.1864");
  });

  it("a count it could not read is a dash and why, never 0", () => {
    const html = render(live(today({ settlements: 9, firstDay: "2026-09-19", lastDay: "2026-09-25" })));
    const pensions = card(html, "pensions");
    expect(pensions).toContain("—");
    expect(pensions).toContain("This figure was missing from the answer.");
    expect(pensions).not.toMatch(/>0</);
    // And the total it bounds stops claiming to be whole.
    expect(card(html, "saved")).toContain("at least");
  });

  it.each([
    ["source-unconfigured", { ok: false, failure: "unconfigured", detail: "no keeper is configured: set SIP_SOLANA_KEEPER_URL" }],
    ["source-unreachable", { ok: false, failure: "unreachable", detail: "the keeper could not be reached" }],
    ["source-not-ready", { ok: false, failure: "not-ready", detail: "the rankings have not been computed yet" }],
  ] as const)("a source that failed (%s) is one card that says so, and no figure", (reason, feed) => {
    const html = render(live(feed));
    expect(html).toContain(`data-reason="${reason}"`);
    expect(html).toContain("This is not a page of zeros: nothing was read.");
    expect(html).not.toContain("Put aside so far");
    expect(html).not.toMatch(/keeper/i);
    expect(html).not.toContain("SIP_SOLANA");
  });
});

describe("a total the payload cannot prove whole", () => {
  // Three pensions counted, one on the board: the sum is a floor.
  const html = render(live(today({ subjects: 3, settlements: 20, firstDay: "2026-09-19", lastDay: "2026-09-25" })));

  it("says 'at least' on the figure, on its dollars, and drops the 'since' a cut read cannot vouch for", () => {
    const saved = card(html, "saved");
    expect(saved).toMatch(/>at least<\/span><span[^>]*>0\.1864<\/span>/);
    expect(saved).toContain("at least ≈ $27.96 at today’s SOL price");
    expect(saved).toContain("across 3 pensions");
    expect(saved).not.toContain("since");
  });

  it("and when the count itself is a floor, so is the 'across'", () => {
    const old = render(live(today({ subjects: 100, settlements: 900, firstDay: "2024-01-01", lastDay: "2026-09-25" })));
    expect(card(old, "saved")).toContain("across at least 100 pensions");
    expect(card(old, "pensions")).toMatch(/>at least<\/span><span[^>]*>100<\/span>/);
  });
});

describe("the sample", () => {
  const html = render(sampleModel());

  it("is labelled at the top, with the way back to the real figures", () => {
    expect(html).toContain("Sample data");
    expect(html).toContain("Not real pensions.");
    expect(html).toContain('href="/dashboard?mode=live"');
  });

  it("carries a badge on every card, so a screenshot of one still says so", () => {
    for (const id of ["saved", "traded", "pensions", "settlements", "invested", "shelf", "by-mode", "average"]) {
      expect(card(html, id), id).toContain(">Sample<");
    }
  });

  it("draws the four charts and the two single-figure cards", () => {
    for (const id of ["saved", "settlements", "pensions", "invested"]) expect(html).toContain(`CHART:${id}`);
    expect(html).toContain("Profit and Volume");
    expect(html).toContain("Per settlement");
    expect(html).not.toContain("Daily charts are not available yet");
  });

  it("prices its dollars at a sample price, and says so in the sentence", () => {
    expect(html).toMatch(/≈ \$[\d,.]+ at a sample SOL price/);
    expect(html).not.toContain("today’s SOL price");
  });
});

describe("a SOL total on its face", () => {
  it("keeps four places under 1,000 SOL, two under a million, and never reads a positive amount as 0", () => {
    expect(heroSol("186400000")).toEqual({ text: "0.1864", exact: "0.1864 SOL" });
    expect(heroSol("1").text).toBe("<0.0001");
    expect(heroSol("1234567800000").text).toBe("1,234.57");
    expect(heroSol("1234567890000000").text).toBe("1,234,568");
  });
});
