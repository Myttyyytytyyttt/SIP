// What search engines are told (owner, 10-22: "quita el noindex para que salga
// en Google … especialmente si alguien busca por Google SaverFi"): which pages
// are indexed and under which address, what every page says about itself, the
// crawl files built from the same list, and the structured data. The page
// modules themselves are read here too, so a page cannot drift from its entry.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { metadata as activityMetadata } from "@/app/(dashboard)/activity/page";
import { metadata as homeMetadata } from "@/app/(dashboard)/page";
import { metadata as welcomeMetadata } from "@/app/(dashboard)/welcome/page";
import { metadata as dashboardMetadata } from "@/app/dashboard/page";
import DocsImage, { alt as docsImageAlt, generateStaticParams as docsImageParams, size as docsImageSize } from "@/app/docs/[slug]/opengraph-image";
import { metadata as rootLayoutMetadata } from "@/app/layout";
import { metadata as leaderboardMetadata } from "@/app/leaderboard/page";
import { GET as llmsRoute } from "@/app/llms.txt/route";
import SiteImage, { alt as siteImageAlt, size as siteImageSize } from "@/app/opengraph-image";
import { metadata as pricesMetadata } from "@/app/prices/view/page";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { metadata as walletsMetadata } from "@/app/wallets/page";
import { DOC_PAGES } from "@/lib/docs/pages";
import { homeJsonLd, serializeJsonLd, type JsonLdDocument } from "@/lib/json-ld";
import {
  INDEXED_PATHS,
  NOT_INDEXED,
  SITE_CARD,
  SITE_LOGO,
  SITE_PAGES,
  googleSiteVerification,
  isNonProductionDeployment,
  llmsTxt,
  pageMetadata,
  robotsFor,
  rootMetadata,
  sitemapEntries,
  type SitePage,
} from "@/lib/seo";
import { siteUrl } from "@/lib/site-url";

// The root layout loads Geist through next/font, which only Next's compiler can run; its metadata is what is read here.
vi.mock("next/font/google", () => ({ Geist: () => ({ variable: "font-sans" }), Geist_Mono: () => ({ variable: "font-mono" }) }));

const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));
const SITE = new URL("https://saverfi.example");
const DOCS = DOC_PAGES.map((page) => `/docs/${page.slug}`);

/** Every page module, by its entry: what each actually exports. */
const MODULES: Record<keyof typeof SITE_PAGES, unknown> = {
  home: homeMetadata,
  welcome: welcomeMetadata,
  activity: activityMetadata,
  wallets: walletsMetadata,
  leaderboard: leaderboardMetadata,
  dashboard: dashboardMetadata,
  prices: pricesMetadata,
};

const ENTRIES = Object.entries(SITE_PAGES) as [keyof typeof SITE_PAGES, SitePage][];

describe("which pages are indexed, and under which address (10-22)", () => {
  it("is the decision measured on production: the public pages in, the copies pointed at their original, the wallet pages out", () => {
    expect(Object.fromEntries(ENTRIES.map(([key, page]) => [key, [page.path, page.canonical, page.index]]))).toEqual({
      home: ["/", "/", true],
      welcome: ["/welcome", "/", true],
      activity: ["/activity", null, false],
      wallets: ["/wallets", null, false],
      leaderboard: ["/leaderboard", "/leaderboard", true],
      dashboard: ["/dashboard", "/dashboard", true],
      prices: ["/prices/view", "/prices/view", true],
    });
  });

  it.each(ENTRIES)("%s exports exactly its entry's metadata", (key, page) => {
    expect(MODULES[key]).toEqual(pageMetadata(page));
  });

  it("never says noindex on the landing, the page a search for SaverFi has to find", () => {
    expect(homeMetadata).not.toHaveProperty("robots");
    expect(rootLayoutMetadata).not.toHaveProperty("robots");
    expect(homeMetadata.alternates).toEqual({ canonical: "/" });
  });

  it("gives a canonical to every indexed page, a bare path with no query, so ?mode= and ?demo= variants fold into it", () => {
    for (const [key, page] of ENTRIES.filter(([, page]) => page.index)) {
      const meta = pageMetadata(page);
      expect(meta.alternates, key).toEqual({ canonical: page.canonical });
      expect(page.canonical, key).toMatch(/^\/[a-z/]*$/);
      expect(meta, key).not.toHaveProperty("robots");
    }
  });

  it("says noindex, follow — and no canonical — on the pages that stay out", () => {
    expect(NOT_INDEXED).toEqual({ index: false, follow: true });
    for (const [key, page] of ENTRIES.filter(([, page]) => !page.index)) {
      const meta = pageMetadata(page);
      expect(meta.robots, key).toEqual({ index: false, follow: true });
      expect(meta, key).not.toHaveProperty("alternates");
    }
  });
});

describe("what every page says about itself", () => {
  it("fits a search result: titles up to 60 characters, descriptions up to 160", () => {
    for (const [key, page] of ENTRIES) {
      expect(page.title.length, key).toBeLessThanOrEqual(60);
      expect(page.description.length, key).toBeGreaterThanOrEqual(50);
      expect(page.description.length, key).toBeLessThanOrEqual(160);
      expect(page.description, key).toMatch(/^[A-Z].*\.$/);
    }
  });

  it("is one title family: the landing leads with SaverFi, every other page ends in ' — SaverFi'", () => {
    expect(SITE_PAGES.home.title).toBe("SaverFi — A pension that builds itself, on Solana");
    for (const [key, page] of ENTRIES.filter(([key]) => key !== "home" && key !== "welcome")) expect(page.title, key).toMatch(/^[A-Z].* — SaverFi$/);
    // Only a copy repeats another page's title.
    const indexed = ENTRIES.filter(([, page]) => page.index && page.canonical === page.path).map(([, page]) => page.title);
    expect(new Set(indexed).size).toBe(indexed.length);
  });

  it("names SaverFi in the landing's description, with what it is: a pension, from trading, on Solana", () => {
    for (const word of ["SaverFi", "pension", "Solana", "trading"]) expect(SITE_PAGES.home.description).toContain(word);
  });

  it("keeps og:title 'SaverFi' wherever a wallet can connect: Phantom shows it in its prompt", () => {
    for (const key of ["home", "welcome", "activity", "wallets", "leaderboard", "dashboard"] as const) {
      expect(pageMetadata(SITE_PAGES[key]).openGraph, key).toMatchObject({ title: "SaverFi" });
    }
    expect(rootLayoutMetadata.openGraph).toMatchObject({ title: "SaverFi", siteName: "SaverFi" });
  });

  it.each(ENTRIES)("%s carries the site's card on both social cards, since its own openGraph replaces the parent's", (key, page) => {
    const meta = pageMetadata(page);
    expect(meta.openGraph).toMatchObject({ siteName: "SaverFi", type: "website", url: page.canonical ?? page.path, images: [SITE_CARD] });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image", images: [SITE_CARD] });
  });

  it("says SaverFi, never the code name", () => {
    const text = JSON.stringify([SITE_PAGES, rootLayoutMetadata, SITE_CARD]);
    expect(text).not.toMatch(/\bSIP\b|Nuvem/);
  });
});

describe("the root layout", () => {
  it("makes every relative address absolute on the configured site", () => {
    expect(rootLayoutMetadata.metadataBase).toEqual(siteUrl());
    expect(rootMetadata(SITE, {}).metadataBase).toBe(SITE);
  });

  it("sets no canonical and no og:url: a page without its own decision gets none, not the landing's", () => {
    const meta = rootMetadata(SITE, {});
    expect(meta).not.toHaveProperty("alternates");
    expect(meta.openGraph).not.toHaveProperty("url");
    expect(meta.openGraph).toMatchObject({ images: [SITE_CARD] });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image", images: [SITE_CARD] });
  });

  it("carries Search Console's token only when SIP_GOOGLE_SITE_VERIFICATION holds one", () => {
    const token = "a1B2c3D4e5F6g7H8i9J0-_kLmNoPqRsTuVwXyZ01234";
    expect(rootMetadata(SITE, {})).not.toHaveProperty("verification");
    expect(rootMetadata(SITE, { SIP_GOOGLE_SITE_VERIFICATION: token }).verification).toEqual({ google: token });
    // The whole tag Search Console shows is what gets copied: its content is read out of it.
    expect(googleSiteVerification({ SIP_GOOGLE_SITE_VERIFICATION: `<meta name="google-site-verification" content="${token}" />` })).toBe(token);
    for (const bad of ["", "   ", "short", 'x" onload="alert(1)', "<script>", "a".repeat(101)]) {
      expect(googleSiteVerification({ SIP_GOOGLE_SITE_VERIFICATION: bad }), bad).toBeNull();
    }
  });
});

describe("sitemap.xml", () => {
  const entries = sitemapEntries(SITE);

  it("lists the four public pages and every docs page, and nothing else", () => {
    expect(INDEXED_PATHS).toEqual(["/", "/leaderboard", "/dashboard", "/prices/view", ...DOCS]);
    expect(entries.map((entry) => entry.url)).toEqual(INDEXED_PATHS.map((path) => `https://saverfi.example${path}`));
    expect(entries).toHaveLength(22);
  });

  it("names every docs slug, each once", () => {
    const urls = new Set(entries.map((entry) => entry.url));
    expect(urls.size).toBe(entries.length);
    for (const page of DOC_PAGES) expect(urls.has(`https://saverfi.example/docs/${page.slug}`), page.slug).toBe(true);
  });

  it("holds only absolute addresses on the site, with no query, no redirect, no copy and no noindex page", () => {
    for (const { url } of entries) {
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://saverfi.example");
      expect(parsed.search).toBe("");
    }
    const paths = entries.map(({ url }) => new URL(url).pathname);
    for (const left of ["/docs", "/welcome", "/activity", "/wallets", "/prices", "/api/health"]) expect(paths, left).not.toContain(left);
  });

  it("is what /sitemap.xml serves, on this process's site address", () => {
    expect(sitemap()).toEqual(sitemapEntries(siteUrl()));
  });
});

describe("robots.txt", () => {
  it("lets production be crawled but /api/, and names the sitemap by its full address", () => {
    expect(robotsFor(SITE, {})).toEqual({ rules: [{ userAgent: "*", allow: "/", disallow: "/api/" }], sitemap: "https://saverfi.example/sitemap.xml" });
    expect(robotsFor(SITE, { VERCEL_ENV: "production" })).toEqual(robotsFor(SITE, {}));
  });

  it("blocks no indexed page, and none whose noindex Google must be able to read", () => {
    for (const path of [...INDEXED_PATHS, "/activity", "/wallets", "/welcome", "/prices", "/_next/static/chunks/a.js"]) expect(path.startsWith("/api/"), path).toBe(false);
  });

  it("closes a Vercel preview or development deployment to every crawler", () => {
    for (const name of ["preview", "development"]) {
      expect(isNonProductionDeployment({ VERCEL_ENV: name })).toBe(true);
      expect(robotsFor(SITE, { VERCEL_ENV: name })).toEqual({ rules: [{ userAgent: "*", disallow: "/" }] });
    }
    expect(isNonProductionDeployment({})).toBe(false);
    expect(isNonProductionDeployment({ VERCEL_ENV: "" })).toBe(false);
  });

  it("is what /robots.txt serves, for this process's environment", () => {
    expect(robots()).toEqual(robotsFor(siteUrl()));
  });
});

describe("llms.txt", () => {
  const text = llmsTxt(SITE);

  it("says what SaverFi is first, in the llmstxt.org shape", () => {
    expect(text.startsWith("# SaverFi\n\n> SaverFi builds you a pension from your trading, on Solana.")).toBe(true);
    expect(text).toContain("takes no fee");
  });

  it("lists every docs page under its group, with its full address and its search description", () => {
    for (const page of DOC_PAGES) expect(text).toContain(`- [${page.title}](https://saverfi.example/docs/${page.slug}): ${page.metaDescription}`);
    expect(text).toContain("## Start here");
    expect(text).toContain("## Trust and safety");
    expect(text).toContain("- [Prices](https://saverfi.example/prices/view): ");
  });

  it("says SaverFi, never the code name", () => {
    expect(text).not.toMatch(/\bSIP\b|Nuvem/);
  });

  it("is served as plain text by /llms.txt", async () => {
    const response = llmsRoute();
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe(llmsTxt(siteUrl()));
  });
});

describe("the landing's structured data", () => {
  const data = homeJsonLd(SITE);
  const nodes = data["@graph"];
  const byType = (type: string) => nodes.find((node) => node["@type"] === type)! as Record<string, unknown>;

  it("survives its own escaping as the same JSON", () => {
    expect(JSON.parse(serializeJsonLd(data))).toEqual(data);
  });

  it("is the publisher, the site and the app, pointing at each other", () => {
    expect(data["@context"]).toBe("https://schema.org");
    expect(nodes.map((node) => node["@type"])).toEqual(["Organization", "WebSite", "WebApplication"]);
    expect(byType("WebSite")).toMatchObject({ name: "SaverFi", url: "https://saverfi.example/", publisher: { "@id": "https://saverfi.example/#organization" } });
    expect(byType("Organization")).toMatchObject({ "@id": "https://saverfi.example/#organization", name: "SaverFi", url: "https://saverfi.example/" });
    expect(byType("WebApplication")).toMatchObject({ name: "SaverFi", applicationCategory: "FinanceApplication", offers: { "@type": "Offer", price: "0", priceCurrency: "USD" } });
  });

  it("uses a logo that exists, at the size it says", () => {
    expect(byType("Organization")["logo"]).toEqual({ "@type": "ImageObject", url: "https://saverfi.example/logo/logo800x800.png", width: 800, height: 800 });
    const png = readFileSync(join(PACKAGE, "public", SITE_LOGO.path));
    // A PNG's IHDR: width and height, big-endian, at bytes 16 and 20.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([SITE_LOGO.width, SITE_LOGO.height]);
  });

  it("claims no profile it cannot back: no sameAs while the footer's X and GitHub links are '#', and no rating", () => {
    const text = JSON.stringify(data);
    expect(text).not.toContain("sameAs");
    expect(text).not.toMatch(/aggregateRating|review/i);
  });

  it("writes every address absolute, on the site", () => {
    const urls = JSON.stringify(data).match(/https?:\/\/[^"]+/g)!.filter((url) => url !== "https://schema.org");
    for (const url of urls) expect(url.startsWith("https://saverfi.example/"), url).toBe(true);
  });
});

describe("JSON-LD inside a <script>", () => {
  it("cannot end the element or break a line: <, >, & and U+2028/2029 leave as \\u escapes", () => {
    const hostile: JsonLdDocument = { "@context": "https://schema.org", "@graph": [{ "@type": "Thing", name: "</script><script>alert(1)</script> & \u2028\u2029" }] };
    const text = serializeJsonLd(hostile);
    expect(text).not.toMatch(/[<>&\u2028\u2029]/);
    expect(text).toContain("\\u003c/script\\u003e");
    expect(JSON.parse(text)).toEqual(hostile);
  });
});

describe("the social cards", () => {
  /** A PNG's signature, then its IHDR's width and height. */
  const pngSize = async (response: Response): Promise<[number, number]> => {
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  };

  it("draws the site's card at 1200 × 630, the size every page names", async () => {
    expect(siteImageSize).toEqual({ width: SITE_CARD.width, height: SITE_CARD.height });
    expect(siteImageAlt).toBe(SITE_CARD.alt);
    expect(await pngSize(await SiteImage())).toEqual([1200, 630]);
  });

  it("draws a card for every docs page, and only for those", async () => {
    expect(docsImageParams()).toEqual(DOC_PAGES.map(({ slug }) => ({ slug })));
    expect(docsImageSize).toEqual({ width: 1200, height: 630 });
    expect(docsImageAlt).toBe("SaverFi Docs");
    // The longest title, which is the one that has to fit.
    const longest = [...DOC_PAGES].sort((a, b) => b.title.length - a.title.length)[0]!;
    expect(await pngSize(await DocsImage({ params: Promise.resolve({ slug: longest.slug }) }))).toEqual([1200, 630]);
  });

  it("reads the mark from public/, where the build finds it", () => {
    expect(existsSync(join(PACKAGE, "public/logo/sip-mark-white.png"))).toBe(true);
  });
});
