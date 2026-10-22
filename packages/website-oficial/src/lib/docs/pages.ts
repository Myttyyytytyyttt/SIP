/**
 * THE DOCS' INDEX (owner, 10-22): every page of /docs, in reading order, under
 * its group. The sidebar, the routes, the metadata and the Previous / Next links
 * are all read from this one list, so a page cannot be in one of them and
 * missing from another.
 *
 * THE LIST AND THE SLUGS ARE THE OWNER'S (10-22): 6 groups, 17 pages and 1
 * sub-page. A slug is also the name of its page's clip
 * (public/docs/clips/<slug>.{webm,mp4,webp}, see clips.ts), so renaming one
 * renames the other.
 *
 * NO STATUS TAGS (owner, 10-22). Nothing here, and nothing in a page, is marked
 * as live, on the way or an idea: every page is written in the present tense,
 * and /docs goes official only once all of it is true. Until then it is reached
 * by its URL alone: noindex, and the header's and footer's "Docs" links stay "#".
 *
 * EACH PAGE'S BODY IS ITS OWN MODULE, src/app/docs/_content/<slug>.tsx, so the
 * pages can be written independently. The title and the one-line description
 * live here because the sidebar and the metadata need them without the body.
 */

type PageInput = { readonly slug: string; readonly title: string; readonly description: string; readonly parent?: string };
type GroupInput = { readonly title: string; readonly pages: readonly PageInput[] };

const GROUPS = [
  {
    title: "Start here",
    pages: [
      { slug: "what-is-saverfi", title: "What is SaverFi?", description: "What SaverFi does for you, in one minute." },
      { slug: "pension-key", title: "Your pension key", description: "The wallet you connect, and why it matters." },
    ],
  },
  {
    title: "How saving works",
    pages: [
      { slug: "saving-from-profit", title: "Saving from your profit", description: "In Profit mode, what exactly is saved." },
      { slug: "saving-from-volume", title: "Saving from your volume", description: "In Volume mode, what exactly is saved." },
      { slug: "round-ups", title: "Saving with round-ups", description: "Each trade rounded up, and the difference saved." },
      {
        slug: "timing-and-limits",
        title: "When savings happen, and their limits",
        description: "How often SaverFi acts, and how much one saving can move.",
      },
    ],
  },
  {
    title: "Set up",
    pages: [
      { slug: "create-your-vault", title: "Create your vault", description: "What you need, what you choose, and what it costs." },
      { slug: "trading-wallets", title: "Trading wallets", description: "Where you trade from, and how to use it in Axiom or GMGN." },
      // THE ONE SUB-PAGE: indented under its parent in the sidebar, and read straight after it.
      {
        slug: "import-a-wallet",
        title: "Import a wallet you already use",
        description: "Save from a wallet you already trade with.",
        parent: "trading-wallets",
      },
    ],
  },
  {
    title: "Investing your savings",
    pages: [
      {
        slug: "investing",
        title: "Investing your savings",
        description: "What your savings can buy, when, at what price, and what stops it.",
      },
    ],
  },
  {
    title: "Day to day",
    pages: [
      { slug: "dashboard", title: "Reading your dashboard", description: "What the numbers and signals mean." },
      { slug: "change-settings", title: "Change your settings", description: "Change your rate, your mode or your basket, or pause saving." },
      { slug: "take-money-out", title: "Take money out", description: "How to withdraw your savings to your own wallet." },
      { slug: "not-saving", title: "Why isn\u2019t it saving?", description: "What to check when nothing arrives." },
      {
        slug: "public-pages",
        title: "Public pages: leaderboard, stats and prices",
        description: "How SaverFi is doing, and where its prices come from.",
      },
    ],
  },
  {
    title: "Trust and safety",
    pages: [
      { slug: "fees", title: "Fees", description: "What SaverFi costs you." },
      { slug: "who-controls-what", title: "Who controls what", description: "Who can move your money, and what SaverFi\u2019s team can do." },
      { slug: "risks-and-beta", title: "Risks and beta status", description: "What can go wrong, and how far SaverFi has been proven." },
    ],
  },
] as const satisfies readonly GroupInput[];

/** A page's address under /docs, and the name of its clip. */
export type DocSlug = (typeof GROUPS)[number]["pages"][number]["slug"];

export type DocPage = {
  readonly slug: DocSlug;
  readonly title: string;
  /** One sentence: under the title on the page, and the page's meta description. */
  readonly description: string;
  /** A sub-page names its parent, which must be in the same group, just before it. */
  readonly parent?: DocSlug;
};

export type DocGroup = { readonly title: string; readonly pages: readonly DocPage[] };

/** A page with the title of the group it sits in. */
export type DocEntry = DocPage & { readonly group: string };

/** The groups, in order. Typed here, so a `parent` that names no page fails to compile. */
export const DOC_GROUPS: readonly DocGroup[] = GROUPS;

/** Every page, in reading order: the order of the sidebar and of Previous / Next. */
export const DOC_PAGES: readonly DocEntry[] = DOC_GROUPS.flatMap((group) => group.pages.map((page) => ({ ...page, group: group.title })));

const BY_SLUG: ReadonlyMap<string, DocEntry> = new Map(DOC_PAGES.map((page) => [page.slug, page]));

/** Where /docs itself sends a reader. */
export const FIRST_DOC: DocEntry = DOC_PAGES[0]!;

export function isDocSlug(value: string): value is DocSlug {
  return BY_SLUG.has(value);
}

/** The page at this slug, or null for one that is not in the index. */
export function docPage(slug: string): DocEntry | null {
  return BY_SLUG.get(slug) ?? null;
}

export function docHref(slug: DocSlug): string {
  return `/docs/${slug}`;
}

/**
 * WHERE A LINK TO THE DOCS GOES (owner, 10-22: the header, the footer and the
 * landing link them): straight to the first page, never to /docs. /docs is a
 * redirect, so it would cost every reader a hop — and the header's tabs raise
 * the route loader until the path they named is on screen (route-loader.tsx),
 * which /docs never is: the loader would hang for its whole MAX_MS.
 */
export const DOCS_HOME: string = docHref(FIRST_DOC.slug);

/** The page a pathname shows, or null off /docs or on an address that is not a page. */
export function docSlugOf(pathname: string | null): DocSlug | null {
  const match = pathname?.match(/^\/docs\/([^/?#]+)\/?$/);
  const slug = match?.[1];
  return slug !== undefined && isDocSlug(slug) ? slug : null;
}

/** The pages before and after this one in reading order: the links at the bottom of every page. */
export function docNeighbours(slug: DocSlug): { readonly previous: DocEntry | null; readonly next: DocEntry | null } {
  const at = DOC_PAGES.findIndex((page) => page.slug === slug);
  return { previous: DOC_PAGES[at - 1] ?? null, next: at === -1 ? null : (DOC_PAGES[at + 1] ?? null) };
}

/** "<Page> · SaverFi Docs": the browser tab's title for every page. */
export function docTitle(page: DocPage): string {
  return `${page.title} · SaverFi Docs`;
}

/**
 * NOT INDEXED, NOT FOLLOWED (owner, 10-22): the docs describe the product as it
 * will be once everything in them is true, and the owner makes them official
 * then. Set on the docs' layout and again on every page, so no page can drop it
 * by setting metadata of its own.
 */
export const DOCS_ROBOTS = { index: false, follow: false } as const;
