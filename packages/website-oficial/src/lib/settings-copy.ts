/**
 * THE VAULT SETTINGS' WORDS (owner, 09-25) — the gear on the Savings rule card
 * and the dialog behind it. One object, so tests can pin it.
 *
 * Every title in the dialog has a "?" beside it (components/info-tip.tsx) with
 * one or two plain sentences for somebody who has never used a crypto app:
 * what the thing is, and what changing it does. No jargon — no "bps", no
 * "policy", no "leg", no "sign".
 *
 * NO STRING THE SAMPLE CAN SHOW SAYS "sign" (savings-rule-panel.test.ts): the
 * sample never asks for a signature, and saying so would be a lie.
 */
export const SETTINGS_COPY = {
  title: "Vault settings",
  gear: "Vault settings",
  gearAttention: "Vault settings: needs your attention",
  descriptionLive: "Changes are saved to your vault on Solana. Your wallet asks you to approve each one.",
  descriptionSample: "This is the sample: changes here only move what this page shows.",

  savingHeading: "Saving",
  buyingHeading: "Buying",

  mode: "Mode",
  modeProfit: "Profit",
  modeVolume: "Volume",
  rate: "Rate",
  presets: "Common rates",
  pause: "Pause saving",
  paused: "Paused",

  assets: "What your savings buy",
  shares: "Shares",
  threshold: "Investment threshold",
  useBase: (usd: string): string => `Use ${usd}`,
  unavailable: (count: number): string => `+${count} not available right now`,
  nothingPicked: "Nothing picked: savings stay in your vault as SOL.",
  appliesWhenBuyingStarts: "Applies when buying starts.",
  sharesTotal: (total: number): string => `Shares add up to ${total} %. They must add up to 100 %.`,
  evenOut: "Split evenly",
  smallLeg: (symbol: string, usd: string): string =>
    `At this threshold ${symbol} gets ${usd} per buy. Very small buys may wait until the pile is bigger.`,

  refresh: "Refresh price limits",
  refreshDone: "Your price limits match today's prices.",
  refreshNeeded: "Your price limits are older than today's prices. Refresh them so every buy can go through.",
  refreshSomeRoutes: "Some routes can still buy at your current limits. Refresh them so every route can.",
  refreshNoRoute: "No route can buy at your current limits. Refresh them to start buying again.",
  refreshBlocked: "Save or cancel your changes first: saving refreshes the price limits too.",

  nonceNotice: "Changing how you save restarts any saving already on its way. Nothing already in your vault is touched.",
  buyingReapproved: "Changing what you buy approves your choices again, with price limits read from today's prices.",
  capMoved: (from: string, to: string): string => `The most one buy can spend moves from ${from} to ${to}, to fit this basket.`,
  approvals: (count: number): string => (count === 1 ? "Your wallet will ask you to approve 1 change." : `Your wallet will ask you to approve ${count} changes, one after the other.`),
  save: "Save changes",
  cancel: "Cancel",
  noChanges: "No changes yet",
  saved: "Saved",
  loading: "Reading your vault on Solana…",
  retry: "Try again",

  categories: {
    xstock: "Stocks & funds",
    prestock: "Private companies",
    index: "Index",
  },

  help: {
    mode: "How SaverFi decides what to put aside. Profit saves a share of what you gain when you sell at a profit. Volume saves a small share of every buy and every sell, win or lose.",
    rateProfit: "How much of each profit goes into your vault. At 20 %, a $50 profit puts $10 aside.",
    rateVolume: "How much of each trade's size goes into your vault. At 1 %, a $500 trade puts $5 aside.",
    presets: "The rates people pick most, one click away. You can still drag the bar to any rate you like.",
    pause: "Stops saving until you switch it back on. Everything already in your vault stays there, and you can still withdraw it.",
    assets: "What your savings turn into once enough has piled up. Pick up to 5; every buy is split between them.",
    xstock: "Tokens that follow a real listed share or fund, like the S&P 500, one for one.",
    prestock: "Tokens that follow companies not yet on the stock market, like Anthropic. The issuer takes a fee each time they move, and can raise it.",
    index: "A basket of many companies in one token, so no single one decides how it goes.",
    unavailable: "Too little of these is traded to buy them safely today. They come back when their markets grow.",
    shares: "How each buy is split between the assets you picked. The shares must add up to 100 %.",
    threshold: "Your savings wait until they reach this amount, then buy everything in one go. Fewer, bigger buys lose less to fees. $10 is the default.",
    refresh: "Buys only go through at prices close to the ones you approved. Refreshing approves your current choices again at today's prices. Nothing is bought when you do it.",
  },

  /**
   * WHAT SWITCHING TO VOLUME MEANS, said before the wallet asks (owner and the
   * volume keeper, 09-25). One line each, in the footer's notices.
   */
  volumeSwitch: [
    "On Volume, every buy AND every sell saves a share of its size in SOL — win or lose.",
    "Plain transfers in or out of your trading wallet never count.",
    "Trades not yet charged under your profit rule are forgiven at the switch.",
    "Above your most per settlement, nothing is carried over to the next one.",
  ],

  /** Under the greyed Volume option on a live vault: one sentence, no jargon. */
  volumeComing: "Coming soon: SaverFi can't measure trading volume yet, so a volume vault would save nothing today.",
  /** A vault that was made on Volume before it was withdrawn: the one way on. */
  volumeLegacy: "Your vault saves on volume, which SaverFi can't measure yet. Switch to Profit to keep saving.",

  /** The basket half of a Save that did not go, because the rule half did not land first. */
  secondHalfDropped: "Your basket change was not sent, because the rule change did not land first. Save it again once the rule shows here.",

  // The dialog's own small words (rule-settings-dialog.tsx).
  comingSoon: "Coming soon",
  shareOf: (symbol: string): string => `${symbol} share`,
  sharesExact: "Shares add up to 100 %.",
  full: (count: number): string => `${count} picked, the most one basket holds.`,
  acknowledgeRequired: "Tick the box above to save.",
  close: "Close",
  closeHeld: "Close (not while your wallet is asking)",

  // The live arithmetic's own refusals and notes (components/live/rule-settings-plan.ts).
  thresholdTooSmall: (least: string): string => `The investment threshold must be at least ${least}.`,
  rateOutOfRange: (least: string, most: string): string => `The rate must be between ${least} and ${most}.`,
  notOnShelf: (symbol: string): string => `${symbol} cannot be bought right now. Untick it to save.`,
  buyingStaysPaused: "Buying is paused, and these changes keep it paused.",
} as const;
