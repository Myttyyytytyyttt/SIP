/**
 * EVERY SENTENCE THE LIVE DASHBOARD SAYS, in one place.
 *
 * THE PUBLIC NAME IS SaverFi. The code, the packages and the SIP_* settings keep
 * their old name — renaming those is a separate pass — but nothing a user reads
 * from this module does. live-copy.test.ts fails on that word appearing here.
 *
 * THE RULE EVERY SENTENCE BELOW OBEYS: say what is known, and say plainly when
 * something is not. A dashboard reads as a statement about somebody's money, so
 * "could not be read" must never come out as a zero, and an example must never
 * come out without the word example next to it.
 *
 * Amounts and rates arrive already written as text (src/lib/amounts.ts), so this
 * module stays pure and client-safe. VAULT_COPY, INVEST_COPY and FAILURE_COPY
 * are reused wherever the sentence is already written there.
 */

/** The public name. The code and its settings keep theirs. */
export const BRAND = "SaverFi";

/** The Live|Mock control, and the one note that goes over the sample. */
export const MODE_COPY = {
  label: "Data source",
  live: "Live",
  mock: "Mock",
  sampleBadge: "Sample data",
  /** Nobody connected, showing the sample. It no longer promises live numbers later. */
  sample: `Example numbers. Nobody’s pension. Connect your pension key to see your ${BRAND} pension.`,
  /** Signed in with no Solana wallet, showing the sample: says what to do about it. */
  keyless: `Example numbers. Nobody’s pension. This session has no Solana wallet: disconnect, then connect Phantom, Backpack, Solflare or another Solana wallet to see your ${BRAND} pension.`,
} as const;

/** The states the dashboard can be in before it has a pension to show. */
export const LIVE_COPY = {
  // ── waiting for Privy ──────────────────────────────────────────────────────
  /** The skeleton's accessible name while Privy is asked. */
  checking: "Checking for a connected wallet",
  checkingWallet: "Checking for a connected wallet…",

  /** After the 15 s patience runs out. */
  stalledTitle: "Wallet sign-in has not loaded",
  stalledBody:
    `${BRAND} uses Privy (auth.privy.io) to see which wallet is connected, and it has not answered. Reload the page. ` +
    "If this keeps happening, a browser extension may be blocking auth.privy.io.",
  reload: "Reload",
  viewSample: "View sample data",

  // ── nobody connected ───────────────────────────────────────────────────────
  connectTitle: "Connect your pension key",
  connectBody:
    `Live shows your own ${BRAND} pension, read from Solana: what your vault holds, what your trading wallets saved ` +
    "and what it bought. Connect the Solana wallet that owns it: Phantom, Backpack, Solflare or another.",
  connectButton: "Connect pension key",
  /** Under the connect card: says exactly where sample numbers can and cannot appear. */
  connectFootnote: "Nothing is shown until a wallet is connected. Sample numbers appear only under Mock.",
  connectSidebar: "Connect your pension key to see your activity.",
  seeSample: "See sample data",

  // ── signed in with no pension key ──────────────────────────────────────────
  keylessTitle: "This session has no pension key",
  keylessBody:
    "You are signed in without a Solana wallet of your own, and the pension key must be one. Disconnect, then connect " +
    "Phantom, Backpack, Solflare or another Solana wallet.",
  disconnect: "Disconnect",

  // ── this deployment cannot serve Live at all ───────────────────────────────
  unavailableTitle: "Live is not available here yet",
  unavailableBody: "Live data is not available on this deployment yet.",
  unavailableSidebar: "Live data is not available on this deployment yet.",
  connect: "Connect",

  // ── connected, reading ─────────────────────────────────────────────────────
  reading: "Reading your pension on Solana",
  readingSidebar: "Reading your activity on Solana",

  // ── connected, and the read failed ─────────────────────────────────────────
  unreadableTitle: "Your pension could not be read",
  unreadableBody: `${BRAND} could not read your pension on Solana just now. Nothing is shown rather than a guess.`,
  retry: "Retry",
  /** A 429 from this browser's own bucket: says when, not just that. */
  rateLimited: (seconds: number | null): string =>
    seconds === null ? "Too many requests from this browser just now. Trying again shortly." : `Too many requests from this browser just now. Trying again in ${seconds} s.`,
  network: `${BRAND} could not be reached. Check your connection, then try again.`,
  deploymentUnavailable: "Live data is not available on this deployment right now.",
  /** A retry that is still waiting out a retry-after. */
  retryIn: (seconds: number): string => `Try again in ${seconds} s`,

  // ── a later poll failed, with good data still on screen ────────────────────
  /** Never styled as an alarm, and it never falls back to the sample. */
  staleAsOf: (clock: string, seconds: number): string => `Showing Solana as of ${clock}. The last read failed; trying again in ${seconds} s.`,
  /** The same, when the server named no retry time. */
  staleAsOfPending: (clock: string): string => `Showing Solana as of ${clock}. The last read failed; trying again shortly.`,
  staleLong: "These numbers may be out of date.",

  // ── the sidebar ────────────────────────────────────────────────────────────
  pensionKey: "Pension key",
  tradingWallets: "Trading wallets",
  activity: "Activity",
  manageWallets: "Manage wallets",
  solscanAccount: "Solscan",
  viewLink: "View link on Solscan",
  noWalletsYet: "No trading wallet on this account yet.",

  /** A wallet's link, as a badge. Four outcomes, and "unreadable" is its own. */
  badgeLinked: "Linked",
  badgeNotLinked: "Not linked",
  badgeOtherVault: "Saves into another vault",
  badgeLinkUnreadable: "Link status unreadable",
  settlementCount: (count: string): string => `${count} ${count === "1" ? "settlement" : "settlements"}`,
  settlementCountUnknown: "settlements unknown",
  /** Why a linked wallet still saves nothing: it holds no more than it always keeps. */
  reserveNote: (reserve: string): string => `Holds no more than the ${reserve} SOL it always keeps, so nothing can be settled from it yet.`,
  /** The same, where the reserve figure is already on screen beside it. */
  reserveNoteShort: "Holds no more than the SOL it always keeps, so nothing can be settled from it yet.",

  // ── the pension card ───────────────────────────────────────────────────────
  savedSoFar: "Saved so far",
  /** "≈ $X at today's SOL price · Profit · 20 % of trading gains · since Sep 15, 2026". */
  heroAbout: (usd: string): string => `≈ ${usd} at today’s SOL price`,
  heroProfit: (rate: string): string => `Profit · ${rate} of trading gains`,
  heroVolumeNotOffered: (rate: string): string => `Volume · ${rate} · not settled while ${BRAND} cannot measure volume`,
  heroSince: (date: string): string => `since ${date}`,
  worthNow: "Worth now",
  worthNowTooltip: "SOL and SPYx at today’s Raydium pool prices; USDC counted at $1",
  pricesUnavailable: "Prices unavailable",
  /** The PROGRAM's own counter: USDC that invest() has spent. Not the basket's value below. */
  investedSoFar: "Invested so far",
  investedSoFarTooltip: "USDC the keeper has spent buying your basket, counted by your vault’s own policy. Tokens that reached the vault any other way are not in it.",
  unknownFigure: "—",

  // ── the chart ──────────────────────────────────────────────────────────────
  chartLabel: "Saved",
  chartSince: (date: string): string => `Since ${date}`,
  chartComplete: "Complete history",
  chartEmpty: "The chart starts with your first settlement.",
  /**
   * The vault has saved, and not one settlement is in the pages loaded here —
   * so there is no window to draw a line across, and "starts with your first
   * settlement" would be a statement the vault's own total contradicts.
   */
  chartOutsideHistory: "Your settlements are not in the history loaded here, so there is no line to draw yet. Saved so far above is your vault’s own total.",
  /** The flat line's caption: it is flat BECAUSE nothing settled in that window. */
  chartFlat: "No settlement landed in this window, so the line is level at your vault’s own total.",

  // ── the holdings table ─────────────────────────────────────────────────────
  holdings: "Holdings",
  asset: "Asset",
  shares: "Shares",
  value: "Value",
  weightVsTarget: "Weight vs target",
  target: "target",
  notInvestedYet: "Not invested yet",
  /**
   * The leg holdings' worth at today's prices — a VALUATION, not a total of
   * what was spent. It shared the word "Invested" with the program's
   * lifetime_invested counter on the same card, which reads $0.00 beside a
   * basket worth $86.41 whenever SPYx reached the vault by any route other
   * than invest().
   */
  invested: "Basket value",
  /** The SOL row: what a withdrawal can take, and what Solana keeps. */
  solKeptAsRent: (rent: string): string => `withdrawable, ${rent} SOL kept as rent`,
  holdingsFootnote: "Tokens in other accounts the vault owns are listed under Manage wallets.",
  tokensUnreadable: `${BRAND} could not read the vault’s tokens just now.`,
  pricesUnreadableNote: "Today’s prices could not be read, so dollar values are hidden.",

  // ── the rule card ──────────────────────────────────────────────────────────
  ruleTitle: "Savings rule",
  ruleDescription: "Read from Solana. Set when your vault was created.",
  vaultSection: "Vault",
  mode: "Mode",
  modeProfit: (rate: string): string => `Profit · ${rate}`,
  modeVolume: (rate: string): string => `Volume · ${rate}`,
  mostPerSettlement: (max: string): string => `Most per settlement ${max} SOL (above it is not carried over)`,
  alwaysLeft: (reserve: string): string => `Always left in the trading wallet ${reserve} SOL`,
  statusActive: "Active",
  investingSection: "Investing",
  investingOn: "Investing is on.",
  investingPausedBadge: "Investing paused",
  investingNotSetUp: "Investing is not set up. Savings stay in your vault as SOL; nothing is converted or invested.",
  setUpInvesting: "Set up investing",
  policyUnreadable: `${BRAND} could not read your investment policy just now.`,
  buyingWaits: "Buying waits",
  floorPassed: "The market moved past a price limit you signed, so buying waits. Sign again with today’s prices.",
  nextInvestment: "Next investment",
  solWaitingToConvert: (sol: string): string => `SOL waiting to convert: ${sol} SOL`,
  progressLabel: "Progress to next investment",
  lastInvestment: "Last investment",
  noInvestmentLoaded: "No investment in the loaded history",
  manageInWallets: "Manage in Wallets",
  resumeInvesting: "Resume investing",

  // ── the stages, before there is anything to show ───────────────────────────
  noVault: {
    title: "No vault yet",
    body: (shortKey: string, rent: string): string =>
      `Your pension key ${shortKey} has no ${BRAND} vault on Solana yet. The vault holds what your trading wallets put ` +
      `aside, and only this key can take money out. Creating it costs ${rent} SOL of rent that does not come back, plus network fees.`,
    bodyNoRent: (shortKey: string): string =>
      `Your pension key ${shortKey} has no ${BRAND} vault on Solana yet. The vault holds what your trading wallets put ` +
      "aside, and only this key can take money out.",
    create: "Create vault",
    openWallets: "Open the wallets page",
    checklist: "What is left to set up",
    // States, not clicks: a trading wallet and its link are two things the chain can be asked about,
    // and a wallet created before this flow existed, or one whose link stopped, still sits between them.
    steps: ["Create vault", "Create a trading wallet", "Link it to your vault", "Set up investing"],
    sidebar: "No activity: this pension key has no vault yet.",
  },

  noTradingWallet: {
    title: "Your vault is ready",
    body:
      `${BRAND} saves from a trading wallet: a wallet created under Manage wallets with the keeper’s permission. ` +
      "One press creates it and links it to your vault; then fund it with SOL and trade from it, or export its key to use it in Axiom or any Solana app.",
    create: "Create and link a trading wallet",
  },

  notLinked: {
    title: "No wallet is linked yet",
    body: (wallets: string, rent: string): string =>
      `${wallets} trading wallets on this account, none linked to your vault. Until a wallet is linked, nothing it ` +
      `gains is put aside. Linking takes three signatures and ${rent} SOL of rent, returned if you unlink.`,
    bodyNoRent: (wallets: string): string =>
      `${wallets} trading wallets on this account, none linked to your vault. Until a wallet is linked, nothing it gains is put aside.`,
    link: "Link a wallet",
    needsConfig: `Linking opens once ${BRAND}’s program is configured on Solana. Withdrawals already work.`,
    paused: `${BRAND} is paused, so linking waits. Withdrawals still work.`,
  },

  waiting: {
    title: "Waiting for the first settlement",
    body: (rate: string): string =>
      "The keeper checks your linked trading wallets about once a minute. When a stretch of trading ends with more SOL " +
      `than it started, ${rate} of the gain moves into your vault. A stretch without a gain moves nothing.`,
  },

  // ── overlays, alongside any stage ──────────────────────────────────────────
  vaultPausedBadge: "Vault paused",
  vaultPaused:
    "Your vault’s rule is paused: nothing is settled, converted or invested for it. Withdrawals still work. Resuming " +
    `needs a rule update signed by your pension key, which ${BRAND} does not offer yet.`,
  investingPausedNote: "Investing is paused. SOL settled into your vault stays as SOL until you resume.",
  protocolPaused: `${BRAND} is paused for everyone: no settlements, links, conversions or investments run. Your vault and withdrawals are not affected.`,
  volumeNotOffered: `This vault measures volume, which ${BRAND} cannot settle yet, so nothing is put aside from it.`,
} as const;

/** One row of the history, per the kind the classifier gave it. */
export const ACTIVITY_COPY = {
  settled: (paid: string): string => `Saved ${paid} SOL`,
  /** A settlement that moved nothing: said as itself, never dressed as a saving. */
  settledNothing: "Settled, nothing to save",
  settledFrom: (label: string, rate: string, base: string, measure: string): string => `from ${label} · ${rate} of ${base} SOL ${measure}`,
  /** The part that did NOT move, said where someone would otherwise wonder. */
  settledCapped: (owed: string, max: string): string => `${owed} SOL owed, capped at ${max} SOL; the rest is not carried over`,
  /** What a settlement measures: the vault's own mode, never the other one. */
  measureProfit: "profit",
  measureVolume: "volume",

  wrapped: (sol: string): string => `Wrapped ${sol} SOL for investing`,
  wrappedPlain: "Wrapped SOL for investing",
  converted: (sol: string, usdc: string): string => `Converted ${sol} SOL to ${usdc} USDC`,
  convertedPlain: "Converted SOL to USDC",
  invested: (amount: string, symbol: string, usdc: string): string => `Bought ${amount} ${symbol} for ${usdc} USDC`,
  investedPlain: (symbol: string): string => `Bought ${symbol}`,
  withdrewSol: (sol: string): string => `Withdrew ${sol} SOL`,
  withdrewToken: (amount: string, symbol: string): string => `Withdrew ${amount} ${symbol}`,
  vaultCreated: (rule: string): string => `Vault created · ${rule}`,
  vaultCreatedPlain: "Vault created",
  ruleChanged: "Savings rule changed",
  policySigned: "Investment policy signed",
  investingPaused: "Investing paused",
  linked: (label: string): string => `Linked ${label}`,
  unlinked: (label: string): string => `Unlinked ${label}`,
  receivedSol: (sol: string): string => `Received ${sol} SOL`,
  /** A transfer is a transfer: never counted as something anyone saved. */
  receivedSub: "a plain transfer, not counted as saved",
  other: "Vault transaction",
  failedBadge: "Failed",
  unreadable: "Transaction could not be read",
  /** A wallet the loaded record cannot name. */
  someWallet: "a trading wallet",

  // ── the feed around the rows ───────────────────────────────────────────────
  empty: "No activity yet. Settlements, conversions and investments appear here, each linked to Solscan.",
  hiddenUpkeep: (count: string): string => `${count} account upkeep transactions hidden`,
  hiddenDust: (count: string): string => `${count} dust transfers hidden`,
  unreadableNow: "Activity could not be read just now",
  /** A day heading over rows bucketed by UTC day: "Today · UTC", "Sep 5 · UTC". */
  dayHeading: (day: string): string => `${day} · UTC`,
  footer: (transactions: string, settlements: string): string => `${transactions} transactions · ${settlements} settlements`,
  seeAll: "See all activity",
  loadOlder: "Load older",
  loadingOlder: "Loading…",
  showingSince: (date: string): string => `Showing since ${date}`,
  complete: "Complete history",
  timeUnknown: "Time unknown",
  openOnSolscan: "Open on Solscan",

  // ── the /activity page's filters ───────────────────────────────────────────
  filterAll: "All",
  filterSavings: "Savings",
  filterInvesting: "Investing",
  filterWithdrawals: "Withdrawals",
  filterLabel: "Filter activity",
  noneInFilter: "Nothing of that kind in the loaded history.",
} as const;

/** The tiles under the chart. Only what the chain actually says. */
export const STATS_COPY = {
  heading: "Stats",
  settlements: "Settlements",
  settlementsSub: (loaded: string): string => `${loaded} in loaded history`,
  biggest: "Biggest settlement",
  biggestSub: "put aside by one settlement",
  capped: "Capped",
  cappedSub: (max: string): string => `at ${max} SOL each`,
  lastSettlement: "Last settlement",
  lastSettlementNever: "none yet",
  /** Settlements the state counts but the loaded pages do not hold: never "none yet". */
  lastSettlementOutside: "not in loaded history",
  investedSoFar: "Invested so far",
  usedIn30Days: "Used in 30 days",
  usedIn30DaysSub: (cap: string): string => `of ${cap}`,
  /** A UTC calendar day, so it says so: the model cuts it at Date.UTC(midnight). */
  today: "Today (UTC)",
  /** A rolling seven days back from the read, not a calendar week — so no zone is claimed for it. */
  thisWeek: "This week",
  /** The strip's trailing note: it names its own population rather than implying a lifetime. */
  lastSettlements: (count: string): string => `last ${count} ${count === "1" ? "settlement" : "settlements"}`,
  settlementStripLabel: "Recent settlements",
} as const;

/** The settlement strip's chip tooltip: who, how much of what, whether it was capped, and when. */
export const stripTooltip = (input: {
  readonly label: string;
  readonly rate: string;
  readonly base: string;
  readonly measure: string;
  readonly capped: string | null;
  readonly when: string;
}): string =>
  [`${input.label} · ${input.rate} of ${input.base} SOL ${input.measure}`, input.capped === null ? null : `capped at ${input.capped} SOL`, input.when]
    .filter((part): part is string => part !== null)
    .join(" · ");
