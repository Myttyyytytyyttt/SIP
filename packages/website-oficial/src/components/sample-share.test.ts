// THE SAMPLE'S SHARE BUTTON (owner, 10-22: "en el mock también puede aparecer
// pero con los datos del mock claro"): the Live page's button and dialog, fed
// the card of the sample's OWN figures — and that card says it is the example
// everywhere it can be seen or posted: on the image (share-canvas.test.ts), in
// the dialog, in the post and in the file's name. Here, because this is where
// the dataset may be imported (no-mock-import.test.ts keeps it out of live/ and
// lib/live-*).

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ShareSavings } from "@/components/live/ShareSavings";
import { SharePanel } from "@/components/live/SharePanel";
import { TooltipProvider } from "@/components/ui/tooltip";
import { dateLabel, monthLabel, usd } from "@/lib/format";
import { SHARE_COPY } from "@/lib/live-copy";
import {
  SHARE_SITE,
  defaultUnit,
  exampleShareCardOf,
  shareAlt,
  shareFileName,
  shareHero,
  shareIntentUrl,
  sharePostText,
  shareRows,
  shareWords,
  unitFor,
  unitsOf,
} from "@/lib/live-share";
import { mock } from "@/mocks";

/** The card exactly as MockBody builds it (dashboard-shell.tsx). */
const card = exampleShareCardOf({ stats: mock.stats, rule: mock.rule, now: mock.now });

describe("the sample's card, from the sample's own figures", () => {
  it("is the hero's dollars, the rule card's rule and basket, the sample's day — and flagged as the example", () => {
    expect(card).toMatchObject({
      example: true,
      state: "saved",
      usdText: usd(mock.stats.totalSavedUsd),
      rate: "1%",
      mode: "volume",
      paused: false,
      basket: ["SPYx", "ANTHROPIC"],
      streakDays: mock.stats.currentStreakDays,
      asOf: dateLabel(mock.now),
      day: mock.now.slice(0, 10),
      since: monthLabel(mock.stats.firstSaveAt!),
    });
    expect(shareRows(card)[0]).toEqual({ label: "Saving now", value: "1% of every buy and sell" });
  });

  it("has no SOL: the sample has no SOL total, and none is made up for it", () => {
    expect(mock.stats.totalSavedSol).toBeUndefined();
    expect(card).toMatchObject({ solText: null, solCompact: null, priced: false });
    expect(unitsOf(card)).toEqual(["usd"]);
    expect(defaultUnit(card)).toBe("usd");
    expect(unitFor(card, "sol")).toBe("usd");
    expect(shareHero(card, "sol")).toEqual(shareHero(card, "usd"));
    // Under the figure, where a live card says what valued it: that it is nobody's.
    expect(shareHero(card, "usd")?.note).toBe("Example numbers. Nobody’s pension.");
  });

  it("posts a line about SaverFi — no \"my pension\", no \"I've saved\", no figure of anybody's", () => {
    for (const unit of ["usd", "sol"] as const) {
      const post = sharePostText(card, unit);
      expect(post).toBe("SaverFi: a pension that builds itself from your Solana trading.");
      expect(post).not.toMatch(/\bmy\b|\bI[’']|\bI\b/i);
      expect(post).not.toContain(card.usdText!);
      const url = new URL(shareIntentUrl(post));
      expect(url.searchParams.get("url")).toBe(SHARE_SITE);
    }
  });

  it("describes the image as the example, and names the file so", () => {
    expect(shareAlt(card, "usd")).toBe(`Example SaverFi image, nobody’s pension: ${card.usdText} saved`);
    expect(shareFileName(card)).toBe(`saverfi-example-${mock.now.slice(0, 10)}.png`);
  });

  it("carries nothing of the sample's made-up wallet either", () => {
    const everything = [JSON.stringify(card), sharePostText(card, "usd"), shareAlt(card, "usd"), shareFileName(card)].join("\n");
    expect(everything).not.toContain(mock.wallet!.address);
  });
});

describe("the sample's button and dialog", () => {
  const button = (html: string): string => html.match(/<button[^>]*data-share-savings[^>]*>/)?.[0] ?? "";

  it("the button is green with the halo — the sample has savings — and names the example", () => {
    const html = renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ShareSavings, { card })));
    expect(button(html)).toContain('data-share-savings="saved"');
    expect(button(html)).toContain("ring-emerald-500/35");
    expect(html).toContain("data-share-halo");
    expect(button(html)).toContain('aria-label="Share this example"');
    expect(button(html)).toContain('aria-haspopup="dialog"');
  });

  it("the dialog's title and description say it is the example — the dialog mounts them only when open (ShareSavings.tsx)", () => {
    expect(shareWords(card)).toEqual({
      trigger: "Share this example",
      triggerTip: "Share an image of this example",
      title: "Share the example",
      description: "An image of this example, ready to post. It is marked “Example”: nobody’s pension.",
    });
  });

  it("the dialog's body: dollars, SOL off and said why, and Post on X with the neutral line", () => {
    const html = renderToStaticMarkup(createElement(SharePanel, { card }));
    expect(html).toMatch(/<button[^>]*aria-checked="true"[^>]*>USD<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>SOL<\/button>/);
    expect(html).toContain(SHARE_COPY.example.dollarsOnly);
    expect(html).not.toContain(SHARE_COPY.noPrice);
    const link = html.match(/<a [^>]*data-share-action="x"[^>]*>/)?.[0] ?? "";
    const href = new URL(link.match(/href="([^"]+)"/)![1]!.replaceAll("&amp;", "&"));
    expect(href.searchParams.get("text")).toBe(SHARE_COPY.example.post);
  });
});
