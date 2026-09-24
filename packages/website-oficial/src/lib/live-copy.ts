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
  walletBalance: "Balance",
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
  // The hero is the dollar now, so the caption carries the chain's own figure —
  // every digit of it, never splitDecimal's head — and says what turned it into
  // dollars. It is a VALUATION of what is held, not a sum of the dollars that
  // were set aside: those were set aside at prices nobody recorded.
  heroSolAtPrice: (sol: string): string => `${sol} SOL, valued at today’s SOL price`,
  heroProfit: (rate: string): string => `Profit · ${rate} of trading gains`,
  heroVolumeNotOffered: (rate: string): string => `Volume · ${rate} · not settled while ${BRAND} cannot measure volume`,
  heroSince: (date: string): string => `since ${date}`,
  worthNow: "Worth now",
  worthNowTooltip: "SOL and each stock in your basket at today’s Raydium pool prices; USDC counted at $1",
  pricesUnavailable: "Prices unavailable",
  /** The PROGRAM's own counter: USDC that invest() has spent. Not the basket's value below. */
  investedSoFar: "Invested so far",
  investedSoFarTooltip: "USDC the keeper has spent buying your basket, counted by your vault’s own policy. Tokens that reached the vault any other way are not in it.",
  unknownFigure: "—",

  // ── the chart ──────────────────────────────────────────────────────────────
  chartLabel: "Saved",
  // The mock's axis says its unit by being in dollars. This one cannot be, so
  // the caption says it instead — the y-axis ticks are bare numbers otherwise.
  chartUnit: "SOL saved",
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
  holdingsCaption: "What the pension holds",
  asset: "Asset",
  shares: "Shares",
  value: "Value",
  weightVsTarget: "Weight vs target",
  target: "target",
  notInvestedYet: "Not invested yet",
  /** The same figure as a TOTAL under the table, where the sample calls it Pending. */
  pending: "Pending",
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
  // Said in prose because there is no row to say it on: the vault's SOL is all
  // rent, and a "SOL — 0 — $0.00" row was how that used to reach the screen.
  solRentOnly: (rent: string): string => `No SOL to withdraw: the ${rent} SOL in the vault is rent Solana keeps.`,
  holdingsFootnote: "Tokens in other accounts the vault owns are listed under Manage wallets.",
  tokensUnreadable: `${BRAND} could not read the vault’s tokens just now.`,
  pricesUnreadableNote: "Today’s prices could not be read, so dollar values are hidden.",

  // ── the rule card ──────────────────────────────────────────────────────────
  ruleTitle: "Savings rule",
  ruleDescription: "Read from Solana. Set when your vault was created.",
  /** The gear that opens the modal where the rule can actually be changed. */
  ruleSettings: "Vault settings",
  /** "Rate of profit" / "Rate of volume": WHICH rate, since this vault has two fields and uses one. */
  rateOf: (measure: string): string => `Rate of ${measure}`,
  /** The track's far end. A bar with no scale is a fraction of nothing. */
  rateFloor: "0%",
  investsIn: "Invests in",
  /*
   * NOT INVEST_COPY.floorsTitle ("Today's price limits"), which means the
   * opposite where it is defined: that one heads the limits a policy signed
   * NOW would carry, computed from today's prices. These are the ones already
   * signed, on some past day, and they decay as the market moves away from
   * them — which is the whole reason they are worth showing.
   */
  signedPriceLimits: "Price limits you signed",
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
  /*
   * A TITLE SAYS WHAT HAPPENED; THE AMOUNT COLUMN SAYS HOW MUCH.
   *
   * Every one of these used to carry its figure, and the row then printed the
   * same number twice — once inside a title that ran out of room in a 320px
   * column and was cut mid-word, and once in full on the right. The sample has
   * always split them, which is why its rows read and these did not. So no
   * string here takes an amount, and the amount-less twins that existed for
   * the unreadable case are gone with them: when a figure cannot be read the
   * COLUMN empties, and the title is the same sentence it always was.
   */
  settled: (label: string): string => `Saved from ${label}`,
  /** A settlement that moved nothing: said as itself, never dressed as a saving. */
  settledNothing: (label: string): string => `Settled from ${label}, nothing to save`,
  settledFrom: (rate: string, base: string, measure: string): string => `${rate} of ${base} SOL ${measure}`,
  /** The same in dollars at today's price, for the sample's rows: "20 % of $21.40 profit". */
  settledFromUsd: (rate: string, base: string, measure: string): string => `${rate} of ${base} ${measure}`,
  /** A dollar figure made from SOL at the price read now, said where it is shown. */
  atTodaysPrice: "at today's SOL price",
  /** The part that did NOT move, said where someone would otherwise wonder. */
  settledCapped: (owed: string, max: string): string => `${owed} SOL owed, capped at ${max} SOL; the rest is not carried over`,
  /** What a settlement measures: the vault's own mode, never the other one. */
  measureProfit: "profit",
  measureVolume: "volume",

  wrapped: "Wrapped SOL for investing",
  converted: "Converted SOL to USDC",
  /** What the SOL side of a conversion came to, beside the USDC in the amount column. */
  convertedFrom: (sol: string): string => `${sol} SOL`,
  invested: (symbol: string): string => `Invested in ${symbol}`,
  withdrewSol: "Withdrew SOL",
  withdrewToken: (symbol: string): string => `Withdrew ${symbol}`,
  vaultCreated: (rule: string): string => `Vault created · ${rule}`,
  vaultCreatedPlain: "Vault created",
  ruleChanged: "Savings rule changed",
  /** What it was changed TO, when the transaction decoded enough to say. */
  ruleChangedTo: (rule: string): string => `now ${rule}`,
  policySigned: "Investment policy signed",
  /** The cap a signed policy carries, when it decoded. Never a "$0.00" standing in for unread. */
  policyCaps: (max: string): string => `up to ${max} per buy`,
  investingPaused: "Investing paused",
  linked: (label: string): string => `Linked ${label}`,
  unlinked: (label: string): string => `Unlinked ${label}`,
  receivedSol: "Received SOL",
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
  // The keeper paying the vault's own account costs. Twelve of these in a
  // fifteen-signature page is ordinary, and calling them all "Vault
  // transaction" made twelve identical rows out of one fact.
  upkeepTitle: "Account upkeep",
  upkeepSub: "the keeper paying the account's own costs — nothing saved or invested",
  showHidden: "Show them",
  hideHidden: "Hide them",
  onlyHidden: "Nothing to list yet. Every transaction the loaded history holds is account upkeep.",
  /** A day heading over rows bucketed by UTC day: "Today · UTC", "Sep 5 · UTC". */
  dayHeading: (day: string): string => `${day} · UTC`,
  footer: (transactions: string, settlements: string): string => `${transactions} transactions · ${settlements} settlements`,
  /** Both feed counts are over the pages loaded so far, never a lifetime. */
  countsAreLoaded: "Over the history loaded so far",
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
  // THE WINDOW MUST BE IN ONE OF THE TWO. biggestPaid is the maximum over the
  // pages LOADED, not over the pension's life, and a tile that says neither
  // would be read as a lifetime record.
  biggestSub: "biggest in the loaded history",
  capped: "Capped",
  cappedSub: (max: string): string => `in the loaded history, at ${max} SOL each`,
  lastSettlement: "Last settlement",
  lastSettlementNever: "none yet",
  /** Settlements the state counts but the loaded pages do not hold: never "none yet". */
  lastSettlementOutside: "not in loaded history",
  investedSoFar: "Invested so far",
  usedIn30Days: "Used in 30 days",
  usedIn30DaysSub: (cap: string): string => `of ${cap}`,
  /** A UTC calendar day, so it says so: the model cuts it at Date.UTC(midnight). */
  today: "Today (UTC)",
  /** A window SUM at today's price is not a balance at today's price, so it goes in the sub, worded. */
  windowAbout: (usd: string): string => `≈ ${usd} at today’s SOL price`,
  /** A rolling seven days back from the read, not a calendar week — so no zone is claimed for it. */
  thisWeek: "This week",
  /** The strip's trailing note: it names its own population rather than implying a lifetime. */
  lastSettlements: (count: string): string => `last ${count} ${count === "1" ? "settlement" : "settlements"}`,
  /**
   * The average over the chips SHOWN, as the sample trails its strip.
   *
   * IN SOL, BECAUSE THE CHIPS ARE. The sample averages dollars because its
   * savings are dollars; these are lamports that moved at prices nobody
   * stored, and an average of them in today's dollars would describe none of
   * the chips beside it. "Settlement", not "trade": the chain has no trades.
   */
  stripAverage: (avg: string, count: string): string => `avg ${avg} SOL / settlement · last ${count}`,
  /** The badge that opens the strip: the vault's rule as it stands today. */
  stripModeProfit: (rate: string): string => `Profit: ${rate}`,
  stripModeVolume: (rate: string): string => `Volume: ${rate}`,
  /** What that badge means, as the sample's has always said on hover. */
  stripBadgeProfit: (rate: string): string => `${rate} of your realised trading gains is put aside`,
  stripBadgeVolume: (rate: string): string => `${rate} of your trading volume would be put aside`,
  settlementStripLabel: "Recent settlements",
} as const;

/** The settlement strip's chip tooltip: who, how much of what, whether it was capped, and when. */
export const stripTooltip = (input: {
  /** The EXACT amount, to the lamport. The chip's own face is rounded for reading. */
  readonly paid: string;
  readonly label: string;
  readonly rate: string;
  readonly base: string;
  readonly measure: string;
  readonly capped: string | null;
  readonly when: string;
}): string =>
  [
    `${input.paid} SOL`,
    `${input.label} · ${input.rate} of ${input.base} SOL ${input.measure}`,
    input.capped === null ? null : `capped at ${input.capped} SOL`,
    input.when,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");

/**
 * THE NEW-USER SETUP: welcome, create the vault, done — over the dashboard
 * (src/components/onboarding).
 *
 * NO NEW JARGON. Older dashboard sentences say "keeper"; these say SaverFi, and
 * live-copy.test.ts holds them to it. "Pension key" stays: it is the product's
 * name for the wallet that owns the vault.
 *
 * NOTHING HERE PROMISES MORE THAN THE PROGRAM DOES. The rate is profit only
 * (volume is not offered), a loss comes off the next gain exactly as
 * VAULT_COPY.profitRule says, and every cost that exists is named — rent, the
 * link's rent, the network fee each settlement costs. Every figure arrives as
 * text from code; one that could not be read is said as such, never as a zero.
 */
export const ONBOARDING_COPY = {
  stepOf: (current: number, total: number): string => `Step ${current} of ${total}`,
  /** The identity line under every step, and the way out of a wrong wallet. */
  pensionKey: (shortKey: string): string => `Pension key ${shortKey}`,
  notThisWallet: "Not this wallet?",
  /** Said once, on the first screen: closing is allowed, and where it leads. */
  closeHint: "You can close this and look around with example numbers first. Connect brings you back here.",
  /** The close button's name while a signature is being asked for. */
  closeHeld: "Close (not while your wallet is asked to approve)",
  close: "Close",

  welcome: {
    /** The big word is the brand; a screen reader hears "Welcome to" before it. */
    title: BRAND,
    titleLead: "Welcome to",
    lede: "A slice of your trading gains, put aside for later.",
    /** The subtitle: the whole product in one running line. */
    points: (rate: string): readonly string[] => ["Trade as usual", `${rate} of each gain saved`, "Invested in tokenized stocks", "Only you withdraw"],
    tradeTitle: "Trade as you do today",
    trade: `From a ${BRAND} trading wallet linked to your vault. Export its key to use it in Axiom or any Solana app.`,
    saveTitle: (rate: string): string => `${rate} of each gain is saved`,
    /**
     * The summary, and deliberately nothing about losses carried forward: that
     * rule has a limit (a loss is dropped after LOSS_DROPPED_AFTER_TXS), and it
     * is said in full on the vault step, right before the signature.
     */
    save: (rate: string): string => `When a stretch of trading ends with more SOL than it started, ${rate} of the gain moves into your vault. A losing stretch moves nothing.`,
    investTitle: "Your savings can be invested",
    invest: (examples: string): string => `Choose tokenized stocks for it to buy, such as ${examples}. Each issuer’s powers over its stock are shown before you sign.`,
    ownTitle: "Only you can take it out",
    own: `Only your pension key can withdraw from the vault, and ${BRAND} cannot pause or block a SOL withdrawal.`,
    costTitle: "What it costs",
    /** Beside the folded costs: the one figure the next step asks for. */
    costFrom: (rent: string): string => `Your vault: ${rent} SOL + fees`,
    costVault: (rent: string, fees: string): string => `Your vault: ${rent} SOL of rent that does not come back, plus ${fees} SOL of network fees.`,
    costVaultUnknown: "Your vault: rent that does not come back, plus network fees. The rent could not be read just now; your wallet shows the total before you approve.",
    costLink: (rent: string): string => `Each trading wallet you link: ${rent} SOL of rent, plus network fees. The program returns the rent on unlink, which ${BRAND} does not offer yet.`,
    costLinkUnknown: `Each trading wallet you link: rent, plus network fees. The program returns the rent on unlink, which ${BRAND} does not offer yet.`,
    costSettle: "Each settlement is a Solana transaction, and your trading wallet pays its network fee.",
    costInvest:
      "Investing, if you set it up: rent that does not come back. Each buy pays the pool’s fees, may fill up to the price limit you sign, " +
      "and some stocks charge their issuer’s transfer fee. Every limit is shown before you approve.",
    continue: "Continue",
  },

  vault: {
    title: "Create your vault",
    modeTitle: (rate: string): string => `Profit · ${rate}`,
    mode: (rate: string, dropAfter: number): string =>
      `${rate} of each gain your trading wallet makes moves into this vault. A losing stretch moves nothing, and its loss comes off later gains ` +
      `until your trading wallet has made ${dropAfter} transactions of its own while still behind.`,
    advanced: "Advanced",
    advancedSummary: (max: string, reserve: string): string => `At most ${max} SOL per settlement · ${reserve} SOL always left in the trading wallet`,
    maxHint: "The most one settlement moves into your vault. Anything above it is not carried over.",
    reserveHint: `${BRAND} never takes your trading wallet below this, so it keeps SOL for its own fees.`,
    changeLater: "You can change these limits after the vault is made.",
    approveOnce: "Your wallet asks you to approve once.",
    /** A create was sent and not confirmed: the footer says where the way forward is. */
    checkAbove: "A vault creation was sent and is not confirmed yet. Check it above before trying again.",
    back: "Back",
  },

  ready: {
    title: "Your vault is ready",
    body: "Nothing is saved until a trading wallet is linked to it. Your dashboard walks you through the rest.",
    nextTitle: "Next, from your dashboard",
    next: ["Create and link a trading wallet", "Send it SOL and trade from it", "Choose what your savings buy"],
    done: "Go to my dashboard",
  },
} as const;
