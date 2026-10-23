// The share button beside the hero's figure and the dialog it opens (owner,
// 10-22): green with the page's own halo when there are savings, grey without
// one when there are none, off — and saying why — when the total could not be
// read; and a dialog whose actions are only the ones this browser can carry out,
// Download and Post on X always among them.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SharePanelFailed, ShareSavings } from "@/components/live/ShareSavings";
import { DownloadButton, SharePanel, videoEntry, type Video } from "@/components/live/SharePanel";
import { SharePreviewFrame } from "@/components/live/share-frame";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SAVED } from "@/lib/classes";
import { SHARE_COPY } from "@/lib/live-copy";
import { toDashboardMock } from "@/lib/live-mock";
import { EXAMPLE_SHARE_LINKS, SHARE_BACKGROUNDS, shareCardOf, type ShareCardData, type ShareLinks } from "@/lib/live-share";
import { askShareLink, forgetShareLinks } from "@/lib/share-link-client";
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
    const hint = html.match(/<p id="([^"]+)" class="text-muted-foreground" data-share-x-hint="none">([^<]*)<\/p>/);
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

  it("Download is the image's plain button until this browser says it can make the video — the question is asynchronous", () => {
    const html = panel(card(60_000_000n));
    expect(html.match(/<button[^>]*data-share-action="download"[^>]*>/)?.[0]).not.toContain("aria-haspopup");
    expect(html).not.toContain("data-share-video=");
  });

  it("four buttons at most, and nothing about a video beside them (owner, 10-23)", () => {
    vi.stubGlobal("ClipboardItem", class {});
    vi.stubGlobal("File", File);
    // A sheet that would take an MP4 too: still no Share video.
    vi.stubGlobal("navigator", { clipboard: { write: () => Promise.resolve() }, share: () => Promise.resolve(), canShare: () => true });
    const html = panel(card(60_000_000n));
    expect(actions(html)).toEqual(["share", "copy", "download", "x"]);
    for (const gone of ["Make video", "Share video", "Download video", SHARE_COPY.downloadVideo]) expect(html).not.toContain(gone);
    // The video's own voice is in the tree, silent, before anything is made: a screen reader hears what lands in it.
    expect(html).toMatch(/<p role="status" aria-live="polite" class="sr-only" data-share-video-said=""><\/p>/);
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

/**
 * THE CARD'S OWN LINK (owner, 10-22: "Enlace con vista previa"): Post on X
 * posts saverfi.cash/c/<token> — or, on the sample, /c/example — and X shows
 * the card under it. While the link is asked for, Post on X waits.
 */
describe("Post on X with the card's own link", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    forgetShareLinks();
  });

  const OWNER = "PensionKeyP1aceho1der111111111111111111111";
  const xLink = (html: string): string => html.match(/<a [^>]*data-share-action="x"[^>]*>/)?.[0] ?? "";
  const hrefOf = (html: string): URL => new URL(xLink(html).match(/href="([^"]+)"/)![1]!.replaceAll("&amp;", "&"));
  const hintOf = (html: string): string => html.match(/data-share-x-hint="[a-z]+">([^<]*)<\/p>/)?.[1] ?? "";
  /** Links the server signs: one path per background and unit. */
  const signed = (): ShareLinks =>
    Object.fromEntries(SHARE_BACKGROUNDS.map((background) => [background, { usd: `/c/${background}-usd.mac`, sol: `/c/${background}-sol.mac` }])) as unknown as ShareLinks;

  it("the sample's: its fixed page, at once — no asking, nothing signed", () => {
    const html = renderToStaticMarkup(createElement(SharePanel, { card: card(60_000_000n), link: { kind: "example" } }));
    expect(hrefOf(html).searchParams.get("url")).toBe(`https://saverfi.cash${EXAMPLE_SHARE_LINKS.grid.usd}`);
    // Its link shows this very card, "Example pension" in both.
    expect(hintOf(html)).toBe(SHARE_COPY.example.xHintLinked);
    expect(hintOf(html)).toBe("Post on X adds a link that shows this card.");
  });

  it("a Live page's, while it is asked for: Post on X waits, disabled, and says why", () => {
    const html = renderToStaticMarkup(createElement(SharePanel, { card: card(60_000_000n), link: { kind: "live", owner: OWNER, proof: [] } }));
    expect(xLink(html)).toBe("");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*data-share-action="x"[^>]*>/);
    expect(hintOf(html)).toBe(SHARE_COPY.xHintPending);
  });

  it("a Live page's, answered: the server's card is the one shown and posted, under its own signed link", async () => {
    const page = card(60_000_000n);
    const server = { ...page, usdText: "$6.01", streakDays: 3 };
    const fetch = vi.fn(async () => new Response(JSON.stringify({ card: server, links: signed(), streak: { claimed: 3, proven: 3 } }), { status: 200 }));
    await askShareLink({ kind: "live", owner: OWNER, proof: [] }, page, { fetch });
    vi.stubGlobal("ClipboardItem", class {});
    vi.stubGlobal("navigator", { clipboard: { write: () => Promise.resolve() } });
    const html = renderToStaticMarkup(createElement(SharePanel, { card: page, link: { kind: "live", owner: OWNER, proof: [] } }));
    const href = hrefOf(html);
    expect(href.searchParams.get("url")).toBe("https://saverfi.cash/c/grid-usd.mac");
    expect(href.searchParams.get("text")).toBe("I’ve saved $6.01 for my pension with SaverFi so far.");
    expect(xLink(html)).toContain('target="_blank"');
    // Said before the click: X's card is titled "SaverFi’s Vault", not this one's "My pension" (S1; owner, 10-23).
    expect(hintOf(html)).toBe(SHARE_COPY.xHintLinked);
    // The name never splits across lines: a no-break space joins it.
    expect(hintOf(html)).toBe("Post on X shares it as “SaverFi’s\u00a0Vault”.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a Live page's, refused or off: the site and the image to paste, as before", async () => {
    const page = card(60_000_000n);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: "share_links_off" } }), { status: 404 }));
    await askShareLink({ kind: "live", owner: OWNER, proof: [] }, page, { fetch });
    const html = renderToStaticMarkup(createElement(SharePanel, { card: page, link: { kind: "live", owner: OWNER, proof: [] } }));
    expect(hrefOf(html).searchParams.get("url")).toBe("https://saverfi.cash");
    expect(hintOf(html)).toBe(SHARE_COPY.xHintNoCopy);
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

/**
 * THE VIDEO, INSIDE DOWNLOAD (owner, 10-23: "Dentro de Download"): no row of
 * its own; where this browser can make it, Download is a menu of Image (PNG)
 * and Video (MP4). The menu's entries are drawn in a portal, which a server
 * render never opens: what they say and do is videoEntry's, read here, and the
 * menu itself was driven in Chrome, WebKit and Firefox.
 */
describe("Download, and the video inside it", () => {
  const button = (canVideo: boolean, disabled = false): string =>
    renderToStaticMarkup(
      createElement(DownloadButton, {
        canVideo,
        disabled,
        video: undefined,
        progress: { percent: 0, show: null },
        seconds: 12,
        open: false,
        onOpenChange: () => undefined,
        onImage: () => undefined,
        onMake: () => undefined,
        onSave: () => undefined,
        onCancel: () => undefined,
      }),
    );
  const tag = (html: string): string => html.match(/<button[^>]*>/)?.[0] ?? "";

  it("where the video can be made: a menu button, closed, that says it opens a menu", () => {
    const html = button(true);
    expect(tag(html)).toContain('data-share-action="download"');
    expect(tag(html)).toContain('aria-haspopup="menu"');
    expect(tag(html)).toContain('aria-expanded="false"');
    expect(html).toContain(`>${SHARE_COPY.download}<`);
    // The chevron says "menu"; under sm it takes the download icon's place, so three buttons still fit a phone.
    expect(html).toMatch(/lucide-chevron-down/);
    expect(html).toMatch(/<svg[^>]*class="[^"]*lucide-download[^"]*max-sm:hidden/);
  });

  it("where it cannot: the image's own button, no menu of one entry", () => {
    const html = button(false);
    expect(tag(html)).toContain('data-share-action="download"');
    expect(tag(html)).not.toContain("aria-haspopup");
    expect(html).not.toMatch(/lucide-chevron-down/);
  });

  it("waits for the image, either way", () => {
    expect(tag(button(true, true))).toMatch(/disabled=""/);
    expect(tag(button(false, true))).toMatch(/disabled=""/);
  });

  const blob = new Blob([new Uint8Array(934_000)], { type: "video/mp4" });

  it("before it is made: Video (MP4), its length beside it, and choosing it makes it", () => {
    expect(videoEntry(undefined, 12)).toEqual({ does: "make", label: "Video (MP4)", hint: "12 s", failed: null });
    expect(SHARE_COPY.downloadImage).toBe("Image (PNG)");
  });

  it("made and saved: the same entry, which saves the one made — no second encode", () => {
    expect(videoEntry({ status: "ready", blob, saved: true }, 10)).toEqual({ does: "save", label: "Video (MP4)", hint: "10 s", failed: null });
  });

  it("made after the click stopped counting: one click left, Download video, and its weight", () => {
    expect(videoEntry({ status: "ready", blob, saved: false }, 12)).toEqual({ does: "save", label: SHARE_COPY.video.save, hint: "934 KB", failed: null });
  });

  it("failed: said in words under the entry, which offers Try again — the browser's fault or the network's (review, 10-22)", () => {
    expect(videoEntry({ status: "failed", network: false }, 12)).toEqual({ does: "make", label: "Video (MP4)", hint: SHARE_COPY.video.retry, failed: SHARE_COPY.video.failed });
    expect(videoEntry({ status: "failed", network: true }, 12).failed).toBe(SHARE_COPY.video.failedNetwork);
  });

  it("the copy: a menu's few words, and the old row's are gone", () => {
    expect(Object.keys(SHARE_COPY.video).sort()).toEqual(["cancel", "failed", "failedNetwork", "length", "making", "makingSaid", "ready", "retry", "save"]);
    expect(SHARE_COPY.video.ready(12, "1.1 MB")).toBe("Ready: 12 seconds, 1.1 MB.");
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
