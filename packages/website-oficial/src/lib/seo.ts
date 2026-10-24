/**
 * WHAT SEARCH ENGINES ARE TOLD ABOUT EVERY PAGE (owner, 10-22: "quita el noindex
 * para que salga en Google, y mejora el SEO … especialmente si alguien busca por
 * Google SaverFi").
 *
 * ONE LIST, SITE_PAGES, the way the docs have theirs (src/lib/docs/pages.ts):
 * each page's metadata, the sitemap, robots.txt and llms.txt are all read from
 * it, so a page cannot be indexed in one of them and missing from another.
 *
 * WHICH PAGES GO IN THE INDEX, measured on production before this change (10-22):
 * - INDEXED: the landing ("/"), /leaderboard, /dashboard, /prices/view and the
 *   18 docs pages. Each is complete in the server's HTML and readable by anyone.
 * - A COPY, POINTED AT ITS ORIGINAL: /welcome draws the same landing as "/".
 *   Every ?mode= or ?demo= variant of an indexed page gets that page's bare
 *   address as its canonical, the way Google asks duplicates to be
 *   consolidated — never a noindex, which next to a canonical is a mixed
 *   signal, and on "/?mode=mock" would sit beside the one page a search for
 *   "SaverFi" has to find.
 * - TO WATCH: "/?mode=mock" IS NOT A COPY (review, 10-22). It is the sample
 *   app — its own h1 and words, example figures — under the landing's title,
 *   description and structured data, since metadata cannot read the query
 *   without leaving <head> (below). A canonical is a hint Google may overrule
 *   between pages that differ. If Search Console shows it indexed on its own
 *   ("Google chose different canonical than user"), the remedy is an
 *   X-Robots-Tag: noindex header from src/proxy.ts on "/" requests carrying
 *   ?mode=mock — a header, so nothing request-dependent enters the metadata.
 * - NOT INDEXED, LINKS FOLLOWED: /activity and /wallets. For a visitor without
 *   a wallet the first is the landing again and the second is "Loading your
 *   wallets…"; what they show a connected pension is that person's own.
 *
 * STATIC ON PURPOSE. Every page sets these in `export const metadata` (or, for
 * the docs, in a generateMetadata resolved at build time), never in a
 * generateMetadata that reads the request: Next 16 may stream such metadata
 * into <body> for any client outside its list of HTML-limited bots
 * (HTML_LIMITED_BOT_UA_RE), and Googlebot is not on it — a canonical outside
 * <head> is ignored. Measured on a production build (10-22): with a Googlebot
 * user agent, every tag of every page is inside <head>.
 *
 * TITLES: ONE FAMILY. "<What the page is> — SaverFi", with "— SaverFi Docs" on
 * the docs; the landing leads with the name instead. One separator site-wide
 * (the docs were the only " · "), the brand always in the same place, so every
 * result reads as one site.
 *
 * og:title STAYS "SaverFi" WHEREVER A WALLET CAN CONNECT: Phantom reads og:title
 * before <title> for its prompt (src/app/layout.tsx). That is the landing,
 * /welcome, /activity, /wallets, and /leaderboard and /dashboard, which mount
 * Privy for a returning visitor. The docs and /prices/view load no wallet code
 * and carry their own title.
 */

import type { Metadata, MetadataRoute } from "next";

import { DOC_GROUPS, DOC_PAGES, docHref, docTitle, DOCS_ROBOTS, type DocEntry } from "@/lib/docs/pages";
import { GLOBAL_STATS_COPY } from "@/lib/global-stats-copy";
import { BRAND } from "@/lib/live-copy";
import { absoluteUrl } from "@/lib/site-url";

type Env = Readonly<Record<string, string | undefined>>;

export type SitePage = {
  /** Where the page answers. */
  readonly path: string;
  /** The address search engines should keep: the page's own, its original's, or null where it is not indexed. */
  readonly canonical: string | null;
  readonly index: boolean;
  /** The browser tab and the search result's headline: 60 characters at most, or Google cuts it. */
  readonly title: string;
  /** The search result's snippet: 160 characters at most. Metadata only, never on the page. */
  readonly description: string;
  /** The social card's headline: "SaverFi" wherever a wallet can connect (above). */
  readonly ogTitle: string;
};

const HOME_TITLE = `${BRAND} — A pension that builds itself, on Solana`;
const HOME_DESCRIPTION = `${BRAND} builds you a pension from your Solana trading: a slice of every trade, from its volume or its profit, goes into a vault only your wallet can open.`;

export const SITE_PAGES = {
  home: { path: "/", canonical: "/", index: true, title: HOME_TITLE, description: HOME_DESCRIPTION, ogTitle: BRAND },
  welcome: { path: "/welcome", canonical: "/", index: true, title: HOME_TITLE, description: HOME_DESCRIPTION, ogTitle: BRAND },
  activity: {
    path: "/activity",
    canonical: null,
    index: false,
    title: `Activity — ${BRAND}`,
    description: `Every saving, conversion, buy, withdrawal and rule change in your ${BRAND} pension.`,
    ogTitle: BRAND,
  },
  wallets: {
    path: "/wallets",
    canonical: null,
    index: false,
    title: `Wallets — ${BRAND}`,
    description: "Your pension key, your vault, and the trading wallets linked to it.",
    ogTitle: BRAND,
  },
  leaderboard: {
    path: "/leaderboard",
    canonical: "/leaderboard",
    index: true,
    title: `Leaderboard: who saves most often — ${BRAND}`,
    description: `Who saves most often on ${BRAND}, the pension built from your Solana trades. Ranked on use, not size: points stack week after week and cannot be bought.`,
    ogTitle: BRAND,
  },
  dashboard: {
    path: "/dashboard",
    canonical: "/dashboard",
    index: true,
    title: GLOBAL_STATS_COPY.metaTitle,
    description: GLOBAL_STATS_COPY.metaDescription,
    ogTitle: BRAND,
  },
  prices: {
    path: "/prices/view",
    canonical: "/prices/view",
    index: true,
    title: `Prices, and where each comes from — ${BRAND}`,
    description: `Every price ${BRAND} reads on Solana, each with its source and its age: SOL and SPYx beside Pyth, ANTHROPIC beside its issuer, and which PreStocks are offered.`,
    ogTitle: `Prices, and where each comes from — ${BRAND}`,
  },
} as const satisfies Record<string, SitePage>;

/** Read by everything that can be crawled but should not be listed: its links still count. */
export const NOT_INDEXED = { index: false, follow: true } as const;

/**
 * THE SITE CARD'S VERSION: a hash of the files that draw it —
 * src/app/opengraph-image.tsx, src/components/og-card.tsx and
 * public/logo/sip-mark-white.png — pinned by seo.test.ts, which fails with the
 * new value when any of them changes (review, 10-22). X, Facebook, LinkedIn,
 * Telegram and Discord keep a preview picture by its address, so a redrawn card
 * needs a new one, or links already shared keep the old picture.
 */
export const SITE_CARD_VERSION = "d0c829997b4f173f";

/**
 * THE SITE'S SOCIAL CARD (src/app/opengraph-image.tsx), named on every page that
 * has no card of its own. Named, not left to Next's file convention: a page
 * that sets `openGraph` replaces its parent's whole object, and the convention
 * only fills in the level its file sits at — so without this every page with
 * its own card text would share without a picture. The query is the version
 * above; the image route ignores it.
 */
export const SITE_CARD = {
  url: `/opengraph-image?${SITE_CARD_VERSION}`,
  width: 1200,
  height: 630,
  type: "image/png",
  alt: `${BRAND}: a slice of every trade, put aside for later.`,
} as const;

/** The square mark on white, for the structured data's logo: Google shows it on white. */
export const SITE_LOGO = { path: "/logo/logo800x800.png", width: 800, height: 800 } as const;

const OPEN_GRAPH_BASE = { siteName: BRAND, type: "website", locale: "en_US" } as const;
const TWITTER_BASE = { card: "summary_large_image" } as const;

/** One page's whole metadata, from its entry. */
export function pageMetadata(page: SitePage): Metadata {
  const card = { title: page.ogTitle, description: page.description };
  return {
    title: page.title,
    description: page.description,
    ...(page.canonical === null ? {} : { alternates: { canonical: page.canonical } }),
    ...(page.index ? {} : { robots: NOT_INDEXED }),
    openGraph: { ...OPEN_GRAPH_BASE, ...card, url: page.canonical ?? page.path, images: [SITE_CARD] },
    twitter: { ...TWITTER_BASE, ...card, images: [SITE_CARD] },
  };
}

/**
 * A docs page's metadata. Its own card, not the site's: docs/[slug]/opengraph-image.tsx
 * draws the page's title, and Next puts it in only while this `openGraph` has
 * NO images key — so there is none here, and the Twitter card takes the same
 * picture from it.
 */
export function docMetadata(page: DocEntry): Metadata {
  const title = docTitle(page);
  const card = { title, description: page.metaDescription };
  const path = docHref(page.slug);
  return {
    title,
    description: page.metaDescription,
    robots: DOCS_ROBOTS,
    alternates: { canonical: path },
    openGraph: { ...OPEN_GRAPH_BASE, ...card, url: path },
    twitter: { ...TWITTER_BASE, ...card },
  };
}

/**
 * GOOGLE SEARCH CONSOLE'S TOKEN, from SIP_GOOGLE_SITE_VERIFICATION: the owner
 * pastes it into Vercel and redeploys, no code change. The `content` value
 * only — but the whole <meta> tag Search Console offers is accepted too, since
 * that is what gets copied. Anything that is not a token is no tag at all.
 */
export function googleSiteVerification(env: Env = process.env): string | null {
  const raw = env["SIP_GOOGLE_SITE_VERIFICATION"]?.trim() ?? "";
  const token = raw.match(/content=["']([^"']*)["']/)?.[1] ?? raw;
  return /^[A-Za-z0-9_-]{10,100}$/.test(token) ? token : null;
}

/**
 * The root layout's metadata: the landing's title and description as every
 * page's default, the site's card, the site's address, and the verification
 * tag when there is one. No canonical and no og:url here: a page without its
 * own decision gets none rather than the landing's.
 */
export function rootMetadata(site: URL, env: Env = process.env): Metadata {
  const home = SITE_PAGES.home;
  const card = { title: home.ogTitle, description: home.description };
  const google = googleSiteVerification(env);
  return {
    metadataBase: site,
    title: home.title,
    description: home.description,
    openGraph: { ...OPEN_GRAPH_BASE, ...card, images: [SITE_CARD] },
    twitter: { ...TWITTER_BASE, ...card, images: [SITE_CARD] },
    ...(google === null ? {} : { verification: { google } }),
  };
}

/** Every page in the index, in the order the sitemap lists them: the site's pages, then the docs in reading order. */
export const INDEXED_PATHS: readonly string[] = [
  ...Object.values(SITE_PAGES)
    .filter((page: SitePage) => page.index && page.canonical === page.path)
    .map((page) => page.path),
  ...DOC_PAGES.map((page) => docHref(page.slug)),
];

/** sitemap.xml. No dates and no priorities: none is known, and an invented one is noise Google ignores. */
export function sitemapEntries(site: URL): MetadataRoute.Sitemap {
  return INDEXED_PATHS.map((path) => ({ url: absoluteUrl(path, site) }));
}

/** A Vercel deployment that is not production: a preview or a development build. */
export function isNonProductionDeployment(env: Env = process.env): boolean {
  const name = env["VERCEL_ENV"]?.trim() ?? "";
  return name !== "" && name !== "production";
}

/**
 * robots.txt. A preview is a copy of the site under another address: nothing
 * of it is crawled. Production lets everything be crawled but /api/ — its
 * routes are the app's own plumbing, and the Solana ones spend RPC credits on
 * every hit. Nothing else is blocked: a page Google may not fetch is a page
 * whose noindex it never reads, and /_next/ carries the scripts and styles it
 * renders with. (No "Disallow: /prices" for the JSON either — that would also
 * block /prices/view; the JSON says noindex in its own header.)
 */
export function robotsFor(site: URL, env: Env = process.env): MetadataRoute.Robots {
  if (isNonProductionDeployment(env)) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: "/api/" }],
    sitemap: absoluteUrl("/sitemap.xml", site),
  };
}

/**
 * /llms.txt (llmstxt.org): what SaverFi is in two lines, then every docs page
 * with its one-line description and its address, for an assistant asked about
 * SaverFi. Built from the docs' index, so it lists exactly the pages there are.
 */
export function llmsTxt(site: URL): string {
  const link = (title: string, path: string, note: string) => `- [${title}](${absoluteUrl(path, site)}): ${note}`;
  const lines = [
    `# ${BRAND}`,
    "",
    `> ${BRAND} builds you a pension from your trading, on Solana. A slice of every trade (a share of its profit, of its volume, or a round-up) goes into a vault only your own wallet can open, kept in SOL or invested in tokenised stocks: SPYx and the ANTHROPIC PreStock. ${BRAND} takes no fee, and it is in beta.`,
    "",
    ...DOC_GROUPS.flatMap((group) => [
      `## ${group.title}`,
      "",
      ...group.pages.map((page) => link(page.title, docHref(page.slug), page.metaDescription)),
      "",
    ]),
    "## Public pages",
    "",
    link("Leaderboard", SITE_PAGES.leaderboard.path, SITE_PAGES.leaderboard.description),
    link("Dashboard", SITE_PAGES.dashboard.path, SITE_PAGES.dashboard.description),
    link("Prices", SITE_PAGES.prices.path, SITE_PAGES.prices.description),
    link("Prices as JSON", "/prices", "The same readings as the prices page, as JSON: every figure with its source, its age, or why it could not be read."),
    "",
  ];
  return lines.join("\n");
}
