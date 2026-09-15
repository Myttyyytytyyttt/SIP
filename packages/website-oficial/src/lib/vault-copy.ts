/**
 * EVERY SENTENCE THE VAULT SCREENS SAY, in one place.
 *
 * The rule texts are the owner's, word for word: what a mode takes, what the
 * keeper can and cannot move, and which rent never comes back. Components and
 * flows import from here, so a claim is changed once and a test can pin it.
 * Client-safe and pure; amounts and rates arrive already written as text.
 */

import { DEFAULT_VAULT_POLICY } from "@sip/solana-core/client";

/** Basis points as a percentage: 2000 is "20 %". */
export const ratePercent = (bps: number): string => `${Number((bps / 100).toFixed(2))} %`;

/** "20 %", from the product's default profit rate. */
export const PROFIT_RATE = ratePercent(DEFAULT_VAULT_POLICY.skimBps);
/** "2 %", from the product's default volume rate. */
export const VOLUME_RATE = ratePercent(DEFAULT_VAULT_POLICY.volumeBps);

/**
 * How many transactions of its own a trading wallet signs, while a PROFIT span is
 * still behind, before the keeper settles zero and drops that loss: the keeper's
 * ZERO_BASE_MIN_TXS (packages/solana-keeper/src/settle-decision.ts). TradingLink
 * keeps no high-water mark, so a dropped loss is not netted against later gains.
 * vault-copy.test.ts reads the keeper's file and holds the two equal.
 */
export const LOSS_DROPPED_AFTER_TXS = 100;

/** The first and last four characters of an address. */
export const shortAddress = (address: string): string => (address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address);

export const VAULT_COPY = {
  title: "Vault",
  loading: "Reading your vault on Solana",
  unreadable: "SIP could not read Solana just now. Nothing was offered to sign.",
  retry: "Retry",
  noVault: "No vault yet",
  noVaultDescription: "Your vault holds what your trading wallets put aside, and only your pension key can take it out.",
  modeLegend: "What your trading wallet pays into the vault",
  profitLabel: `Profit · ${PROFIT_RATE}`,
  volumeLabel: `Volume · ${VOLUME_RATE}`,
  comingSoon: "Coming soon",
  limits: "Limits",
  mostPerSettlement: "Most per settlement",
  alwaysLeft: "Always left in the trading wallet",
  zeroSettlement: "Most per settlement must be more than 0 SOL.",
  create: "Create vault",
  creating: "Creating…",
  created: "Vault created",
  viewOnSolscan: "View on Solscan",
  dismiss: "Dismiss",
  paused: "Paused",
  balance: "Balance",
  withdrawable: "Withdrawable",
  createdOn: "Created",
  address: "Vault address",
  /** The PROFIT rule, at `rate` ("20 %"). */
  profitRule: (rate: string, maxContribution: string, walletReserve: string): string =>
    `Profit · ${rate} of what your trading wallet gains. The keeper watches your trading wallet's SOL. When a stretch of trading ends with more SOL than it started, not counting plain transfers you send in or take out, ${rate} of the gain moves into this vault. Gains held in tokens count once they are sold back to SOL. A losing stretch moves nothing, and its loss comes off the next gain. Once your trading wallet has signed ${LOSS_DROPPED_AFTER_TXS} transactions of its own while still behind, that loss is dropped and later gains count in full. One settlement moves at most ${maxContribution} SOL; anything above that is not carried over. It never leaves the trading wallet with less than ${walletReserve} SOL.`,
  volumeComing: `Volume · ${VOLUME_RATE} of every buy and sell. Coming soon: the keeper cannot measure trading volume yet, so a volume vault would receive nothing. You will be able to switch when it is ready.`,
  /** The VOLUME rule, at `rate` ("2 %"), once VOLUME is offered. */
  volumeRule: (rate: string, maxContribution: string, walletReserve: string): string =>
    `Volume · ${rate} of the SOL value of every buy and sell your trading wallet makes, win or lose. At most ${maxContribution} SOL per settlement, and never leaving less than ${walletReserve} SOL in the trading wallet.`,
  bothModes: (rent: string): string =>
    `Only your pension key can withdraw from the vault, and SIP cannot pause or block a SOL withdrawal. The keeper can only move SOL from a linked trading wallet into this vault, never out of it. Creating the vault costs ${rent} SOL of rent plus the network fee. Solana keeps that rent in the vault, and a vault cannot be closed, so it does not come back.`,
  cost: (rent: string, fees: string): string => `Cost: ${rent} SOL of rent that does not come back, plus ${fees} SOL of network fees.`,
  costUnknown: "The rent could not be read just now; Phantom shows the total before you approve.",
  aboutUsd: (usd: string): string => `≈ ${usd}`,
} as const;

export const LINK_COPY = {
  linked: "Linked to your vault",
  viewLink: "View link on Solscan",
  otherVault: "This wallet saves into another vault. Only that vault's owner can unlink it.",
  link: "Link to vault",
  linkThis: "Link this wallet",
  cancel: "Cancel",
  needsVault: "Create your vault first.",
  needsConfig: "Linking opens once SIP's program is configured on Solana. Your vault, investing and withdrawals already work.",
  paused: "SIP is paused, so linking waits. Withdrawals still work.",
  busy: "Another signature is in progress on this screen.",
  unreadable: "SIP could not read whether this wallet is linked. Nothing was offered to sign.",
  noSigner: "Until this wallet has the keeper's signer, nothing is put aside from it.",
  panel: (linkRent: string): string =>
    `Linking takes three signatures. Your trading wallet signs a consent naming this vault. Phantom pays ${linkRent} SOL of rent (returned if you unlink) and approves. Then your trading wallet co-signs. A wallet can be linked to one vault at a time.`,
  done: "Linked",
  walletIsPension: "A trading wallet cannot be your pension key.",
  tradingNotReady: "This trading wallet is not ready in this session. Reload the page, then try again.",
  consentMismatch: "The server asked your trading wallet to sign something that is not this link's consent. Nothing was signed.",
  consentTitle: "Link to your SIP vault",
  consentDescription: (pensionKeyShort: string): string => `Consent for SIP to link this trading wallet to the vault of pension key ${pensionKeyShort}. It moves no funds.`,
  consentButton: "Sign consent",
  consentNotSignature: "Your trading wallet did not return a 64-byte signature for the consent. Nothing was linked.",
  approvalPassedTwice: "Solana's approval window passed twice. Try again when ready.",
  coSignMismatch: "Your trading wallet signed a different transaction than Phantom approved. Nothing was sent.",
} as const;

export const INVEST_COPY = {
  title: "Investing",
  needsVault: "Create your vault first.",
  policyUnreadable: "SIP could not read your investment policy just now. Nothing was offered to sign.",
  basket: "Basket",
  rule: "Rule",
  buysEach: (usd: string): string => `Buys each time ${usd} of USDC is ready`,
  mostPerBuy: "Most per buy",
  mostPer30Days: "Most per 30 days",
  floorsTitle: "Today's price limits",
  solFloor: (floor: string, today: string): string => `SOL is never sold below ${floor} (90 % of today's ${today})`,
  legCeiling: (symbol: string, max: string): string => `${symbol} is never bought above ${max} per 100,000,000 raw units (5.3 % over today's pool price)`,
  pricesUnknown: "Today's prices could not be read just now. The build reads them again, and the limits you sign are shown before Phantom asks.",
  /** The owner's words for what a policy does, at the limits shown. */
  policyRule: (floorUsdPerSol: string, maxUsdPer1e8: string, maxPerCall: string, maxRolling: string, rent: string): string =>
    `Your vault invests in SPYx (SP500 xStock) through Raydium. When it holds SOL, the keeper converts it to USDC, never below ${floorUsdPerSol} per SOL. It buys SPYx each time $5.00 of USDC is ready, never paying more than ${maxUsdPer1e8} per 100,000,000 raw units. At most ${maxPerCall} per buy and ${maxRolling} per 30 days until you change them. If prices move past these limits, buying waits until you sign again. Nothing is sold at a worse price. Setting this up costs ${rent} SOL of rent for the policy and the vault's token accounts, and none of it comes back.`,
  freezeNotice:
    "SPYx is a tokenized share on Token-2022. Its issuer can freeze or pause it, and holds a permanent delegate that can move it, including out of your vault. If that happens, withdrawing SPYx can fail or find less than you hold. USDC's issuer can freeze USDC accounts too. Withdrawing SOL does not depend on either issuer.",
  freezeShort: "Its issuer can freeze, pause or move SPYx, even in your vault. Withdrawing SOL does not depend on it.",
  acknowledge: "I understand the issuer can freeze, pause or move SPYx",
  sign: "Sign investment policy",
  signing: "Signing…",
  signed: "Policy signed",
  capsProblem: (minimum: string): string => `Most per buy must be at least ${minimum}, and Most per 30 days at least Most per buy.`,
  convertWarning: "Above $1,000.00 per buy, one conversion can sell more than 1 SOL of your savings at the floor.",
  youAreSigning: (solFloor: string, legs: string, perBuy: string, per30Days: string): string =>
    `You are signing: SOL never sold below ${solFloor}; ${legs}; at most ${perBuy} per buy and ${per30Days} per 30 days.`,
  legSigning: (symbol: string, max: string): string => `${symbol} never bought above ${max} per 100,000,000 raw units`,
  enabled: "Investing is on.",
  paused: "Investing is paused.",
  floorsBelowMarket: "Floors below market",
  floorPassed: "Floor passed",
  marketPast: "The market moved past a floor: buying waits until you sign again with today's prices.",
  storedSolFloor: (floor: string, today: string | null): string => (today === null ? `SOL floor ${floor}` : `SOL floor ${floor}, today ${today}`),
  storedLegCeiling: (symbol: string, max: string, today: string | null): string =>
    today === null ? `${symbol} ceiling ${max} per 100,000,000 raw units` : `${symbol} ceiling ${max} per 100,000,000 raw units, today ${today}`,
  usedLast30: "Used in the last 30 days",
  lifetime: "Invested so far",
  ready: "Ready: the next sweep can buy.",
  waiting: (at: string): string => `Waiting: it buys once the vault holds ${at} of USDC.`,
  unreachable: "These limits can never buy the whole basket: raise Most per buy.",
  signAgain: "Sign again with today's prices",
  pause: "Pause investing",
  resume: "Resume investing",
  pauseKeeps: "Pausing signs this policy again as it is, with investing off, so it needs no prices. Resuming and signing again read today's prices.",
  pauseSigning: "You are signing: investing paused, with every floor and limit this policy has.",
  noRefill: "Signing again does not refill this month's cap.",
} as const;

export const WITHDRAW_COPY = {
  title: "Take money out",
  refresh: "Refresh",
  needsVault: "Create your vault first.",
  sol: "SOL",
  balance: "Balance",
  withdrawable: "Withdrawable",
  keptAsRent: (rent: string): string => `Kept as rent ${rent} SOL`,
  amount: "Amount to withdraw",
  max: "Max",
  withdrawSol: "Withdraw SOL",
  withdrawing: "Withdrawing…",
  withdrawn: "Withdrawn",
  zero: "Enter more than 0 SOL.",
  aboveWithdrawable: (max: string): string => `The vault can release at most ${max} SOL.`,
  solRule: (rentFloor: string): string =>
    `Only your pension key can withdraw, and SIP cannot pause or block a SOL withdrawal. The vault keeps ${rentFloor} SOL of rent, which Solana requires, and a vault cannot be closed.`,
  empty: "Savings arrive from linked trading wallets. To try a withdrawal now, send a little SOL to the vault address from your wallet app.",
  /** Shown beside the SOL section while the vault's investment policy is on. */
  investingOn:
    "Investing is on, so the keeper can convert SOL that reaches this vault to USDC within about a minute, and it then shows under Tokens. To test a SOL withdrawal, pause investing first.",
  /** A withdrawal the build checked, refused on chain because the vault then held less SOL: the keeper's conversion, most likely. */
  balanceMoved: "The vault's SOL moved after this was prepared, most likely into investing by the keeper: see Tokens. Nothing was withdrawn.",
  vaultAddress: "Vault address",
  tokens: "Tokens",
  noTokens: "The vault holds no tokens yet.",
  tokensUnreadable: "SIP could not read the vault's tokens just now. Nothing was offered to sign.",
  /** When the vault's token listing could not be read and its own accounts, read by address, could: `symbols` is "wSOL, USDC and SPYx". */
  tokensOwnAccountsOnly: (symbols: string): string => `SIP could not list every token account your vault owns just now, so only its own ${symbols} accounts are shown.`,
  ownAccountsEmpty: "Those accounts hold no tokens.",
  share: (percent: number): string => (percent === 100 ? "All" : `${percent} %`),
  wsolNote: "Arrives in your wallet as SOL.",
  createsLegAccount: (symbol: string, rent: string): string => `Creates your own ${symbol} token account if you have none (${rent} SOL of rent, paid by you and kept by you).`,
} as const;

export const PROGRESS_COPY = {
  preparing: "Preparing",
  approve_pension: "Approve in Phantom",
  trading_signing: "Trading wallet signing",
  sending: "Sending",
  confirming: "Confirming on Solana",
  done: "Done",
  tookTooLong: "Took too long",
  tookTooLongDetail: "Solana's approval window passed before the transaction landed, so nothing moved. Build it again to sign a fresh one.",
  buildAgain: "Build again",
  notConfirmed: "Not confirmed yet",
  notConfirmedDetail: "The transaction was sent, and Solana has not confirmed it yet. Check again before signing anything new.",
  checkAgain: "Check again",
  refused: "Refused",
  rateLimited: "Too many requests",
  unreadable: "Solana did not answer",
} as const;

export const FAILURE_COPY = {
  phantomNotConnected: "Phantom is not connected to this page. Open Phantom, unlock it, and reload.",
  phantomDeclined: "Phantom did not approve. Nothing was sent.",
  tradingDeclined: "Your trading wallet did not sign. Nothing was sent.",
  network: "SIP could not be reached. Check your connection, then try again.",
  unavailable: "Solana is not available on this deployment right now.",
  upstream: "Solana did not answer just now. Nothing was sent. Try again.",
  rateLimited: (seconds: number | null): string =>
    seconds === null ? "Too many requests just now. Try again in a minute." : `Too many requests just now. Try again in ${seconds} s.`,
  blockhashExpired: "Solana's approval window passed before the transaction was sent. Build it again.",
  alreadyExists: "It already exists. Refreshing.",
  frozen: "The issuer has frozen this token account. SOL withdrawals still work.",
  issuerPaused: "The issuer has paused SPYx transfers.",
  simulationRefused: "Solana refused this transaction in simulation. Nothing was sent.",
  unknown: "Something went wrong. Nothing was sent.",
  builtMismatch: (detail: string): string => `SIP's server sent a transaction that is not what you asked for (${detail}). Nothing was signed.`,
  signedMismatch: (detail: string): string => `Phantom changed the transaction beyond its fee (${detail}). Nothing was sent.`,
  foreignProgram: (label: string): string => `Phantom added an instruction for ${label}, which SIP does not relay. Nothing was sent.`,
  unreadableBuilt: "SIP's server sent something that is not a transaction. Nothing was signed.",
  unreadableSigned: "Phantom returned something that is not a transaction SIP can read. Nothing was sent.",
} as const;
