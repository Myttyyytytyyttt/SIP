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
  staleLong: "These numbers may be out of date.",
} as const;
