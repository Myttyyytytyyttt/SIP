// The share button beside the hero's figure and the dialog it opens (owner,
// 10-22): green with the page's own halo when there are savings, grey without
// one when there are none, off — and saying why — when the total could not be
// read; and a dialog whose actions are only the ones this browser can carry out,
// Download and Post on X always among them.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SharePanelFailed, ShareSavings } from "@/components/live/ShareSavings";
import { SharePanel, VideoRow, type Video } from "@/components/live/SharePanel";
import { SharePreviewFrame } from "@/components/live/share-frame";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SAVED } from "@/lib/classes";
import { SHARE_COPY } from "@/lib/live-copy";
import { toDashboardMock } from "@/lib/live-mock";
import { shareCardOf, type ShareCardData } from "@/lib/live-share";
import { SHARE_PLATES } from "@/lib/share-plates";

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

  it("says what Post on X does BEFORE the click — X opens in front of anything said after it", () => {
    const plain = panel(card(60_000_000n));
    expect(plain).toContain(SHARE_COPY.xHintNoCopy);
    vi.stubGlobal("ClipboardItem", class {});
    vi.stubGlobal("navigator", { clipboard: { write: () => Promise.resolve() } });
    const html = panel(card(60_000_000n));
    const hint = html.match(/<p id="([^"]+)" class="text-muted-foreground">([^<]*)<\/p>/);
    expect(hint?.[2]).toBe(SHARE_COPY.xHint);
    // The link is described by it, and the live region stays in the tree, empty until an action speaks.
    expect(html.match(/<a [^>]*data-share-action="x"[^>]*>/)?.[0]).toContain(`aria-describedby="${hint?.[1]}"`);
    expect(html).toMatch(/<p role="status" aria-live="polite" class="[^"]*"><\/p>/);
  });

  it("the image's actions wait for the image", () => {
    const html = panel(card(60_000_000n));
    expect(html.match(/<button[^>]*data-share-action="download"[^>]*>/)?.[0]).toMatch(/disabled=""/);
  });

  it("the picker's thumbs are the plates' own, under the card's words", () => {
    const html = panel(card(60_000_000n));
    for (const plate of Object.values(SHARE_PLATES)) expect(html).toContain(`src="${plate.thumb}"`);
  });

  it("offers no video before this browser has said it can make one — the question is asynchronous", () => {
    const html = panel(card(60_000_000n));
    expect(html).not.toContain("data-share-video");
    expect(actions(html)).not.toContain("video-make");
  });

  it("three backgrounds, Grid first and chosen (owner, 10-22); dollars by default, SOL beside them", () => {
    const html = panel(card(60_000_000n));
    for (const name of Object.values(SHARE_COPY.backgrounds)) expect(html).toContain(`>${name}</button>`);
    const radios = [...html.matchAll(/<button[^>]*role="radio"[^>]*aria-checked="(true|false)"[^>]*>(?:<span[^>]*>.*?<\/span>)?([A-Za-z]+)<\/button>/g)].map((match) => [match[2], match[1]]);
    expect(radios.slice(0, 3)).toEqual([
      ["Grid", "true"],
      ["Streaks", "false"],
      ["Vault", "false"],
    ]);
    expect(html).toMatch(/<button[^>]*role="radio"[^>]*aria-checked="true"[^>]*>USD<\/button>/);
    expect(html).toMatch(/<button[^>]*role="radio"[^>]*aria-checked="false"[^>]*>SOL<\/button>/);
  });

  it("no price: SOL only, and it says so", () => {
    const html = panel(card(60_000_000n, { usdText: null, usdCompact: null }));
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

describe("a dialog whose code did not load", () => {
  it("says so in the frame and offers the reload that fetches it again — the page around it stays", () => {
    const html = renderToStaticMarkup(createElement(SharePanelFailed));
    expect(html).toContain('role="alert"');
    expect(html).toContain(SHARE_COPY.loadFailed);
    expect(html).toMatch(/<button[^>]*data-share-action="reload"[^>]*>.*Reload<\/button>/);
  });
});

describe("the video's row", () => {
  const row = (video: Video | undefined, canShare = false): string =>
    renderToStaticMarkup(
      createElement(VideoRow, { video, progress: { percent: 0, show: null }, seconds: 12, canShare, onMake: () => undefined, onCancel: () => undefined, onDownload: () => undefined, onShare: () => undefined }),
    );
  const rowActions = (html: string): string[] => [...html.matchAll(/data-share-action="([a-z-]+)"/g)].map((match) => match[1]!);

  it("before: what it is — an MP4 that plays like a GIF — and Make video", () => {
    const html = row(undefined);
    expect(html).toContain('data-share-video="idle"');
    expect(html).toContain(SHARE_COPY.video.about(12));
    expect(rowActions(html)).toEqual(["video-make"]);
  });

  it("while it is made: a bar a screen reader can read, and Cancel", () => {
    const html = row({ status: "making" });
    expect(html).toContain('data-share-video="making"');
    expect(html).toMatch(/role="progressbar" aria-label="[^"]+" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"/);
    expect(rowActions(html)).toEqual(["video-cancel"]);
  });

  it("made: its length and weight, Download video — and Share video only where the sheet takes one", () => {
    const blob = new Blob([new Uint8Array(934_000)], { type: "video/mp4" });
    expect(row({ status: "ready", blob })).toContain(SHARE_COPY.video.ready(12, "934 KB"));
    expect(rowActions(row({ status: "ready", blob }))).toEqual(["video-download"]);
    expect(rowActions(row({ status: "ready", blob }, true))).toEqual(["video-share", "video-download"]);
  });

  it("failed: said in words, and a retry — the image's actions are elsewhere and stay", () => {
    const html = row({ status: "failed" });
    expect(html).toContain(SHARE_COPY.video.failed);
    expect(rowActions(html)).toEqual(["video-make"]);
    expect(html).toContain(SHARE_COPY.video.retry);
  });
});

describe("the preview's frame", () => {
  it("is the plate — its still, its loop over it (WebM, then MP4) — with the card's words on top", () => {
    const html = renderToStaticMarkup(createElement(SharePreviewFrame, { plate: SHARE_PLATES.grid, src: "blob:words", alt: "Your SaverFi image" }));
    const still = html.indexOf(`src="${SHARE_PLATES.grid.still}"`);
    const webm = html.indexOf(`src="${SHARE_PLATES.grid.webm}"`);
    const mp4 = html.indexOf(`src="${SHARE_PLATES.grid.mp4}"`);
    const words = html.indexOf('src="blob:words"');
    expect(still).toBeGreaterThan(-1);
    expect([still, webm, mp4, words]).toEqual([still, webm, mp4, words].sort((a, b) => a - b));
    expect(html).toMatch(/<video[^>]*aria-hidden="true"[^>]*>/);
    expect(html).toMatch(/<video[^>]*muted=""[^>]*loop=""[^>]*playsInline=""/);
    // The loop never ends, so it can be paused (WCAG 2.2.2).
    expect(html).toContain(`aria-label="${SHARE_COPY.pauseMotion}"`);
  });

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
