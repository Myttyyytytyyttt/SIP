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

/**
 * HOW SMALL ONE BUY MUST BE BESIDE THE POOL IT GOES INTO: the keeper's
 * MIN_POOL_DEPTH_MULTIPLE (packages/solana-keeper/src/invest-decision.ts). A
 * pool's in-side reserve has to cover the buy this many times over or the turn
 * is refused, so one buy may be at most a FIFTIETH of what that pool holds.
 * vault-copy.test.ts reads the keeper's file and holds the two equal, the same
 * way it does for LOSS_DROPPED_AFTER_TXS.
 */
export const POOL_DEPTH_MULTIPLE = 50;

/**
 * THE MOST A STOCK MAY CHARGE TO TRANSFER AND STILL BE BOUGHT: the keeper's
 * MAX_LEG_FEE_BPS (packages/solana-keeper/src/invest-decision.ts), which gates
 * on `fee.bps > MAX_LEG_FEE_BPS` — strictly greater, so a leg sitting exactly
 * on the limit is still admitted, with no margin whatsoever.
 *
 * THAT IS ANTHROPIC'S POSITION TODAY. Its active fee is 100 bps and this is
 * 100 bps, so the basket is one issuer instruction away from being refused
 * entirely — and the refusal is all-or-nothing, taking SPYx and the SOL
 * conversion with it. INVEST_COPY.feeCeiling is the sentence that says so, and
 * vault-copy.test.ts reads the keeper's file and holds the two equal, the same
 * way it does for POOL_DEPTH_MULTIPLE.
 */
export const MAX_LEG_FEE_BPS = 100;

/** "SPYx and ANTHROPIC", "SPYx, ANTHROPIC and GLDx", "SPYx" — a list in a sentence. */
export const listAnd = (items: readonly string[]): string =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** The first and last four characters of an address. */
export const shortAddress = (address: string): string => (address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address);

export const VAULT_COPY = {
  title: "Vault",
  loading: "Reading your vault on Solana",
  unreadable: "SaverFi could not read Solana just now. Nothing was offered to sign.",
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

  // ── CHANGING THE VAULT'S OWN RULE, AFTER IT IS MADE ────────────────────────
  //
  // Until now these two could only be chosen when the vault was created. The
  // route carries them on setPolicy, which writes ALL SIX of the rule, so the
  // form sends the vault's current mode, rates and paused flag back untouched
  // beside the figure being changed.
  changeLimits: "Change these limits",
  changeLimitsHint:
    "These were set when your vault was made. Changing them signs your vault's rule again — the way it saves and the rate stay exactly as they are.",
  /**
   * THE ONE CONSEQUENCE THE OWNER MUST READ BEFORE SIGNING, not after.
   *
   * set_policy.rs bumps vault.policy_nonce on EVERY call, even one that changes
   * nothing, and settle.rs builds the message it verifies with that nonce — so
   * a settlement the attester has already signed stops verifying the moment
   * this lands. Changing the BASKET bumps a different counter the attestation
   * does not carry and strands nothing; this is the one that does.
   */
  nonceNotice:
    "Signing this makes any saving already on its way stop being valid: the keeper has to sign it again, so a settlement in progress may be delayed by a few minutes. Nothing is lost. Changing what your basket buys does not do this.",
  saveLimits: "Sign new limits",
  savingLimits: "Signing…",
  limitsSaved: "New limits signed",
  limitsUnchanged: "These are the limits your vault already has.",
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
    `Only your pension key can withdraw from the vault, and SaverFi cannot pause or block a SOL withdrawal. The keeper can only move SOL from a linked trading wallet into this vault, never out of it. Creating the vault costs ${rent} SOL of rent plus the network fee. Solana keeps that rent in the vault, and a vault cannot be closed, so it does not come back.`,
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
  needsConfig: "Linking opens once SaverFi's program is configured on Solana. Your vault, investing and withdrawals already work.",
  paused: "SaverFi is paused, so linking waits. Withdrawals still work.",
  busy: "Another signature is in progress on this screen.",
  /** A link for THIS wallet was sent and not confirmed, from this row or from the card's chained press. */
  sentNotConfirmed: "A link for this wallet was sent and is not confirmed yet. Check that one before sending another.",
  unreadable: "SaverFi could not read whether this wallet is linked. Nothing was offered to sign.",
  noSigner: "Until this wallet has the keeper's signer, nothing is put aside from it.",
  panel: (linkRent: string): string =>
    `Linking takes three signatures. Your trading wallet signs a consent naming this vault. Phantom pays ${linkRent} SOL of rent (returned if you unlink) and approves. Then your trading wallet co-signs. A wallet can be linked to one vault at a time.`,
  done: "Linked",
  walletIsPension: "A trading wallet cannot be your pension key.",
  tradingNotReady: "This trading wallet is not ready in this session. Reload the page, then try again.",
  consentMismatch: "The server asked your trading wallet to sign something that is not this link's consent. Nothing was signed.",
  consentTitle: "Link to your SaverFi vault",
  consentDescription: (pensionKeyShort: string): string => `Consent for SaverFi to link this trading wallet to the vault of pension key ${pensionKeyShort}. It moves no funds.`,
  consentButton: "Sign consent",
  consentNotSignature: "Your trading wallet did not return a 64-byte signature for the consent. Nothing was linked.",
  approvalPassedTwice: "Solana's approval window passed twice. Try again when ready.",
  coSignMismatch: "Your trading wallet signed a different transaction than Phantom approved. Nothing was sent.",
} as const;

/**
 * CREATING A TRADING WALLET AND LINKING IT, in one press.
 *
 * WHAT THE SEAT SENTENCES MAY CLAIM. A wallet is born seated: the keeper's signer
 * with its policy goes into Privy's createWallet itself. So these words say the
 * seat was asked for at creation, which is what happened, and never that Privy's
 * record has been read back — the row's badge is the only thing that reads it,
 * and it can only ever say a signer exists (src/lib/trading-wallets.ts).
 *
 * EVERY SENTENCE AFTER THE CREATE SAYS THE WALLET IS THERE. Once Privy has made
 * it, the wallet is real and paid for whatever the link does next, so no refusal
 * may read as "nothing happened".
 */
/** Defined before the object so `ahead` can end with it. */
const CREATE_LINK_RENT_UNREAD = "The rent is not on screen yet; Phantom shows it before you approve.";

export const CREATE_LINK_COPY = {
  /** The button, when the chain can take a link. */
  button: "Create wallet and link it",
  /** The button, when the chain cannot: it will only create. */
  buttonCreateOnly: "Create wallet",
  running: "Working…",
  /**
   * Said before anything is pressed, and again for the whole run: Phantom's prompt
   * must never arrive unannounced. `linkRent` is null while the chain's rent has not
   * been read — the amount is then Phantom's to show, and none is invented here.
   */
  ahead: (linkRent: string | null): string =>
    `One press does both. Privy creates the wallet with the keeper's seat, your trading wallet signs a consent naming this vault, ` +
    (linkRent === null ? `then Phantom asks you to approve and pay the link's rent (returned if you unlink), ` : `then Phantom asks you to approve and pay ${linkRent} SOL of rent (returned if you unlink), `) +
    `and your trading wallet co-signs. Phantom's window opens partway through, after the wallet exists.` +
    (linkRent === null ? ` ${CREATE_LINK_RENT_UNREAD}` : ""),
  aheadCreateOnly: "This creates a trading wallet with the keeper's seat. Nothing is signed and nothing is paid.",
  /** The link's rent is not on screen yet: said instead of an amount, never as well as one. */
  rentNotRead: CREATE_LINK_RENT_UNREAD,
  done: "Linked",
  /** The head of every stop after the wallet exists. */
  created: "Your trading wallet is created and nothing was lost.",
  /**
   * What to do with it, said after `created`. THE LINK IS PROMISED FOR AFTER THE
   * CHAIN READ, never for now: a wallet created a moment ago is not in Privy's
   * record yet, so the screen's read has not been asked about it and its row shows
   * `notReadYet` with a re-read, not this button (LinkControl). The `not_ready`
   * stop is exactly that moment, so a flat promise was reliably wrong there — and
   * it named a control the owner could look at and not find.
   */
  inTheList: `It is in the list below, with its seat as Privy records it. Once SaverFi has read it on Solana, its row offers ${LINK_COPY.link}.`,
  /** No vault: the one thing that must happen first, and never done for the user — the rent never comes back. */
  needsVaultTitle: "Create your vault first",
  needsVault: (rent: string | null): string =>
    rent === null
      ? "A trading wallet can only be linked to a vault, and this pension key has none yet. SaverFi does not create one for you: a vault costs rent that never comes back, and it holds a mode and limits you choose. Create it above, then link this wallet from its row."
      : `A trading wallet can only be linked to a vault, and this pension key has none yet. SaverFi does not create one for you: a vault costs ${rent} SOL of rent that never comes back, and it holds a mode and limits you choose. Create it above, then link this wallet from its row.`,
  goToVault: "Create your vault",
  /** Privy answered without an address. */
  noAddress:
    "Privy created a wallet and did not say its address. Nothing is lost: it appears in the list below once Privy's record updates, and it can be linked from there.",
  /** The chain read is not ready, so no link may be attempted from an unknown state. */
  chainUnknown: "SaverFi could not read Solana just now, so the link was not attempted and nothing was signed.",
  /** Privy's record has not reached this session's signer list. */
  notReady:
    "This session cannot sign for the new wallet yet, so the link was not attempted. Reload the page, then link it from its row.",
  /** The link itself stopped. `detail` is the step's own words. */
  linkStopped: (detail: string): string => `The wallet was created; the link did not finish. ${detail}`,
  /** Some link on the screen was sent and not confirmed, so a chained press would race it. */
  linkAwaiting: "A link sent on this screen is not confirmed yet. Check it before starting another.",
  /** A row for a wallet the chain read has not covered yet. */
  notReadYet: "SaverFi has not read this wallet on Solana yet.",
  check: "Check again",
} as const;

export const INVEST_COPY = {
  title: "Investing",
  needsVault: "Create your vault first.",
  policyUnreadable: "SaverFi could not read your investment policy just now. Nothing was offered to sign.",
  basket: "Basket",
  rule: "Rule",
  buysEach: (usd: string): string => `Buys each time ${usd} of USDC is ready`,
  mostPerBuy: "Most per buy",
  mostPer30Days: "Most per 30 days",
  floorsTitle: "Today's price limits",
  solFloor: (floor: string, today: string): string => `SOL is never sold below ${floor} (90 % of today's ${today})`,
  /**
   * WHAT THE SOL FLOOR ACTUALLY IS, said in words, beside the live price it was
   * taken from. It reaches the program as min_convert_rate_wad, and the program
   * does NOT validate it: a zero there is accepted and silently means "sell this
   * vault's SOL at any price at all". Nothing on this screen can reach zero — the
   * web never lets the figure be typed, it is always floorWad(live price,
   * CONVERT_FLOOR_MARGIN_BPS), and vault-flows.ts refuses to sign a build whose
   * convertWad is null, zero or not exactly that — but the owner is signing the
   * number, so he is told what it does and what zero would have meant. `margin`
   * is how far under the live price it sits, from CONVERT_FLOOR_MARGIN_BPS.
   */
  convertFloorEffect: (margin: string): string =>
    `That floor is what keeps converting switched on: the keeper sells your vault's SOL for USDC only at or above it, and it is set ${margin} under the price just read above. It is never zero, and zero is the one value that would matter — it would mean your SOL sold at any price at all.`,
  legCeiling: (symbol: string, max: string): string => `${symbol} is never bought above ${max} per 100,000,000 raw units (5.3 % over today's pool price)`,
  pricesUnknown: "Today's prices could not be read just now. The build reads them again, and the limits you sign are shown before Phantom asks.",
  /**
   * The owner's words for what a policy does, at the limits shown. `basket` is
   * every offered leg with its weight, so this sentence cannot go on naming one
   * stock after the basket grows — which is exactly how it came to say "invests
   * in SPYx" while the Basket field beside it already read "SPYx 50 %,
   * ANTHROPIC 50 %". The per-stock ceilings are NOT inlined here any more: at
   * two legs they arrived joined by a slash ("$801.80 / $18.95"), a figure of
   * no meaning, and the box below already prints one line per stock.
   */
  policyRule: (basket: string, floorUsdPerSol: string, purchase: string, maxPerCall: string, maxRolling: string, rent: string): string =>
    `Your vault invests in ${basket}, each through its own Raydium pool, and a buy takes all of them or none. When the vault holds SOL, the keeper converts it to USDC, never below ${floorUsdPerSol} per SOL, then buys once ${purchase} of USDC is ready and never above the per-stock limits below. At most ${maxPerCall} per buy and ${maxRolling} per 30 days until you change them. If a price moves past a limit, or one of the pools is too small for the buy, nothing is bought and no SOL is converted until you sign again. Nothing is sold at a worse price. Setting this up costs ${rent} SOL of rent for the policy and the vault's token accounts, and none of it comes back.`,

  // ── WHAT THE POSITION COSTS, AND WHO OWNS EACH NUMBER ──────────────────────
  //
  // The card said nothing at all about this until now, which was the worst of
  // the three things wrong with it: a person could read the whole screen, tick
  // the box and sign, and never meet the 2 % that going in and out of ANTHROPIC
  // hands its issuer. The two costs are split into two sentences ON PURPOSE,
  // because they have different owners and different remedies — one is a number
  // a single key sets and has already raised, the other is the day's
  // liquidity. SPYx sits beside ANTHROPIC in both, because without it the reader
  // has no way to tell "this is what tokenised stocks cost" from "this is what
  // THIS token costs", and the honest answer is the second.
  //
  // EVERY FIGURE BELOW IS A MEASUREMENT, NOT A CONSTANT OF THE CODE, so each one
  // carries the day it was read and re-reading it is the only way to change it.
  // Read on mainnet 2026-09-20, epoch 1039, slot 448864409:
  //  * the transfer fees, from the mints' own TransferFeeConfig — ANTHROPIC
  //    older{epoch 1032, 50 bps} newer{epoch 1039, 100 bps}, maximum_fee u64::MAX
  //    so nothing caps it, active 100 bps in the epoch the cluster is in; SPYx
  //    carries no TransferFeeConfig extension at all. THE COPY CLAIMS ONE RAISE,
  //    NOT TWO: a TransferFeeConfig holds exactly two entries, older and newer,
  //    so 50 -> 100 is the only change this mint can be read to have made. An
  //    earlier 0 -> 50 may well have happened and is NOT on the account, so it is
  //    not said here.
  //  * the round trips, from SIMULATED round trips on mainnet: unsigned
  //    transactions through simulateTransaction, USDC -> stock -> USDC, with
  //    the sell chained on the REAL credit the buy returned and not on the
  //    quote. Epoch 1039, n=7. ANTHROPIC 2.4 %, range 2.24-2.63 %. Of that,
  //    199 bps is STRUCTURAL -- the mint's 1 % charged once going in and once
  //    coming out, which is 1 - 0.99^2 and NOT "2 x 1 %" -- and the remaining
  //    25-64 bps is venue spread and impact, which moved by 36 bps in thirteen
  //    minutes. SPYx on the same harness: 1.1-1.8 BASIS POINTS.
  //
  //    THESE ARE THE CLOSED FIGURES AND THE COPY QUOTES NO OTHER. Two earlier
  //    readings are gone. 0.60 / 0.57 / 1.26 % for ANTHROPIC at $5 / $25 / $100
  //    carried a size-dependence claim ("it gets worse as the buy gets bigger,
  //    because its pool is small") that is not reproducible from anything in
  //    this repository and whose own middle point fell as the buy grew. And
  //    SPYx 0.01 % / ANTHROPIC 0.41-0.44 %, from keyless Jupiter quotes, was
  //    written before the measurement finished: it priced the sell off the
  //    quote instead of off the credit the buy actually returned, and the
  //    closed harness reads the same round trip at 2.24-2.63 %. THE COST DOES
  //    NOT SHRINK BY BUYING SMALLER -- it is a fee on every transfer, not
  //    slippage, and it is charged again on every rebalance -- so no sentence
  //    below offers a smaller buy as a way out of it. The pool's size is
  //    argued where it IS measured: thinPool, from the pool account's own
  //    USDC reserve.
  //
  // WHEN THE FEE ROSE, which the copy has to get right because it is the proof
  // that the key is in use NOW. TransferFeeConfig's newer entry starts at epoch
  // 1039 and the read at slot 448864409 was inside 1039: mainnet epochs are
  // 432,000 slots, so 1039 began at slot 448,848,000 and the read was 16,409
  // slots in -- about 1.8 hours at 400 ms a slot. solana-core's product.ts
  // records the other side of the same day: read on 2026-09-20 in epoch 1038,
  // the rise to 100 bps was still SCHEDULED. So the epoch turned over on
  // 2026-09-20 and the fee rose HOURS before these words, not days. The older
  // entry starts at epoch 1032, about seven epochs back, so 0.5 % had held for
  // roughly two weeks.
  costTitle: "What this costs you, and who decides it",
  issuerCost:
    "ANTHROPIC's issuer charges 1 % of every transfer of it: once when your vault buys it, and once when it leaves. Going in and back out therefore gives up 1.99 % before the market is involved at all — not quite two, because the second 1 % is taken from what the first one left. Buying in smaller pieces does not make it smaller: it is a fee on each transfer, not a price that moves with the size of the order, and every later buy pays it again. That figure belongs to the issuer — not to SaverFi and not to Solana — and the issuer moves it: it was 0.5 % for about two weeks, and it became 1 % when the current epoch began, hours before this was written on 20 September 2026. SPYx charges nothing to transfer, and nobody can make it: its mint carries no fee setting at all, and no key with the power to add one.",
  /**
   * THE LIMIT THE NEXT RAISE CROSSES, which no sentence said while two of them
   * told the owner the issuer moves this number and had just moved it.
   *
   * The keeper admits a leg only while `fee.bps <= MAX_LEG_FEE_BPS`
   * (invest-decision.ts gates on `fee.bps > MAX_LEG_FEE_BPS`, strictly greater),
   * and ANTHROPIC's active fee is EXACTLY that limit — admitted with no margin
   * at all. One more raise by the single key described below, and the refusal is
   * all-or-nothing: the whole basket, SPYx included, and the SOL conversion with
   * it. `max` is MAX_LEG_FEE_BPS as a percentage, read from the keeper's own
   * constant by vault-copy.test.ts so this sentence cannot drift from the gate.
   */
  feeCeiling: (max: string): string =>
    `There is a limit built into SaverFi: the keeper will not buy a stock that charges more than ${max} to transfer. ANTHROPIC sits exactly on that limit today, so if that issuer raises the fee once more, the vault stops buying the whole basket — SPYx along with it — and stops converting your SOL at all, until the basket itself is changed. Nothing is lost when that happens; the saving simply stops until someone acts.`,
  marketCost:
    "Then there is what the market charges on top, which depends on the day's liquidity. Buying a stock and selling it straight back was measured on 20 September 2026 on Solana itself — seven round trips, built and run but never signed, each sale priced on what its purchase actually delivered rather than on a quote. ANTHROPIC's round trip cost 2.4 % all told, between 2.24 % and 2.63 %. The issuer's 1.99 % is the part of that which never moves; the rest, between 0.25 % and 0.64 %, is the market, and it moved by 0.36 % within thirteen minutes that day. SPYx's round trip, measured the same way, cost between 0.011 % and 0.018 %. Another day reads differently.",
  costTogether:
    "So going in and out of ANTHROPIC cost 2.4 % on the day it was measured: 1.99 % of that is the issuer's fee, charged whatever the market does, and the remainder is the market. SPYx cost under two hundredths of one percent the same day — more than a hundred times less. Both are tokenised stocks on the same chain, bought the same way, held in the same vault. The difference is these two issuers and these two pools — not Solana, and not SaverFi.",

  // ── WHETHER IT CAN BUY AT ALL TODAY ────────────────────────────────────────
  //
  // NOT "only one leg can be bought": the keeper's depth gate is all-or-nothing
  // by explicit doctrine (legDepthDecision refuses "the whole basket ... the deep
  // ones included, and refusing to convert SOL toward it"), so one leg alone is
  // not a thing that can happen. And the gate tests a CONVERTING turn at
  // max_per_call itself (turnSpendCeiling), not at what the vault holds — so the
  // shipped $1,000 default is the figure it is judged by, and at two equal legs
  // that is $500 into ANTHROPIC's pool against the 50x it must clear.
  //
  // Measured 2026-09-20, epoch 1039, slot 448864213, from the pools' own token
  // vaults: ANTHROPIC/USDC held 9,541,652,779 raw USDC ($9,541.65), which admits
  // $190.83 per leg and $381.67 for the whole buy, and gives a $500 leg only
  // 19.1x cover where 50x is required. SPYx/USDC held $2,380,319.90 — 4,760x on
  // the same $500. The words below round those DOWN to "about $190 / $380",
  // because a reader must not read a ceiling as a target.
  thinPoolTitle: "Today, this basket may buy nothing at all",
  /**
   * `defaultCap` is what the Most per buy box starts at, so the sentence names
   * the very number it is asking to be lowered. The pool figures stay inline
   * with the measurement recorded above them rather than being passed in: they
   * are readings of one night, not values the screen can compute.
   */
  thinPool: (defaultCap: string): string =>
    `The keeper refuses a buy unless the pool it goes into holds at least ${POOL_DEPTH_MULTIPLE} times that buy, so a small pool sets a small ceiling. ANTHROPIC's pool held about $9,500 when it was read on 20 September 2026, which admitted about $190 for its share of a buy — about $380 for the whole buy, and that is the ceiling itself, not a target. And because a buy takes all of the basket or none, a Most per buy above it stops the buying altogether whenever the vault has SOL to convert: nothing bought, no SOL converted, at any balance. Most per buy starts at ${defaultCap}. On that night's reading, about $190 or less left roughly twice the cover the keeper asks for; $380 left almost none, so a pool that drains even slightly turns $380 into a cap that buys nothing. That figure was true that night and nothing on this page re-reads it, so treat the smaller number as the safe one while ANTHROPIC's pool is this small. SPYx's pool held about $2.4 million the same night and is nowhere near this limit.`,

  // ── THE ISSUERS' POWERS ────────────────────────────────────────────────────
  //
  // The notice and the box the owner TICKS both named SPYx only — and SPYx is
  // the safer of the two on every count. He was acknowledging the wrong token.
  // Read on mainnet 2026-09-20, epoch 1039, slot 448864409:
  //  * ANTHROPIC (Pren1Fv…Lkhw): mint, freeze, pausable, transfer-fee config,
  //    withdraw-withheld, transfer hook, confidential transfer and the permanent
  //    delegate are ALL WV9PJN7XTmTLVwbutCLFxp8TyePee6Xq5mRq6Fti5Wc. One key.
  //  * SPYx (XsoCS1…BDF2W): mint 7pt9tkct…, freeze and pausable JDq14BWv…,
  //    permanent delegate, hook and metadata 5aMNNLQJ…. Three separate keys, and
  //    no transfer fee to raise.
  //
  // THE SECOND SWITCH, which no sentence said while the fee had three of its
  // own. Both mints carry Token-2022's TRANSFER HOOK extension PRESENT BUT
  // EMPTY — the authority is set and the program id is the default key, which
  // invest-decision.ts's decodeMintFacts reads as `transferHook: null` and its
  // own comment calls "the issuer keeping the option open rather than a hook".
  // legAdmissionDecision refuses any leg whose transferHook is NOT null,
  // because sip-vault's invest builds swap_v2 with the route's accounts and
  // nothing else, and a real hook needs its own accounts on every transfer. So
  // filling that field in is a STOP, not a cost, and by the same all-or-nothing
  // doctrine as the fee ceiling it takes the whole basket — SPYx and the SOL
  // conversion included. BOTH LEGS CARRY THAT FIELD AND BOTH AUTHORITIES ARE
  // SET: on ANTHROPIC the key that can fill it is the same WV9PJ… that raised
  // the fee hours earlier; on SPYx it is 5aMNNLQJ…, which is not the key that
  // can freeze or pause SPYx and cannot put a fee on it at all. So the STOP is
  // symmetric and the FEE is not, and neither side of that may be overstated —
  // nothing read here measures which key is likelier to use it.
  // INVEST_COPY.hookSwitch is the sentence that says so, and
  // vault-copy.test.ts pins it to the keeper's CODE — the null-program-id read
  // and the `facts.transferHook !== null` refusal — never to its prose.
  freezeNotice:
    "Both stocks are Token-2022 tokens, and each issuer keeps powers over its own that SaverFi cannot take away. An issuer can freeze your vault's account for that stock, pause every transfer of it, and move it out of your vault through a permanent delegate. If any of that happens, withdrawing that stock can fail or find less than you hold. USDC's issuer can freeze USDC accounts too. Withdrawing SOL depends on no issuer at all.",
  issuerKeys:
    "The two are not the same risk. On ANTHROPIC a single key holds all of it at once — minting, freezing, pausing, the transfer fee, the transfer hook and the permanent delegate — and that key has already been used to raise the fee, from 0.5 % to 1 %, on the day this page was written. On SPYx those powers sit with three separate keys and there is no fee to raise. This deserves more of your attention than the price does: it is not the market moving against you, it is one person's decision.",
  /**
   * THE SWITCH THAT STOPS THE BUYING, held on ANTHROPIC by the same key as the
   * fee — and held on SPYx by a key of its own.
   *
   * Said in the owner's terms on purpose: what he is being asked to accept is
   * not a fee that might rise by some amount, it is that a stranger can stop his
   * pension buying anything at all, on a day of that stranger's choosing. Every
   * clause is a fact of the arrangement rather than of today's number, so the
   * sentence survives the fee moving again: the field is empty TODAY, the
   * refusal is what SaverFi does whenever it is not.
   *
   * THE STOP SPEAKS ONLY FOR ITSELF. This ended on a bare "Nothing you have
   * already saved is lost or moved.", two paragraphs under freezeNotice's
   * permanent delegate and inside the SAME box, where standing alone it reads as
   * a blanket promise that nothing can ever be taken — which that box denies
   * three lines earlier. It now says what it always meant, that the STOP takes
   * nothing, and points back at the powers that do reach the holding.
   *
   * AND THE STOP IS NOT ANTHROPIC'S ALONE. The mainnet read recorded above gives
   * SPYx a transfer-hook authority of its own (5aMNNLQJ…), so SPYx's empty field
   * can be filled in by ITS key exactly as ANTHROPIC's can by WV9PJ…. Saying
   * only "a different key holds it" and then closing on "one stranger's key"
   * left the reader finishing the paragraph believing the stop belonged to
   * ANTHROPIC. Both legs carry it. The asymmetry that IS on the accounts is the
   * FEE — SPYx's mint has no TransferFeeConfig and no authority for one, while
   * ANTHROPIC's fee key is the same key that freezes, pauses and moves its stock
   * — and nothing here measures which key is likelier to act, so nothing here
   * says.
   */
  hookSwitch:
    "The same key holds a second switch, and this one is not about money at all: it stops the buying. Both stocks carry a Token-2022 field where the issuer may name a program that has to run on every transfer of it; on both it is empty today, which is the issuer keeping the option rather than using it. SaverFi will not buy a stock whose field has been filled in, because it cannot carry what a program named there would demand. So on the day ANTHROPIC's key writes one in, the vault stops buying the whole basket — SPYx along with it — and stops converting your SOL, until the basket itself is changed. It applies from the moment it is written: the next buy is the one that stops. That stop takes nothing from you: what you have already saved is neither lost nor moved by it. The freeze, the pause and the permanent delegate described above are separate powers, and those can reach what your vault already holds. SPYx is not exempt from this: it carries the same empty field, and the key over that field — not the key that freezes or pauses SPYx — is set exactly as ANTHROPIC's is, so either issuer can fill its own field in and stop the whole basket the same way. Nothing here measures which of them is likelier to. The asymmetry that can be proved is the fee, not the stop: SPYx's mint carries no fee setting at all and no key able to add one, while on ANTHROPIC the key that would write the hook in is the same key that sets the fee and can freeze, pause and move the stock. So what you are accepting is not only a fee that may rise: it is that either stranger's key can stop your pension buying anything at all, on any day he chooses.",
  freezeShort:
    "Each issuer can freeze, pause or move its own stock, even inside your vault, and on ANTHROPIC one key holds all of those powers. Withdrawing SOL does not depend on any of them.",
  acknowledge:
    "I understand each issuer can freeze, pause or move its own stock out of my vault, that one key holds all of those powers over ANTHROPIC, and that the same key can stop my vault buying anything at all",
  sign: "Sign investment policy",
  signing: "Signing…",
  signed: "Policy signed",
  capsProblem: (minimum: string): string => `Most per buy must be at least ${minimum}, and Most per 30 days at least Most per buy.`,

  // ── THE FIELDS THE OWNER ASKED TO SET ──────────────────────────────────────
  minPerBuy: "Least per stock",
  minPerBuyHint:
    "The smallest amount the keeper will put into ONE stock. It is checked per stock, not per buy: with two stocks at equal shares, a buy has to be at least twice this before anything happens.",
  minimumProblem: "Least per stock must be more than zero.",
  minimumUnreachable: (minimum: string): string =>
    `At these settings no buy ever reaches ${minimum} for every stock, so nothing would be bought. Lower this, or raise Most per buy.`,
  weightsTitle: "What share each stock takes",
  weightsHint: "Whole percentages that add up to 100. Nothing is rounded or filled in for you: a basket that does not add up is refused rather than adjusted.",
  weightProblem: (symbol: string): string => `${symbol}'s share must be a whole number of percent, greater than zero.`,
  weightsSum: (total: string): string => `The shares must add up to exactly 100 %. These add up to ${total}.`,
  venueLabel: "Where it trades",
  venueHint: "The exchange the keeper buys through. SaverFi checks the transaction against the one you pick before your wallet is asked to sign it.",
  convertWarning: "Above $1,000.00 per buy, one conversion can sell more than 1 SOL of your savings at the floor.",
  /**
   * SAID BESIDE THE BOX, not only in the notice three boxes above it.
   *
   * The thin-pool notice explains the ceiling; this is what the owner sees the
   * moment he types past it. It is a WARNING and not a refusal on purpose: the
   * ceiling is a reading of one night that nothing on this page re-reads, so
   * blocking on it would refuse a cap that a recovered pool would accept. What
   * must not happen is the old behaviour -- a cap the card itself calls dead,
   * sitting in the box, with Sign lit and 0.0117 SOL of rent about to be spent.
   */
  depthWarning: (ceiling: string): string =>
    `This is above the ${ceiling} that ANTHROPIC's pool allowed when it was last read. If the pool is still that size, a policy at this cap buys nothing and converts no SOL — and the rent you pay to sign it does not come back.`,
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
    `Only your pension key can withdraw, and SaverFi cannot pause or block a SOL withdrawal. The vault keeps ${rentFloor} SOL of rent, which Solana requires, and a vault cannot be closed.`,
  empty: "Savings arrive from linked trading wallets. To try a withdrawal now, send a little SOL to the vault address from your wallet app.",
  /** Shown beside the SOL section while the vault's investment policy is on. */
  investingOn:
    "Investing is on, so the keeper can convert SOL that reaches this vault to USDC within about a minute, and it then shows under Tokens. To test a SOL withdrawal, pause investing first.",
  /** A withdrawal the build checked, refused on chain because the vault then held less SOL: the keeper's conversion, most likely. */
  balanceMoved: "The vault's SOL moved after this was prepared, most likely into investing by the keeper: see Tokens. Nothing was withdrawn.",
  vaultAddress: "Vault address",
  tokens: "Tokens",
  noTokens: "The vault holds no tokens yet.",
  tokensUnreadable: "SaverFi could not read the vault's tokens just now. Nothing was offered to sign.",
  /** When the vault's token listing could not be read and its own accounts, read by address, could: `symbols` is "wSOL, USDC and SPYx". */
  tokensOwnAccountsOnly: (symbols: string): string => `SaverFi could not list every token account your vault owns just now, so only its own ${symbols} accounts are shown.`,
  ownAccountsEmpty: "Those accounts hold no tokens.",
  share: (percent: number): string => (percent === 100 ? "All" : `${percent} %`),
  wsolNote: "Arrives in your wallet as SOL.",
  createsLegAccount: (symbol: string, rent: string): string => `Creates your own ${symbol} token account if you have none (${rent} SOL of rent, paid by you and kept by you).`,
} as const;

export const PROGRESS_COPY = {
  creating_wallet: "Creating your trading wallet",
  preparing: "Preparing",
  consent: "Trading wallet signs the consent",
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
  network: "SaverFi could not be reached. Check your connection, then try again.",
  unavailable: "Solana is not available on this deployment right now.",
  upstream: "Solana did not answer just now. Nothing was sent. Try again.",
  rateLimited: (seconds: number | null): string =>
    seconds === null ? "Too many requests just now. Try again in a minute." : `Too many requests just now. Try again in ${seconds} s.`,
  blockhashExpired: "Solana's approval window passed before the transaction was sent. Build it again.",
  alreadyExists: "It already exists. Refreshing.",
  frozen: "The issuer has frozen this token account. SOL withdrawals still work.",
  issuerPaused: "The issuer has paused transfers of that stock.",
  simulationRefused: "Solana refused this transaction in simulation. Nothing was sent.",
  /** The pension key cannot pay this action's rent and fees; `cost` is its total in SOL when the build said it, else null. */
  needsSol: (cost: string | null): string =>
    cost === null
      ? "Your pension key does not hold enough SOL for this action's rent and fees. Add SOL in Phantom, then try again. Nothing moved."
      : `Your pension key needs more SOL: this action costs about ${cost} SOL in rent and fees. Add SOL in Phantom, then try again. Nothing moved.`,
  unknown: "Something went wrong. Nothing was sent.",
  builtMismatch: (detail: string): string => `SaverFi's server sent a transaction that is not what you asked for (${detail}). Nothing was signed.`,
  /**
   * A venue this app cannot check the bytes of. The server may offer a name the
   * web has not learned the program for yet; signing it would mean trusting the
   * server about which program the vault will call, which is the one thing the
   * intent check exists to avoid. The panel only offers verifiable names, so
   * this is a last line rather than something an owner should ever meet.
   */
  unverifiableVenue: (venue: string): string =>
    `SaverFi cannot check a transaction that trades on "${venue}" yet, so it will not ask you to sign one. Nothing was signed. Choose another venue, or update SaverFi.`,
  signedMismatch: (detail: string): string => `Phantom changed the transaction SaverFi built (${detail}). Nothing was sent.`,
  foreignProgram: (label: string): string => `Phantom added an instruction for ${label}, which SaverFi does not relay. Nothing was sent.`,
  /** Phantom's Lighthouse checks broke the rule the relay holds them to; `detail` is @sip/solana-core's checkWalletGuards words. */
  walletGuardRefused: (detail: string): string => `Phantom added a Lighthouse safety check SaverFi does not relay (${detail}). Nothing was sent.`,
  /** A Lighthouse check Phantom added failed: an account was not as Phantom's preview showed when the transaction ran. */
  walletGuardFailed: "Phantom's safety check stopped this transaction: an account changed after Phantom previewed it. Nothing moved. Try again.",
  unreadableBuilt: "SaverFi's server sent something that is not a transaction. Nothing was signed.",
  unreadableSigned: "Phantom returned something that is not a transaction SaverFi can read. Nothing was sent.",
} as const;
