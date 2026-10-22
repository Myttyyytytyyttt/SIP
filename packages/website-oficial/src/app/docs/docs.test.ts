// /docs (owner, 10-22): the index on the left, the page from the centre to the
// right, a clip where one helps — and, until the owner makes them official, reached
// by their URL alone. These hold the owner's list of pages, what every page
// renders, and his decisions that a writer could undo without noticing: no
// status tags, noindex, no link from the header or the footer, never a broken
// video. And what makes a page load fast (10-22, measured): the poster asked for
// first, no video byte before the loop plays, every clip's URL versioned by its
// content so it can be cached for a year.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DocsPage, { generateMetadata, generateStaticParams } from "@/app/docs/[slug]/page";
import DocsLayout, { metadata as layoutMetadata } from "@/app/docs/layout";
import DocsIndex from "@/app/docs/page";
import { Clip } from "@/components/docs/docs-clip";
import { DocsNav } from "@/components/docs/docs-nav";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { CLIPS, clipOf } from "@/lib/docs/clips";
import { DOC_GROUPS, DOC_PAGES, docNeighbours, docSlugOf, type DocSlug } from "@/lib/docs/pages";

import { VERSIONED, clipProblems } from "../../../scripts/check-clips.mts";

const PACKAGE = fileURLToPath(new URL("../../../", import.meta.url));

// The clip's poster preload, watched: a static render has no <head> to show it in, so the call is what is checked.
const { preload } = vi.hoisted(() => ({ preload: vi.fn() }));
vi.mock("react-dom", async (original) => ({ ...(await original<typeof import("react-dom")>()), preload }));

/** The owner's list (DOCS_DECISIONS, 10-22), in order: group, then [slug, title, parent?]. */
const OWNER_LIST: readonly (readonly [string, readonly (readonly [string, string, string?])[]])[] = [
  ["Start here", [["what-is-saverfi", "What is SaverFi?"], ["pension-key", "Your pension key"]]],
  [
    "How saving works",
    [
      ["saving-from-profit", "Saving from your profit"],
      ["saving-from-volume", "Saving from your volume"],
      ["round-ups", "Saving with round-ups"],
      ["timing-and-limits", "When savings happen, and their limits"],
    ],
  ],
  [
    "Set up",
    [
      ["create-your-vault", "Create your vault"],
      ["trading-wallets", "Trading wallets"],
      ["import-a-wallet", "Import a wallet you already use", "trading-wallets"],
    ],
  ],
  ["Investing your savings", [["investing", "Investing your savings"]]],
  [
    "Day to day",
    [
      ["dashboard", "Reading your dashboard"],
      ["change-settings", "Change your settings"],
      ["take-money-out", "Take money out"],
      ["not-saving", "Why isn\u2019t it saving?"],
      ["public-pages", "Public pages: leaderboard, stats and prices"],
    ],
  ],
  [
    "Trust and safety",
    [
      ["fees", "Fees"],
      ["who-controls-what", "Who controls what"],
      ["risks-and-beta", "Risks and beta status"],
    ],
  ],
];

const SLUGS: readonly DocSlug[] = DOC_PAGES.map((page) => page.slug);

const params = (slug: string) => ({ params: Promise.resolve({ slug }) });
const renderPage = async (slug: string): Promise<string> => renderToStaticMarkup(await DocsPage(params(slug)));

/** What a rejected Next control-flow call carries: notFound() and redirect() say what they are in their digest. */
const digestOf = async (run: () => unknown): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return String((error as { digest?: unknown }).digest);
  }
  throw new Error("expected the call to throw");
};

/** Every source file of the docs, writers' bodies included; not the tests. */
const docsSources = (): { readonly path: string; readonly text: string }[] =>
  ["src/app/docs", "src/components/docs", "src/lib/docs"].flatMap((dir) =>
    readdirSync(join(PACKAGE, dir), { recursive: true, encoding: "utf8" })
      .filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts"))
      .map((name) => ({ path: join(dir, name), text: readFileSync(join(PACKAGE, dir, name), "utf8") })),
  );

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("'", "&#x27;");

describe("the docs' index", () => {
  it("is the owner's list: his groups, his pages, his slugs, in his order", () => {
    expect(DOC_GROUPS.map((group) => [group.title, group.pages.map((page) => [page.slug, page.title, ...(page.parent ? [page.parent] : [])])])).toEqual(
      OWNER_LIST.map(([title, pages]) => [title, pages.map((page) => [...page])]),
    );
  });

  it("has 17 pages and 1 sub-page, read straight after its parent, in the same group", () => {
    expect(DOC_PAGES).toHaveLength(18);
    expect(new Set(SLUGS).size).toBe(18);
    const subPages = DOC_PAGES.filter((page) => page.parent !== undefined);
    expect(subPages.map((page) => page.slug)).toEqual(["import-a-wallet"]);
    for (const page of subPages) {
      const at = DOC_PAGES.indexOf(page);
      expect(DOC_PAGES[at - 1]?.slug).toBe(page.parent);
      expect(DOC_PAGES[at - 1]?.group).toBe(page.group);
    }
  });

  it("gives every page one line to stand under its title", () => {
    for (const page of DOC_PAGES) expect(page.description).toMatch(/^[A-Z].*\.$/);
  });

  it("builds a static page for every slug", () => {
    expect(generateStaticParams()).toEqual(SLUGS.map((slug) => ({ slug })));
  });

  it("knows a page from its pathname, and nothing else", () => {
    expect(docSlugOf("/docs/fees")).toBe("fees");
    expect(docSlugOf("/docs/fees/")).toBe("fees");
    expect(docSlugOf("/docs/import-a-wallet")).toBe("import-a-wallet");
    expect(docSlugOf("/docs")).toBeNull();
    expect(docSlugOf("/docs/nope")).toBeNull();
    expect(docSlugOf("/fees")).toBeNull();
    expect(docSlugOf(null)).toBeNull();
  });
});

describe("a docs page", () => {
  it.each(SLUGS)("%s renders its group, its title, its line, its clip if it has one, and its body", async (slug) => {
    const page = DOC_PAGES.find((entry) => entry.slug === slug)!;
    const html = await renderPage(slug);
    expect(html.match(/<h1[^>]*>([^<]*)<\/h1>/g)).toEqual([expect.stringContaining(`>${escapeHtml(page.title)}</h1>`)]);
    expect(html).toContain(`>${escapeHtml(page.description)}</p>`);
    expect(html).toContain(`>${escapeHtml(page.group)}</p>`);
    if (clipOf(slug) === null) {
      expect(html).not.toContain('data-slot="docs-clip"');
    } else {
      // One clip, at the top: after the title, before the body.
      expect(html.match(/data-slot="docs-clip"/g)).toHaveLength(1);
      expect(html.indexOf("</h1>")).toBeLessThan(html.indexOf('data-slot="docs-clip"'));
      expect(html.indexOf('data-slot="docs-clip"')).toBeLessThan(html.indexOf('data-slot="docs-body"'));
    }
    // The body says something.
    const body = html.slice(html.indexOf('data-slot="docs-body"'), html.indexOf('aria-label="Previous and next page"'));
    expect(body.replace(/<[^>]*>/g, "").trim().length).toBeGreaterThan(40);
  });

  it("an address that is not a page is a 404, for the page and for its metadata", async () => {
    for (const slug of ["nope", "coming-soon", "_content", "Fees"]) {
      expect(await digestOf(() => DocsPage(params(slug)))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
      expect(await digestOf(() => generateMetadata(params(slug)))).toBe("NEXT_HTTP_ERROR_FALLBACK;404");
    }
  });

  it("/docs itself sends the reader to the first page", async () => {
    expect(await digestOf(() => DocsIndex())).toMatch(/^NEXT_REDIRECT;replace;\/docs\/what-is-saverfi;307;/);
  });

  it("leads on in reading order: no Previous on the first page, no Next on the last", async () => {
    const first = await renderPage("what-is-saverfi");
    expect(first).not.toContain('rel="prev"');
    expect(first).toMatch(/<a [^>]*href="\/docs\/pension-key"[^>]*rel="next"|<a [^>]*rel="next"[^>]*href="\/docs\/pension-key"/);

    const last = await renderPage("risks-and-beta");
    expect(last).not.toContain('rel="next"');
    expect(last).toContain('href="/docs/who-controls-what"');

    // The sub-page sits between its parent and the next group's first page.
    expect(docNeighbours("import-a-wallet")).toMatchObject({ previous: { slug: "trading-wallets" }, next: { slug: "investing" } });
  });
});

describe("the docs' metadata", () => {
  it("keeps the whole tree out of search engines: noindex, nofollow on the layout", () => {
    expect(layoutMetadata.robots).toEqual({ index: false, follow: false });
  });

  it.each(SLUGS)("%s is titled '<Page> · SaverFi Docs', described by its line, and noindex too", async (slug) => {
    const page = DOC_PAGES.find((entry) => entry.slug === slug)!;
    const meta = await generateMetadata(params(slug));
    expect(meta.title).toBe(`${page.title} · SaverFi Docs`);
    expect(meta.description).toBe(page.description);
    expect(meta.robots).toEqual({ index: false, follow: false });
  });
});

describe("the index on the left", () => {
  const links = (html: string) => [...html.matchAll(/<a [^>]*href="(\/docs\/[^"]+)"[^>]*>([^<]*)<\/a>/g)].map((match) => [match[1], match[2]]);

  it("lists every page, in order, under its group", () => {
    const html = renderToStaticMarkup(createElement(DocsNav, { current: null }));
    expect(links(html)).toEqual(DOC_PAGES.map((page) => [`/docs/${page.slug}`, escapeHtml(page.title)]));
    let from = 0;
    for (const group of DOC_GROUPS) {
      const at = html.indexOf(`>${group.title}</p>`, from);
      expect(at, group.title).toBeGreaterThan(-1);
      from = at;
    }
    expect(html).not.toContain("aria-current");
  });

  it.each(SLUGS)("marks %s, and only it, when it is the page on screen", (slug) => {
    const html = renderToStaticMarkup(createElement(DocsNav, { current: slug }));
    const marked = [...html.matchAll(/<a [^>]*aria-current="page"[^>]*>/g)];
    expect(marked).toHaveLength(1);
    expect(marked[0]![0]).toContain(`href="/docs/${slug}"`);
  });

  it("indents the sub-page in a list of its own, inside its parent's entry", () => {
    const html = renderToStaticMarkup(createElement(DocsNav, { current: null }));
    expect(html).toMatch(/href="\/docs\/trading-wallets"[^>]*>Trading wallets<\/a><ul class="[^"]*border-l[^"]*"><li><a [^>]*href="\/docs\/import-a-wallet"/);
  });
});

describe("the docs' chrome", () => {
  const html = renderToStaticMarkup(createElement(DocsLayout, null, createElement("p", null, "BODY")));

  it("has the mark and the name back to the site, a Docs label, Open the app, and the theme last", () => {
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*><img[^>]*sip-mark-black\.png/);
    expect(html).toMatch(/<a [^>]*href="\/"[^>]*>Open the app<\/a>/);
    expect(html).toContain(">Docs</span>");
    expect(html).toContain('aria-label="Open the docs index"');
    expect(html.indexOf("Open the app")).toBeLessThan(html.indexOf('aria-label="Toggle theme"'));
  });

  it("puts the index in a sticky column of its own from lg, and the page beside it", () => {
    expect(html).toMatch(/<aside class="sticky top-14 hidden [^"]*overflow-y-auto[^"]*lg:block"><nav aria-label="Docs"/);
    expect(html).toMatch(/<main class="min-w-0 flex-1[^"]*"><p>BODY<\/p><\/main>/);
  });

  it("loads no wallet code", () => {
    for (const { path, text } of docsSources()) expect(text, path).not.toMatch(/@privy-io|@solana\/|wallets-host|leaderboard-account/);
  });
});

describe("a page's clip", () => {
  /** A URL without its version: the file in public/. */
  const pathOf = (url: string): string => url.split("?v=")[0]!;

  it("is the landing's app loop on the dashboard page, with its caption, playing only once the browser allows it", async () => {
    const html = await renderPage("dashboard");
    const video = html.match(/<video [^>]*>/)?.[0] ?? "";
    // The loop is the landing's, at its exact URLs, so a reader who has seen the landing already has it;
    // its poster is the docs' own WebP of that loop's first frame.
    expect(video).toMatch(/poster="\/docs\/clips\/dashboard\.webp\?v=[0-9a-f]{8}"/);
    expect(video).toContain("loop");
    expect(video).toContain("playsInline");
    // No autoplay in the HTML: the loop is started from the browser, which knows the reader's motion setting.
    expect(video).not.toMatch(/autoplay/i);
    expect(html).toContain('<source src="/landing/app-loop.webm" type="video/webm"/>');
    expect(html).toContain('<source src="/landing/app-loop.mp4" type="video/mp4"/>');
    expect(html).toContain("Example — nobody’s pension</figcaption>");
    // No button over a loop that is about to start: it appears once the browser has answered.
    expect(html).not.toContain("the clip");
  });

  it.each(SLUGS.filter((slug) => clipOf(slug) !== null && slug !== "dashboard"))(
    "is %s's own loop, from public/docs/clips/, with no caption: its label is inside the picture",
    async (slug) => {
      const html = await renderPage(slug);
      const video = html.match(/<video [^>]*>/)?.[0] ?? "";
      expect(video).toMatch(new RegExp(`poster="/docs/clips/${slug}\\.webp\\?v=[0-9a-f]{8}"`));
      expect(video).not.toMatch(/autoplay/i);
      expect(html).toMatch(new RegExp(`<source src="/docs/clips/${slug}\\.webm\\?v=[0-9a-f]{8}" type="video/webm"/>`));
      expect(html).toMatch(new RegExp(`<source src="/docs/clips/${slug}\\.mp4\\?v=[0-9a-f]{8}" type="video/mp4"/>`));
      expect(html).not.toContain("<figcaption");
    },
  );

  it.each(SLUGS.filter((slug) => clipOf(slug) !== null))("loads no video byte on %s before the loop is about to play: preload none, the poster alone", async (slug) => {
    const video = (await renderPage(slug)).match(/<video [^>]*>/)?.[0] ?? "";
    expect(video).toContain('preload="none"');
    expect(video).toContain(`poster="${clipOf(slug)!.poster}"`);
  });

  describe("asking for the poster first", () => {
    beforeEach(() => preload.mockClear());

    it.each(SLUGS)("%s preloads its clip's poster at high priority, and nothing when it has no clip", async (slug) => {
      await renderPage(slug);
      const clip = clipOf(slug);
      expect(preload.mock.calls).toEqual(clip === null ? [] : [[clip.poster, { as: "image", fetchPriority: "high" }]]);
    });
  });

  it("is on the first three pages, the ones a newcomer reads (owner, 10-22)", () => {
    for (const slug of ["what-is-saverfi", "pension-key", "saving-from-profit"] as const) expect(clipOf(slug), slug).not.toBeNull();
  });

  it.each(SLUGS.filter((slug) => clipOf(slug) === null))("is no media at all on %s, which has no clip: never a <video>, never an empty frame", async (slug) => {
    const html = await renderPage(slug);
    expect(html).not.toContain("<video");
    expect(html).not.toContain("<figure");
    expect(html).not.toContain("/docs/clips/");
  });

  // Any page without a clip; if every page ever gets one there is none, and the pages above say the rest.
  const missing = SLUGS.find((slug) => clipOf(slug) === null);

  it.skipIf(missing === undefined)("renders nothing for a page missing from the manifest", () => {
    expect(renderToStaticMarkup(createElement(Clip, { slug: missing! }))).toBe("");
  });

  it("is listed only once all of its files are in public/", () => {
    expect(Object.keys(CLIPS).length).toBeGreaterThan(0);
    for (const [slug, files] of Object.entries(CLIPS)) {
      for (const url of [files!.webm, files!.mp4, files!.poster]) {
        expect(existsSync(join(PACKAGE, "public", pathOf(url))), `${slug}: ${url}`).toBe(true);
      }
    }
  });

  it("names every /docs/clips/ file by its content, so a clip re-rendered under the same name is never served stale", () => {
    // Such a URL is cached for a year without asking again (next.config.mjs): only a new address reaches a reader.
    // The same check runs before every build (pnpm run check:clips), since a deploy never runs these tests.
    expect(clipProblems()).toEqual([]);
  });

  it("borrows the landing's loop at its exact URL, with no version, and versions everything under /docs/clips/", () => {
    const urls = Object.values(CLIPS).flatMap((files) => [files!.webm, files!.mp4, files!.poster]);
    expect(urls.filter((url) => !url.startsWith(VERSIONED))).toEqual(["/landing/app-loop.webm", "/landing/app-loop.mp4"]);
    for (const url of urls.filter((url) => url.startsWith(VERSIONED))) expect(url).toMatch(/\?v=[0-9a-f]{8}$/);
  });

  it("has a WebP poster of the docs' own for every clip, under the year-long cache", () => {
    for (const [slug, files] of Object.entries(CLIPS)) expect(pathOf(files!.poster), slug).toBe(`/docs/clips/${slug}.webp`);
  });
});

describe("the owner's decisions, held in every page (10-22)", () => {
  const everything = async (): Promise<string> => {
    const pages = await Promise.all(SLUGS.map(renderPage));
    return [...pages, renderToStaticMarkup(createElement(DocsNav, { current: null }))].join("\n");
  };

  it("carries no status tag and no 'Coming soon', rendered or in the source", async () => {
    const tags = /\[(?:Live|Coming|Idea|Planned)\]|coming soon/i;
    expect(await everything()).not.toMatch(tags);
    for (const { path, text } of docsSources()) expect(text, path).not.toMatch(tags);
  });

  it("never mentions unlinking, and never says the product is audited or that it has no audit", async () => {
    const html = await everything();
    expect(html).not.toMatch(/unlink/i);
    expect(html).not.toMatch(/\baudited\b|no (?:external )?audit/i);
  });

  it("says SaverFi, never the code name", async () => {
    expect(await everything()).not.toMatch(/\bSIP\b|Nuvem/);
  });

  it("is not linked yet: the header's and the footer's Docs links stay '#'", () => {
    const docsHref = (html: string) => html.match(/<a [^>]*href="([^"]*)"[^>]*>Docs<\/a>/)?.[1];
    expect(docsHref(renderToStaticMarkup(createElement(SiteHeader, { activitySheet: null, account: null })))).toBe("#");
    expect(docsHref(renderToStaticMarkup(createElement(SiteFooter, { now: "2026-10-22T00:00:00.000Z" })))).toBe("#");
  });
});
