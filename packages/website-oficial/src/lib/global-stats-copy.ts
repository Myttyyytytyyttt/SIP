/**
 * EVERY SENTENCE OF THE PUBLIC DASHBOARD (/dashboard), in one place, so a test
 * can read them all: the brand, what each figure is and is not, and why a
 * figure is missing.
 *
 * ITS OWN OBJECT, NOT STATS_COPY. "Stats" is the pension page's own tile
 * heading, and that object may not hold the mode name "Volume" as a value
 * (src/lib/live-copy.test.ts). These sentences are about every pension at
 * once, so they say "pensions", "settlements" and "put aside", never "keeper"
 * or "vault"; an amount traded is "in buys and sells".
 *
 * A REASON IS WORDED FOR A VISITOR. The operator's sentence — which names the
 * service and its variable — stays in the server log; the page says what the
 * reader can understand and does not guess at a cause it cannot know.
 *
 * SHORT TITLES, NO SUBTEXT (owner, 10-24, after the pension page on 10-23:
 * "lo que esté de más, quítalo"). No grey line under a title or a figure, and
 * no footer explaining the method. What a figure must still say — that days
 * are UTC, why it is "at least", which price made a dollar — is a `hint`: the
 * hover of that figure or title. An `info` is a "?", kept only where a reader
 * would read the figure wrong without it.
 */

import type { Reason } from "@/lib/global-stats-model";
import { BRAND } from "@/lib/live-copy";

export const GLOBAL_STATS_COPY = {
  title: "Dashboard",
  // What a search result shows (10-22): the title says what the page is, the description what it holds.
  metaTitle: `Dashboard: every pension added up — ${BRAND}`,
  metaDescription: `Every ${BRAND} pension added up: what settlements put aside on Solana, how often, and which tokenised stocks pensions bought. Figures by UTC day.`,

  updated: (ago: string) => `Updated ${ago}`,
  // The hover of the line under the title; every chart's tooltip also heads its day with "UTC".
  daysUtc: "Days are UTC",
  span: (from: string, to: string) => `Settlements from ${from} to ${to}`,
  spanUpTo: (to: string) => `Settlements up to ${to}`,
  chartsUpdated: (ago: string) => `Charts updated ${ago}`,
  noSettlementYet: "No settlement yet",

  sampleBadge: "Sample data",
  sampleNotice: "Not real pensions.",
  sampleNoticeHint: "Example figures for invented pensions, to show how this page reads",
  sampleCardBadge: "Sample",
  seeLive: "See the live numbers",
  seeSample: "See sample data",

  failedTitle: "The figures could not be read",

  saved: {
    title: "Put aside so far",
    // A "?" KEPT: the lead figure is what went in, not a balance — a title would not open on a phone.
    info: "What went in: withdrawals are not taken off.",
    atLeast: "at least",
    atLeastHint: "The history was cut: the real figure is higher",
  },
  traded: {
    title: "In buys and sells",
    // A "?" KEPT: the one figure on the page that is not an accounting one, and nothing else on the card says how it falls short.
    info: "Approximate: Profit and Volume are measured differently, and trades with no SOL side are not counted.",
    partial: "Not every pension is in this figure",
  },
  // The dollar value under a SOL headline. Which price made it is its hover.
  dollars: (usd: string) => `≈ ${usd}`,
  atLeastDollars: (usd: string) => `at least ≈ ${usd}`,
  dollarsHint: "At today’s SOL price, not what it was worth on the day",
  sampleDollarsHint: "At a sample SOL price",
  noDollars: "No dollar value",
  growth: (percent: string) => `+${percent} in 7 days`,

  strip: {
    solPrice: "SOL price",
    sampleSolPrice: "SOL price (sample)",
    todaySettlements: "Settlements today",
    todaySaved: "Put aside today",
    settlementsOn: (day: string) => `Settlements on ${day}`,
    savedOn: (day: string) => `Put aside on ${day}`,
    pensions: "Pensions",
    assets: "Assets on offer",
    todayIsUtc: "Today is the UTC day the figures were added up",
  },

  leaders: {
    title: "Leading pensions",
    // A "?" KEPT: the rows need not follow their Put aside column, and below md the Days column is hidden. No points formula (owner, 10-22).
    info: "Ranked by leaderboard points, not by size alone.",
    seeAll: "See the leaderboard",
    empty: "No settlements yet",
    emptyNothingSaved: "Nothing put aside yet",
    rank: "#",
    pension: "Pension",
    saved: "Put aside",
    traded: "In buys and sells",
    settlements: "Settlements",
    days: "Days",
  },

  assets: {
    title: "Assets",
    asset: "Asset",
    invested: "Invested (USDC)",
    share: "Share",
    purchases: "Purchases",
    onOffer: "On offer",
    unlisted: "No longer listed",
  },

  pensions: {
    title: "Pensions",
    hint: "With at least one settlement: not every pension created, and not a count of people",
  },
  settlements: {
    title: "Settlements",
    hint: "Including the ones that put nothing aside",
    paying: (n: string) => `${n} put something aside`,
  },
  invested: {
    title: "Invested",
    buys: (buys: string, one: boolean) => (one ? "1 purchase" : `${buys} purchases`),
  },
  shelf: {
    title: "Assets on offer",
    hint: "From the app’s own list, not from the chain",
  },
  atLeast: "at least",

  byMode: {
    title: "Profit and Volume",
    // Before the share, in the figure's qualifier slot: without it the large % does not say whose it is.
    label: "Profit",
    hint: "Share of what was put aside that came from Profit pensions",
    row: (sol: string, settlements: string) => `${sol} SOL · ${settlements}`,
    nothing: "Nothing put aside yet",
  },
  average: {
    // The pension page's Live tile says the same since 10-23.
    title: "Avg settlement",
    hint: "Settlements that put nothing aside are left out",
    nothing: "Nothing put aside yet",
  },

  coming: {
    title: "No daily charts yet",
    link: "See them in the sample",
  },

  charts: {
    // The unit in the title: the y axis carries none, and the grey line that named it is gone.
    saved: { title: "Put aside per day (SOL)" },
    settlements: { title: "Settlements per day", hint: "Including the ones that put nothing aside" },
    pensions: { title: "Active pensions per day", hint: "Pensions with at least one settlement that day" },
    invested: { title: "Invested per day (USDC)", hint: "By the day it was recorded" },
    rangeLabel: "Range",
    range30: "30D",
    range90: "90D",
    rangeAll: "All",
    perPeriod: "Per period",
    cumulative: "Running total",
    share: "Share of each period",
    daily: "Daily",
    weekly: "Weekly",
    periodLabel: "One bar per",
    viewLabel: "View",
    // The hover of a card's title when days are missing; a day nobody read also says "Could not be read" in its own tooltip.
    partial: "Some days could not be read",
    unread: "Could not be read",
    atLeast: "at least",
    empty: "No settlements yet",
    emptyInvested: "Nothing bought yet",
    total: "Total",
    soFar: "so far",
    running: "running total",
    nothingInPeriod: "Nothing put aside",
  },

  reason: {
    "not-served-yet": "This figure is not published yet.",
    "source-unconfigured": "This deployment is not connected to the settlement service.",
    "source-misconfigured": "This deployment’s connection to the settlement service is not set up correctly.",
    "source-unreachable": "The settlement service did not answer.",
    "source-not-ready": "The settlement service has nothing to give right now. It may be starting.",
    "source-refused": "The settlement service refused the request.",
    "source-not-understood": "The settlement service answered with something this page does not understand.",
    "field-unreadable": "This figure was missing from the answer.",
    // A sentence of their own since 10-24: they no longer follow "No dollar value: ", they are its hover.
    "price-unconfigured": "This deployment cannot read the SOL price.",
    "price-unread": "The SOL price could not be read right now.",
  } satisfies Record<Reason, string>,
} as const;
