// THE SHARE CARD'S FIGURES (owner, 10-22): what the image of a pension says,
// from the Live page's own figures, through the REAL model and adapter — and
// what it must never say: who it belongs to, a figure that names its vault, a
// zero for an unknown, or the code name. A Live page's card is never the
// example; the sample's own card is tested from the sample itself, where the
// dataset may be imported (src/components/sample-share.test.ts).

import { describe, expect, it } from "vitest";

import { formatSol as leaderboardSol } from "@/lib/leaderboard";
import { SHARE_COPY } from "@/lib/live-copy";
import { toDashboardMock } from "@/lib/live-mock";
import type { LiveDashboard } from "@/lib/live-types";
import {
  HERO_ROOM,
  HERO_STEPS,
  SHARE_SITE,
  basketLine,
  defaultUnit,
  fitHero,
  shareAlt,
  shareCaps,
  shareCardOf,
  shareFileName,
  shareHero,
  shareIntentUrl,
  sharePostText,
  shareRows,
  shareWords,
  unitFor,
  unitsOf,
  type ShareCardData,
} from "@/lib/live-share";
import type { SavingsRule } from "@/mocks/types";

import { OWNER, VAULT, WALLET_A, liveDashboard, liveSnapshot } from "../../test/fixtures/live-dashboard";

/** The card exactly as LiveBody builds it. */
const cardOf = (data: LiveDashboard = liveDashboard()): ShareCardData => {
  const page = toDashboardMock(data, { complete: false });
  return shareCardOf({ lifetimeSaved: data.vault.lifetimeSaved, stats: page.stats, rule: page.rule, now: page.now });
};

const withSaved = (lifetimeSaved: string | null, overrides: Parameters<typeof liveSnapshot>[0] = {}): LiveDashboard => {
  const snapshot = liveSnapshot(overrides);
  return liveDashboard({ snapshot: { ...snapshot, vault: { ...snapshot.vault, state: { ...snapshot.vault.state!, lifetimeSaved: lifetimeSaved as string } } } });
};

/** A card with the figures a test needs, the rest the fixture's. */
const card = (overrides: Partial<ShareCardData> = {}): ShareCardData => ({ ...cardOf(), ...overrides });

describe("the card's figures, from the Live page's own", () => {
  it("a pension with savings: today's dollars, the chain's SOL, the rule, the day", () => {
    const shared = cardOf();
    // The fixture: 0.06 SOL at $100.038711.
    expect(shared).toMatchObject({ state: "saved", usdText: "$6.00", solText: "0.06", priced: true, rate: "20%", mode: "profit", paused: false, basket: ["SPYx"] });
    expect(shared.asOf).toBe("Sep 16, 2026");
    expect(shared.day).toBe("2026-09-16");
    expect(shared.since).toBe("Sep 2026");
  });

  it("nothing saved yet is a ZERO card, never a $0.00", () => {
    const shared = cardOf(withSaved("0"));
    expect(shared.state).toBe("zero");
    expect(shared.usdText).toBeNull();
    expect(shareHero(shared, "usd")).toBeNull();
  });

  it("a total nobody could read is UNKNOWN, never zero", () => {
    expect(cardOf(withSaved(null)).state).toBe("unknown");
  });

  it("no price read: no dollars, SOL by default and the only unit, and no note to qualify it", () => {
    const shared = cardOf(liveDashboard({ snapshot: liveSnapshot({ prices: null }) }));
    expect(shared.state).toBe("saved");
    expect(shared.usdText).toBeNull();
    expect(defaultUnit(shared)).toBe("sol");
    expect(unitsOf(shared)).toEqual(["sol"]);
    expect(unitFor(shared, "usd")).toBe("sol");
    expect(shareHero(shared, "usd")).toEqual({ number: "0.06", unit: "SOL", compact: "0.1", note: null });
  });

  it("dollars by default where there is a price (owner, 10-22)", () => {
    expect(defaultUnit(cardOf())).toBe("usd");
    expect(unitsOf(cardOf())).toEqual(["usd", "sol"]);
  });

  it("a positive amount never reads as zero, in either unit", () => {
    const dust = cardOf(withSaved("1000"));
    expect(dust.usdText).toBe("<$0.01");
    expect(dust.solText).toBe("<0.01");
  });

  it("the basket biggest share first; a basket the page qualifies is not stated", () => {
    const rule: SavingsRule = {
      mode: "profit",
      rateBps: 2_000,
      thresholdUsd: null,
      paused: false,
      targets: [
        { symbol: "SPYx", weightBps: 2_500 },
        { symbol: "ANTHROPIC", weightBps: 7_500 },
      ],
    };
    const page = toDashboardMock(liveDashboard(), { complete: false });
    expect(shareCardOf({ lifetimeSaved: 1n, stats: page.stats, rule, now: page.now }).basket).toEqual(["ANTHROPIC", "SPYx"]);
    expect(shareCardOf({ lifetimeSaved: 1n, stats: page.stats, rule: { ...rule, targetsNote: "Applies when buying starts" }, now: page.now }).basket).toEqual([]);
  });
});

describe("a Live page's card is never the example", () => {
  const live: Record<string, LiveDashboard> = {
    saved: liveDashboard(),
    zero: withSaved("0"),
    unknown: withSaved(null),
    noPrice: liveDashboard({ snapshot: liveSnapshot({ prices: null }) }),
    dust: withSaved("1000"),
  };

  it("in every state: no flag, the pension's file name, the first person, and none of the example's words", () => {
    for (const [name, data] of Object.entries(live)) {
      const shared = cardOf(data);
      expect(shared.example, name).toBe(false);
      expect(shareFileName(shared), name).toMatch(/^saverfi-pension-\d{4}-\d{2}-\d{2}\.png$/);
      expect(shareWords(shared).trigger, name).toBe(SHARE_COPY.trigger);
      for (const unit of ["usd", "sol"] as const) {
        const said = [sharePostText(shared, unit), shareAlt(shared, unit), shareHero(shared, unit)?.note ?? "", ...Object.values(shareWords(shared))];
        for (const sentence of said) {
          expect(sentence, name).not.toMatch(/example/i);
          expect(sentence, name).not.toContain(SHARE_COPY.example.note);
        }
      }
    }
  });
});

describe("an example card (the flag's own rules; the sample's figures: sample-share.test.ts)", () => {
  /** What exampleShareCardOf makes of a page with no SOL total: dollars only, flagged. */
  const example = card({ example: true, solText: null, solCompact: null, priced: false, usdText: "$2,073.42", usdCompact: "$2.1K" });

  it("is dollars only, whichever unit is asked for", () => {
    expect(unitsOf(example)).toEqual(["usd"]);
    expect(defaultUnit(example)).toBe("usd");
    expect(unitFor(example, "sol")).toBe("usd");
    for (const unit of ["usd", "sol"] as const) {
      expect(shareHero(example, unit)).toEqual({ number: "$2,073.42", unit: null, compact: "$2.1K", note: SHARE_COPY.example.note });
    }
  });

  it("posts a line about SaverFi, never a figure of somebody's, and says what it is everywhere else", () => {
    for (const unit of ["usd", "sol"] as const) {
      expect(sharePostText(example, unit)).toBe(SHARE_COPY.example.post);
      expect(shareAlt(example, unit)).toBe("Example SaverFi image, nobody’s pension: $2,073.42 saved");
    }
    expect(shareFileName(example)).toBe("saverfi-example-2026-09-16.png");
    expect(shareWords(example)).toMatchObject({ trigger: "Share this example", title: "Share the example" });
    expect(shareWords(example).description).toContain("“Example”");
  });
});

describe("nothing on it identifies anyone", () => {
  it("no vault, wallet or owner in the card, the post, the alt text or the file name", () => {
    const shared = cardOf();
    const everything = [JSON.stringify(shared), sharePostText(shared, "usd"), sharePostText(shared, "sol"), shareAlt(shared, "usd"), shareFileName(shared), shareIntentUrl(sharePostText(shared, "usd"))].join("\n");
    for (const who of [OWNER, VAULT, WALLET_A]) expect(everything).not.toContain(who);
  });

  it("the file is named by the day alone", () => {
    expect(shareFileName(cardOf())).toBe("saverfi-pension-2026-09-16.png");
  });

  /**
   * NO FIGURE THAT IS A KEY TO THE VAULT (review, 10-22): /leaderboard prints
   * each vault's lifetime SOL to four places beside its address, linked to
   * Solscan, so the first card's "11.4207 SOL" named its vault. Neither unit's
   * card, post or description may carry that figure — nor the chain's full one,
   * nor the day the vault was created.
   */
  it("never the leaderboard's figure, the chain's full one, or the vault's creation day", () => {
    const shared = cardOf(withSaved("11420734512"));
    const onTheBoard = leaderboardSol("11420734512");
    expect(onTheBoard).toBe("11.4207");
    expect(shared.solText).toBe("11.42");
    expect(shared.since).toMatch(/^[A-Z][a-z]{2} \d{4}$/);
    const said: string[] = [JSON.stringify(shared)];
    for (const unit of ["usd", "sol"] as const) {
      const hero = shareHero(shared, unit)!;
      said.push(hero.number, hero.compact, hero.note ?? "", sharePostText(shared, unit), shareAlt(shared, unit));
      for (const row of shareRows(shared)) said.push(row.label, row.value, row.after ?? "");
    }
    for (const sentence of said) {
      expect(sentence).not.toContain(onTheBoard);
      expect(sentence).not.toContain("11.420734512");
      // "Sep 16, 2026" is the snapshot's own day (top-right), not the vault's: no other "Mon D," may appear.
      expect(sentence.replaceAll(shared.asOf, "")).not.toMatch(/\b[A-Z][a-z]{2} \d{1,2}, \d{4}\b/);
    }
  });
});

describe("the hero", () => {
  it("in dollars, with what valued them under it — and not the SOL figure", () => {
    expect(shareHero(card({ usdText: "$2,073.42", usdCompact: "$2.1K", solText: "11.42" }), "usd")).toEqual({
      number: "$2,073.42",
      unit: null,
      compact: "$2.1K",
      note: "Saved in SOL, valued at today’s SOL price",
    });
  });

  it("in SOL, with the dollars under it", () => {
    expect(shareHero(card({ usdText: "$2,073.42", solText: "11.42", solCompact: "11.4" }), "sol")).toEqual({
      number: "11.42",
      unit: "SOL",
      compact: "11.4",
      note: "$2,073.42 at today’s SOL price",
    });
  });
});

describe("a figure fits the card's room", () => {
  // Geist Mono's advance is 0.6 em; the figure's tracking takes 0.02 em off each glyph.
  const measure = (text: string, size: number, part: "number" | "unit"): number => text.length * size * (part === "number" ? 0.58 : 0.6);

  it("at the largest step when it can", () => {
    const fit = fitHero(["$2,073.42"], null, 0, measure);
    expect(fit.size).toBe(104);
    expect(fit.blockWidth).toBeLessThanOrEqual(HERO_ROOM);
  });

  it("a long figure steps down, whole", () => {
    const fit = fitHero(["$1,234,567.89", "$1.2M"], null, 0, measure);
    expect(fit.text).toBe("$1,234,567.89");
    expect(fit.size).toBeLessThan(104);
    expect(HERO_STEPS).toContain(fit.size);
    expect(fit.blockWidth).toBeLessThanOrEqual(HERO_ROOM);
  });

  it("only a figure too long at every step falls back to its compact form", () => {
    const fit = fitHero(["$123,456,789,012.34", "$123.5B"], null, 0, measure);
    expect(fit).toMatchObject({ text: "$123.5B", size: 104 });
  });

  it("the SOL unit counts toward the room", () => {
    const bare = fitHero(["6,800.1757"], null, 0, measure);
    const withUnit = fitHero(["6,800.1757"], "SOL", 0, measure);
    expect(withUnit.unitWidth).toBeGreaterThan(0);
    expect(withUnit.blockWidth).toBeLessThanOrEqual(HERO_ROOM);
    expect(withUnit.size).toBeLessThanOrEqual(bare.size);
  });

  it("a card with nothing saved fits the rate AND the words beside it", () => {
    const fit = fitHero(["0.25%"], null, 380, measure);
    expect(fit.blockWidth + 380).toBeLessThanOrEqual(HERO_ROOM);
    expect(fit.size).toBeLessThan(104);
  });
});

describe("the rows", () => {
  it("say the rule as today's, a streak only when it is one, and the basket", () => {
    expect(shareRows(card({ streakDays: 13, basket: ["SPYx", "ANTHROPIC"] }))).toEqual([
      { label: "Saving now", value: "20% of trading gains" },
      { label: "Streak", value: "13 days in a row" },
      { label: "Invests in", value: "SPYx · ANTHROPIC" },
    ]);
    expect(shareRows(card({ streakDays: 1 })).map((row) => row.label)).toEqual(["Saving now", "Invests in"]);
    expect(shareRows(card({ streakDays: null, basket: [] })).map((row) => row.label)).toEqual(["Saving now"]);
  });

  it("word a volume rule as the vault does, and a paused one as a paused rule — not as saving now", () => {
    expect(shareRows(card({ mode: "volume", rate: "2%" }))[0]).toEqual({ label: "Saving now", value: "2% of every buy and sell" });
    expect(shareRows(card({ mode: "volume", rate: "2%", paused: true }))[0]).toEqual({ label: "Rule", value: "2% of every buy and sell", after: " · paused" });
  });

  it("a card with nothing saved says so, quietly", () => {
    expect(shareRows(card({ state: "zero", basket: [] }))).toEqual([{ label: "Saved so far", value: "Nothing yet", muted: true }]);
  });

  it("the basket: three at most, then how many more", () => {
    expect(basketLine(["SPYx", "ANTHROPIC", "NVDAx", "TSLAx"])).toBe("SPYx · ANTHROPIC · NVDAx +1");
    expect(basketLine(["SPYx"])).toBe("SPYx");
  });
});

describe("what leaves the page", () => {
  it("the post names SaverFi and the figure in the chosen unit; X adds saverfi.cash", () => {
    const shared = card({ usdText: "$2,073.42", solText: "11.42" });
    expect(sharePostText(shared, "usd")).toBe("I’ve saved $2,073.42 for my pension with SaverFi so far.");
    expect(sharePostText(shared, "sol")).toBe("I’ve saved 11.42 SOL for my pension with SaverFi so far.");
    expect(sharePostText(card({ state: "zero" }), "usd")).toBe("I’m building my pension with SaverFi: 20% of my trading gains, put aside for later.");
    const url = new URL(shareIntentUrl(sharePostText(shared, "usd")));
    expect(url.origin + url.pathname).toBe("https://x.com/intent/post");
    expect(url.searchParams.get("text")).toBe(sharePostText(shared, "usd"));
    expect(url.searchParams.get("url")).toBe(SHARE_SITE);
    expect(SHARE_SITE).toBe("https://saverfi.cash");
  });

  it("a paused rule with nothing saved puts nothing aside, and the post and the description say no more", () => {
    const paused = card({ state: "zero", paused: true, mode: "volume", rate: "2%" });
    expect(sharePostText(paused, "usd")).toBe("I’m building my pension with SaverFi.");
    expect(shareAlt(paused, "usd")).toBe("Your SaverFi image: 2% of every buy and sell, paused for now");
  });

  it("never the code name", () => {
    for (const shared of [cardOf(), card({ state: "zero" })]) {
      for (const sentence of [sharePostText(shared, "usd"), sharePostText(shared, "sol"), shareAlt(shared, "usd"), shareIntentUrl(sharePostText(shared, "usd"))]) {
        expect(sentence).not.toMatch(/\bSIP\b|nuvem/i);
      }
    }
  });
});

describe("the actions this browser can carry out", () => {
  const canShare = (): boolean => true;

  it("none where there is no clipboard or sheet (a server, an old browser)", () => {
    expect(shareCaps({})).toEqual({ copy: false, share: false });
    expect(shareCaps({ navigator: {} })).toEqual({ copy: false, share: false });
  });

  it("copy where an image can go on the clipboard, and not where the browser says PNG cannot", () => {
    class Item {
      static supports = (type: string): boolean => type === "image/png";
    }
    class NoPng {
      static supports = (): boolean => false;
    }
    const navigator = { clipboard: { write: () => Promise.resolve() } };
    expect(shareCaps({ navigator, ClipboardItem: Item }).copy).toBe(true);
    expect(shareCaps({ navigator, ClipboardItem: class {} }).copy).toBe(true);
    expect(shareCaps({ navigator, ClipboardItem: NoPng }).copy).toBe(false);
  });

  it("the sheet only where it takes a PNG file", () => {
    expect(shareCaps({ navigator: { share: () => Promise.resolve(), canShare }, File }).share).toBe(true);
    expect(shareCaps({ navigator: { share: () => Promise.resolve(), canShare: () => false }, File }).share).toBe(false);
    expect(shareCaps({ navigator: { canShare }, File }).share).toBe(false);
  });
});
