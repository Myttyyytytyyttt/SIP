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
 * as live, on the way or an idea: every page is written in the present tense.
 * The docs are public: linked from the header, the footer and the landing, and
 * indexed by search engines (owner, 10-22, both).
 *
 * EACH PAGE'S BODY IS ITS OWN MODULE, src/app/docs/_content/<slug>.tsx, so the
 * pages can be written independently. The title, the one-line description and
 * the search engines' description live here because the sidebar and the
 * metadata need them without the body.
 *
 * TWO DESCRIPTIONS, ON PURPOSE. `description` is the line under the title, on
 * the page. `metaDescription` is only what a search result shows under the
 * link: whole sentences that name SaverFi and say what the page answers, up to
 * 160 characters — the page's line is too short for that, and changing it would
 * change the page. Each one says only what its page says.
 */

type PageInput = {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly metaDescription: string;
  readonly parent?: string;
};
type GroupInput = { readonly title: string; readonly pages: readonly PageInput[] };

const GROUPS = [
  {
    title: "Start here",
    pages: [
      {
        slug: "what-is-saverfi",
        title: "What is SaverFi?",
        description: "What SaverFi does for you, in one minute.",
        metaDescription:
          "SaverFi builds you a pension from your Solana trading: a slice of each trade, from profit, volume or round-ups, goes to a vault only your wallet can open.",
      },
      {
        slug: "pension-key",
        title: "Your pension key",
        description: "The wallet you connect, and why it matters.",
        metaDescription:
          "Your pension key is the Solana wallet you connect to SaverFi, such as Phantom. It owns your vault: only it can withdraw or change how you save.",
      },
    ],
  },
  {
    title: "How saving works",
    pages: [
      {
        slug: "saving-from-profit",
        title: "Saving from your profit",
        description: "In Profit mode, what exactly is saved.",
        metaDescription:
          "In Profit mode, SaverFi saves a share of each SOL gain your trading wallet makes, 20 % to start. A loss saves nothing and comes off your next gain.",
      },
      {
        slug: "saving-from-volume",
        title: "Saving from your volume",
        description: "In Volume mode, what exactly is saved.",
        metaDescription:
          "In Volume mode, SaverFi saves a small share of every buy and every sell your trading wallet makes, win or lose: 2 % to start, measured on the SOL side.",
      },
      {
        slug: "round-ups",
        title: "Saving with round-ups",
        description: "Each trade rounded up, and the difference saved.",
        metaDescription:
          "With round-ups, SaverFi rounds each trade\u2019s dollar value up to a unit you choose and saves the difference in SOL, up to a daily cap.",
      },
      {
        slug: "timing-and-limits",
        title: "When savings happen, and their limits",
        description: "How often SaverFi acts, and how much one saving can move.",
        metaDescription:
          "SaverFi checks your trading wallets about once a minute. The most one saving moves (0.06 SOL by default), the 0.05 SOL your wallet keeps, and the fee.",
      },
    ],
  },
  {
    title: "Set up",
    pages: [
      {
        slug: "create-your-vault",
        title: "Create your vault",
        description: "What you need, what you choose, and what it costs.",
        metaDescription:
          "Create your SaverFi vault in one approval: connect your Solana wallet, choose how you save and your rate, and see the one-off rent before you sign.",
      },
      {
        slug: "trading-wallets",
        title: "Trading wallets",
        description: "Where you trade from, and how to use it in Axiom or GMGN.",
        metaDescription:
          "SaverFi creates a trading wallet linked to your vault. It watches the wallet, not the app, so trades save wherever you use it: Axiom, GMGN or any app.",
      },
      // THE ONE SUB-PAGE: indented under its parent in the sidebar, and read straight after it.
      {
        slug: "import-a-wallet",
        title: "Import a wallet you already use",
        description: "Save from a wallet you already trade with.",
        metaDescription:
          "Import a Solana wallet you already trade from, in Phantom, Solflare, Axiom, GMGN or a bot, and SaverFi saves from it like a trading wallet it created.",
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
        metaDescription:
          "Keep your SaverFi savings in SOL, or buy tokenised stocks: SPYx, which follows an S&P 500 fund, and the ANTHROPIC PreStock, at the live market price.",
      },
    ],
  },
  {
    title: "Day to day",
    pages: [
      {
        slug: "dashboard",
        title: "Reading your dashboard",
        description: "What the numbers and signals mean.",
        metaDescription:
          "How to read your SaverFi dashboard: saved so far, pension value, your savings rule, the next investment, and what SaverFi is doing with your savings now.",
      },
      {
        slug: "change-settings",
        title: "Change your settings",
        description: "Change your rate, your mode or your basket, or pause saving.",
        metaDescription:
          "Change how SaverFi saves for you: Profit, Volume or Round-ups, your rate, what your savings buy, the investment threshold, or pause saving.",
      },
      {
        slug: "take-money-out",
        title: "Take money out",
        description: "How to withdraw your savings to your own wallet.",
        metaDescription:
          "Withdraw your SaverFi savings at any time: SOL, USDC or your stock tokens go only to your pension key, in one approval. SaverFi never sells your stocks.",
      },
      {
        slug: "not-saving",
        title: "Why isn\u2019t it saving?",
        description: "What to check when nothing arrives.",
        metaDescription:
          "SaverFi not saving? Usually nothing is owed yet. Check, in order: your mode\u2019s rules, a trading wallet at its 0.05 SOL reserve, or a wallet that needs you.",
      },
      {
        slug: "public-pages",
        title: "Public pages: leaderboard, stats and prices",
        description: "How SaverFi is doing, and where its prices come from.",
        metaDescription:
          "SaverFi\u2019s public pages, no wallet needed: the leaderboard ranking pensions by points, every pension added up, and where each price comes from.",
      },
    ],
  },
  {
    title: "Trust and safety",
    pages: [
      {
        slug: "fees",
        title: "Fees",
        description: "What SaverFi costs you.",
        metaDescription:
          "SaverFi takes no fee: all of each saving reaches your vault. What you do pay: Solana network fees, one-off rent, and for some PreStocks their issuer\u2019s fee.",
      },
      {
        slug: "who-controls-what",
        title: "Who controls what",
        description: "Who can move your money, and what SaverFi\u2019s team can do.",
        metaDescription:
          "Only your pension key can withdraw from your SaverFi vault. What the keeper can and cannot do, and how the team can pause saving but never a withdrawal.",
      },
      {
        slug: "risks-and-beta",
        title: "Risks and beta status",
        description: "What can go wrong, and how far SaverFi has been proven.",
        metaDescription:
          "SaverFi is in beta. The risks: prices can fall, stock issuers hold power over their tokens, and SaverFi is young. What has been proven on mainnet so far.",
      },
    ],
  },
] as const satisfies readonly GroupInput[];

/** A page's address under /docs, and the name of its clip. */
export type DocSlug = (typeof GROUPS)[number]["pages"][number]["slug"];

export type DocPage = {
  readonly slug: DocSlug;
  readonly title: string;
  /** One sentence, under the title on the page. */
  readonly description: string;
  /** What a search result shows under the link (see the top of this file). Never on the page. */
  readonly metaDescription: string;
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

/**
 * "<Page> — SaverFi Docs": the browser tab's title and the search result's
 * headline. The same " — " as every other page of the site (src/lib/seo.ts).
 */
export function docTitle(page: DocPage): string {
  return `${page.title} — SaverFi Docs`;
}

/**
 * INDEXED AND FOLLOWED (owner, 10-22: "quita el noindex para que salga en
 * Google"): the docs are public, and they hold most of what the site says
 * about how SaverFi works. Said on the docs' layout and again on every page, so
 * a page that sets metadata of its own still says it.
 */
export const DOCS_ROBOTS = { index: true, follow: true } as const;
