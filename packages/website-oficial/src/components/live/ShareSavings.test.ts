// The share button beside the hero's figure and the dialog it opens (owner,
// 10-22): green with the page's own halo when there are savings, grey without
// one when there are none, off — and saying why — when the total could not be
// read; and a dialog whose actions are only the ones this browser can carry out,
// Download and Post on X always among them.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ShareSavings } from "@/components/live/ShareSavings";
import { SharePanel } from "@/components/live/SharePanel";
import { SharePreviewFrame } from "@/components/live/share-frame";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SAVED } from "@/lib/classes";
import { SHARE_COPY } from "@/lib/live-copy";
import { toDashboardMock } from "@/lib/live-mock";
import { shareCardOf, type ShareCardData } from "@/lib/live-share";

import { liveDashboard } from "../../../test/fixtures/live-dashboard";

const page = toDashboardMock(liveDashboard(), { complete: false });
const card = (lifetimeSaved: bigint | null, over: Partial<ShareCardData> = {}): ShareCardData => ({
  ...shareCardOf({ lifetimeSaved, stats: page.stats, rule: page.rule, now: page.now }),
  ...over,
});

const trigger = (shared: ShareCardData): string => renderToStaticMarkup(createElement(TooltipProvider, null, createElement(ShareSavings, { card: shared })));
/** The trigger's own <button>, attributes and all. */
const button = (html: string): string => html.match(/<button[^>]*data-share-savings[^>]*>/)?.[0] ?? "";

describe("the share button", () => {
  it("with savings: emerald, and the page's halo breathing out of the icon", () => {
    const html = trigger(card(60_000_000n));
    expect(button(html)).toContain('data-share-savings="saved"');
    expect(button(html)).toContain(SAVED);
    expect(button(html)).toContain("ring-emerald-500/35");
    expect(html).toMatch(/<span class="live-halo pointer-events-none text-emerald-500\/50" data-share-halo=""><\/span>/);
    expect(button(html)).toContain(`aria-label="${SHARE_COPY.trigger}"`);
    expect(button(html)).toContain('aria-haspopup="dialog"');
    expect(button(html)).not.toMatch(/\sdisabled=""|aria-disabled/);
  });

  it("with nothing saved yet: grey, no halo, and it still opens", () => {
    const html = trigger(card(0n));
    expect(button(html)).toContain('data-share-savings="zero"');
    expect(button(html)).toContain("text-muted-foreground");
    expect(button(html)).not.toContain("emerald");
    expect(html).not.toContain("live-halo");
    expect(button(html)).toContain('aria-haspopup="dialog"');
    expect(button(html)).not.toMatch(/\sdisabled=""|aria-disabled/);
  });

  it("with a total nobody could read: grey and off, focusable so its tooltip can say why", () => {
    const html = trigger(card(null));
    expect(button(html)).toContain('data-share-savings="unknown"');
    expect(button(html)).toContain('aria-disabled="true"');
    expect(button(html)).not.toMatch(/\sdisabled=""/);
    expect(button(html)).not.toContain("aria-haspopup");
    expect(html).not.toContain("live-halo");
  });

  it("is a 32 px circle, so the figure's 40/48 px line keeps its height", () => {
    expect(button(trigger(card(60_000_000n)))).toMatch(/class="[^"]*\bsize-8\b[^"]*\brounded-full\b/);
  });
});

describe("the dialog's body", () => {
  afterEach(() => vi.unstubAllGlobals());

  const panel = (shared: ShareCardData): string => renderToStaticMarkup(createElement(SharePanel, { card: shared }));
  /** The actions offered, by name. */
  const actions = (html: string): string[] => [...html.matchAll(/data-share-action="([a-z]+)"/g)].map((match) => match[1]!);

  it("offers Download and Post on X everywhere, and nothing this browser cannot do", () => {
    const html = panel(card(60_000_000n));
    expect(actions(html)).toEqual(["download", "x"]);
    expect(html).toContain(SHARE_COPY.download);
    expect(html).toContain(SHARE_COPY.postOnX);
  });

  it("adds Copy image where an image can go on the clipboard, and the sheet where there is one", () => {
    vi.stubGlobal("ClipboardItem", class {});
    vi.stubGlobal("navigator", { clipboard: { write: () => Promise.resolve() }, share: () => Promise.resolve(), canShare: () => true });
    const html = panel(card(60_000_000n));
    expect(actions(html)).toEqual(["share", "copy", "download", "x"]);
    expect(html).toContain(SHARE_COPY.share);
    expect(html).toContain(SHARE_COPY.copy);
  });

  it("Post on X is a plain link to X's composer, in a new tab, with the post and saverfi.cash", () => {
    const html = panel(card(60_000_000n));
    const link = html.match(/<a [^>]*data-share-action="x"[^>]*>/)?.[0] ?? "";
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    const href = new URL(link.match(/href="([^"]+)"/)![1]!.replaceAll("&amp;", "&"));
    expect(href.host).toBe("x.com");
    expect(href.searchParams.get("text")).toBe("I’ve saved $6.00 for my pension with SaverFi so far.");
    expect(href.searchParams.get("url")).toBe("https://saverfi.cash");
  });

  it("the image's actions wait for the image", () => {
    const html = panel(card(60_000_000n));
    expect(html.match(/<button[^>]*data-share-action="download"[^>]*>/)?.[0]).toMatch(/disabled=""/);
  });

  it("three backgrounds; dollars by default, SOL beside them", () => {
    const html = panel(card(60_000_000n));
    for (const name of Object.values(SHARE_COPY.backgrounds)) expect(html).toContain(`>${name}</button>`);
    expect(html).toMatch(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*>USD<\/button>/);
    expect(html).toMatch(/<button[^>]*role="radio"[^>]*aria-checked="false"[^>]*>SOL<\/button>/);
  });

  it("no price: SOL only, and it says so", () => {
    const html = panel(card(60_000_000n, { usdText: null, usdCompact: null, priced: false }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>USD<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-checked="true"[^>]*>SOL<\/button>/);
    expect(html).toContain(SHARE_COPY.noPrice);
  });

  it("nothing saved yet: no unit to choose", () => {
    const html = panel(card(0n));
    expect(html).not.toContain(SHARE_COPY.showIn);
    expect(html).not.toContain(">USD<");
  });
});

describe("the preview's frame", () => {
  it("keeps the card's shape and dark ground while the picture is drawn, and says so", () => {
    const html = renderToStaticMarkup(createElement(SharePreviewFrame, { drawing: true }));
    expect(html).toContain("aspect-ratio:1200 / 630");
    expect(html).toContain("bg-[#0A0B11]");
    expect(html).toContain(SHARE_COPY.drawing);
    expect(html).toContain("motion-safe:animate-spin");
  });

  it("shows the PNG itself, described for a screen reader", () => {
    const html = renderToStaticMarkup(createElement(SharePreviewFrame, { src: "blob:x", alt: "Your SaverFi image" }));
    expect(html).toMatch(/<img src="blob:x" alt="Your SaverFi image"/);
  });

  it("a draw that failed says so in words", () => {
    expect(renderToStaticMarkup(createElement(SharePreviewFrame, { failed: SHARE_COPY.drawFailed }))).toContain(`role="alert"`);
  });
});
