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
 */

import type { Reason } from "@/lib/global-stats-model";
import { BRAND } from "@/lib/live-copy";

export const GLOBAL_STATS_COPY = {
  title: "Dashboard",
  metaTitle: `Dashboard — ${BRAND}`,
  metaDescription: `Every ${BRAND} pension added up: what settlements put aside, how often, and what pensions bought. Days are UTC.`,
  subtitle: `Every ${BRAND} pension, added up. Check the numbers and how the protocol is running.`,
  sheet: `Figures for every ${BRAND} pension, added up. Days are UTC.`,

  updated: (ago: string) => `Updated ${ago}`,
  daysUtc: "Days are UTC",
  span: (from: string, to: string) => `Settlements from ${from} to ${to}`,
  spanUpTo: (to: string) => `Settlements up to ${to}`,
  chartsUpdated: (ago: string) => `Charts updated ${ago}`,
  noSettlementYet: "No settlement yet",

  sampleBadge: "Sample data",
  sampleNotice: "Example figures for invented pensions, to show how this page reads. Not real pensions.",
  sampleCardBadge: "Sample",
  seeLive: "See the live numbers",
  seeSample: "See sample data",

  failedTitle: "The figures could not be read",
  failedDescription: "This is not a page of zeros: nothing was read.",

  saved: {
    title: "Put aside so far",
    description: "Across every pension, in SOL.",
    caption: "SOL put aside",
    info: "What settlements have put aside into pensions, in every mode, as the settlement history recorded it. It is what went in: withdrawals are not taken off.",
    atLeast: "at least",
    atLeastInfo: "The history this total was read from was cut, so the real figure is higher.",
  },
  traded: {
    title: "In buys and sells",
    description: "What the trading behind those settlements moved, in SOL.",
    caption: "SOL in buys and sells",
    info: "An approximate measure of the trading each settlement was charged on. Profit and Volume pensions are measured differently, a trade with no SOL side is not counted, and some early settlements recorded none.",
    provenance: "An approximate measure, not an accounting figure.",
    partial: "Not every pension is in this figure.",
  },
  dollars: (usd: string) => `≈ ${usd} at today’s SOL price`,
  sampleDollars: (usd: string) => `≈ ${usd} at a sample SOL price`,
  atLeastDollars: (usd: string) => `at least ≈ ${usd} at today’s SOL price`,
  atLeastSampleDollars: (usd: string) => `at least ≈ ${usd} at a sample SOL price`,
  noDollars: (why: string) => `No dollar value: ${why}`,
  across: (pensions: string) => `across ${pensions}`,
  growth: (percent: string) => `+${percent} in 7 days`,
  acrossAtLeast: (pensions: string) => `across at least ${pensions}`,
  since: (day: string) => `since ${day}`,

  strip: {
    solPrice: "SOL price",
    sampleSolPrice: "SOL price (sample)",
    todaySettlements: "Settlements today",
    todaySaved: "Put aside today",
    settlementsOn: (day: string) => `Settlements on ${day}`,
    savedOn: (day: string) => `Put aside on ${day}`,
    pensions: "Pensions",
    assets: "Assets on offer",
    todayIsUtc: "Today is the UTC day the figures were added up.",
  },

  leaders: {
    title: "Leading pensions",
    description: "The top of the all-time leaderboard: each one can be checked on the chain.",
    info: "Ranked as on the leaderboard: by days with a settlement and by what was put aside, not by size alone. Each pension is its own address on Solana.",
    seeAll: "See the leaderboard",
    empty: "No pension has had a settlement yet.",
    emptyNothingSaved: "No settlement has put anything aside yet.",
    rank: "#",
    pension: "Pension",
    saved: "Put aside",
    traded: "In buys and sells",
    settlements: "Settlements",
    days: "Days",
  },

  assets: {
    title: "Assets",
    description: "What a pension can buy, and what pensions spent on each, in USDC.",
    info: "Every asset the app lists, and the USDC pensions spent buying each one, as the settlement history recorded it.",
    asset: "Asset",
    invested: "Invested (USDC)",
    share: "Share",
    purchases: "Purchases",
    onOffer: "On offer",
    unlisted: "No longer listed",
  },

  pensions: {
    title: "Pensions",
    caption: "with a settlement",
    info: "Pensions that have had at least one settlement. Not every pension ever created, and not a count of people.",
  },
  settlements: {
    title: "Settlements",
    caption: "both modes",
    paying: (n: string) => `${n} put something aside`,
    info: "Each time a pension was settled, including the times nothing was put aside.",
  },
  invested: {
    title: "Invested",
    caption: (buys: string, one: boolean) => (one ? "USDC, in 1 purchase" : `USDC, in ${buys} purchases`),
    captionNoBuys: "USDC spent by pensions",
    info: "What pensions spent buying the assets in their basket, in USDC.",
  },
  shelf: {
    title: "Assets on offer",
    caption: (symbols: string, listed: string) => `${symbols} · of ${listed} listed`,
    info: "What a pension can choose to buy today. This comes from the app’s own list, not from the chain.",
  },
  atLeast: "at least",

  byMode: {
    title: "Profit and Volume",
    description: "Which mode the SOL put aside came from.",
    caption: "of what was put aside came from Profit pensions",
    info: "A Profit pension puts aside a share of what its trading gained; a Volume pension a share of every buy and sell.",
    row: (sol: string, settlements: string) => `${sol} SOL · ${settlements}`,
    nothing: "Nothing has been put aside yet.",
  },
  average: {
    title: "Per settlement",
    description: "What one settlement puts aside, on average.",
    caption: "SOL, across the settlements that put something aside",
    info: "The SOL put aside, divided by the settlements that put something aside. Settlements that put nothing aside are left out of it.",
    nothing: "No settlement has put anything aside yet.",
  },

  coming: {
    title: "Daily charts are not available yet",
    body: "The day-by-day history behind these totals is not published yet. When it is, this page will chart what was put aside each day, the settlements, the pensions active each day and what pensions bought.",
    link: "See the charts with sample data",
  },

  charts: {
    traded: {
      description: "What the trading behind settlements moved, by mode, in SOL. Days are UTC.",
    },
    saved: {
      title: "Put aside per day",
      description: "SOL put aside by settlements, by mode. Days are UTC.",
      info: "Each bar is what settlements put aside that day or week, split by the pension’s mode.",
    },
    settlements: {
      title: "Settlements",
      description: "How many settlements ran, by mode. Days are UTC.",
      info: "Each bar counts the settlements of that day or week, the ones that put nothing aside included.",
    },
    pensions: {
      title: "Active pensions",
      description: "Pensions with at least one settlement that day. Days are UTC.",
      info: "A pension counts once a day, whichever mode it is in. Days do not add up to weeks, so this chart has no weekly view.",
    },
    invested: {
      title: "Invested",
      description: "USDC pensions spent on their assets, by the day it was recorded. Days are UTC.",
      info: "Each bar is what pensions spent buying their basket that day or week.",
    },
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
    activeDays: (n: number) => (n === 1 ? "1 day with a settlement" : `${n} days with a settlement`),
    purchaseDays: (n: number) => (n === 1 ? "1 day with a purchase" : `${n} days with a purchase`),
    savingDays: (n: number) => (n === 1 ? "1 day that put something aside" : `${n} days that put something aside`),
    // Not "with a settlement": a settlement can record no trading (the first ones did), and its day has no bar here.
    tradedDays: (n: number) => (n === 1 ? "1 day with trading measured" : `${n} days with trading measured`),
    runningSince: (day: string) => `Running total since ${day}`,
    partial: "Some days could not be read: their bars show only what was read.",
    unread: "Could not be read",
    atLeast: "at least",
    empty: "No settlement yet. The first one starts this chart.",
    emptyInvested: "Nothing bought yet. The first purchase starts this chart.",
    total: "Total",
    soFar: "so far",
    running: "running total",
    nothingInPeriod: "Nothing put aside",
    byAsset: "All time",
  },

  footnote:
    "All days are UTC. Amounts are in SOL, or USDC for what pensions bought; a dollar figure is today’s SOL price applied to the total, not what it was worth on the day.",
  sampleFootnote: "All days are UTC. Amounts are in SOL, or USDC for what pensions bought; in this sample, a dollar figure is a sample SOL price applied to the total.",

  reason: {
    "not-served-yet": "This figure is not published yet.",
    "source-unconfigured": "This deployment is not connected to the settlement service.",
    "source-misconfigured": "This deployment’s connection to the settlement service is not set up correctly.",
    "source-unreachable": "The settlement service did not answer.",
    "source-not-ready": "The settlement service has nothing to give right now. It may be starting.",
    "source-refused": "The settlement service refused the request.",
    "source-not-understood": "The settlement service answered with something this page does not understand.",
    "field-unreadable": "This figure was missing from the answer.",
    "price-unconfigured": "this deployment cannot read the SOL price.",
    "price-unread": "the SOL price could not be read right now.",
  } satisfies Record<Reason, string>,
} as const;
