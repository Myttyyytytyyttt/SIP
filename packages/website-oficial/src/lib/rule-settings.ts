/**
 * THE VAULT SETTINGS, AS ONE DRAFT (owner, 09-25): everything that changes the
 * vault — how it saves (mode, rate, pause) and what it buys (assets by
 * category, their shares, the threshold) — lives behind the gear on the
 * Savings rule card, in one dialog (rule-settings-dialog.tsx).
 *
 * PURE, AND FREE OF PRIVY AND OF THE INVESTING CARD, because the sample page
 * uses the same form and must not pull a wallet SDK or a policy builder in.
 * The live arithmetic (what to sign, with which fields re-sent) is
 * components/live/rule-settings-plan.ts; this file only holds the shapes and
 * the few numbers both hosts share.
 */

/**
 * The program's own ranges, in basis points (rules.ts in @sip/solana-core,
 * pinned there to state.rs). Written out rather than imported: that entry
 * carries the IDL, and this ships to the browser for four numbers.
 * LiveRulePanel.test.ts holds them to the package's values.
 */
export const RATE_RANGES = {
  profit: { min: 201, max: 10_000, presets: [1_000, 2_000, 5_000] },
  volume: { min: 1, max: 200, presets: [50, 100, 200] },
} as const;

export type RuleMode = keyof typeof RATE_RANGES;

/**
 * WHERE THE BAR STARTS WHEN A PROFIT VAULT SWITCHES TO VOLUME (owner, 09-25):
 * 1 % — "1 % ida y 1 % vuelta", 1 % of every buy and 1 % of every sell. The
 * vault's stored volume rate is whatever it was created with (the program's 2 %
 * product rate, rules.ts DEFAULT_RATES, pinned to state.rs), never a choice.
 */
export const VOLUME_START_BPS = 100;

/**
 * THE INVESTMENT THRESHOLD EVERY BASKET STARTS AT (owner, 09-25): $10,
 * whatever the number of assets. It is a BASKET figure — the pile at which
 * the whole buy happens — and the chain stores the per-leg minimum that makes
 * it so (minimumFor). Kept apart from @sip/solana-core's
 * DEFAULT_PURCHASE_USDC_RAW, which also feeds the shelf's FLOOR rule.
 */
export const BASE_THRESHOLD_RAW = 10_000_000n;
/** The same, in dollars, for the form's "Use $10" chip. */
export const BASE_THRESHOLD_USD = 10;

/** The minimum PER LEG that makes the basket invest at `thresholdRaw`: the inverse of pending.ts. */
export function minimumFor(thresholdRaw: bigint, weightsBps: readonly number[]): bigint {
  if (weightsBps.length === 0) return 0n;
  const lightest = BigInt(Math.min(...weightsBps));
  return (thresholdRaw * lightest) / 10_000n;
}

/** One picked asset: a mint on a live page, a ticker on the sample. Percent is whole, as typed ("" while empty). */
export interface SettingsPick {
  readonly id: string;
  readonly percent: string;
}

/** Everything the dialog edits, as the person left it. */
export interface SettingsDraft {
  readonly mode: RuleMode;
  readonly rateBps: number;
  readonly paused: boolean;
  readonly picked: readonly SettingsPick[];
  /** Dollars as typed. */
  readonly threshold: string;
}

/** One group of assets on the shelf, as the dialog lists them. */
export interface SettingsCategory {
  readonly id: string;
  readonly title: string;
  /** The "?" beside the category's title. */
  readonly help: string;
  readonly assets: readonly SettingsAsset[];
  /** Symbols on the shelf that cannot be bought right now; listed in one muted line, never tickable. */
  readonly unavailable: readonly string[];
}

export interface SettingsAsset {
  /** What a pick carries: the mint on live, the ticker on the sample. */
  readonly id: string;
  readonly symbol: string;
  readonly name: string;
  /** Art for the tile; absent means the ticker's own mark. */
  readonly logo?: string;
}

/**
 * Ticking or unticking an asset. Any change of WHICH assets are picked splits
 * the shares evenly again — the onboarding's own split — so the shares always
 * add up after a tick; typed shares are otherwise left exactly as typed.
 */
export function pickToggled(rows: readonly SettingsPick[], id: string, on: boolean, maxLegs: number): readonly SettingsPick[] {
  const has = rows.some((row) => row.id === id);
  if (on === has) return rows;
  const next = on ? (rows.length >= maxLegs ? rows : [...rows, { id, percent: "" }]) : rows.filter((row) => row.id !== id);
  if (next === rows) return rows;
  return evened(next);
}

/** Whole percents that add to 100, the remainder on the first (basket-picker.ts's evenPercents, without its catalogue import). */
function evenShares(count: number): number[] {
  const share = Math.floor(100 / count);
  return Array.from({ length: count }, (_, index) => (index === 0 ? share + (100 - share * count) : share));
}

/** Every pick at an even share (whole percents that add to 100). */
export function evened(rows: readonly SettingsPick[]): readonly SettingsPick[] {
  if (rows.length === 0) return rows;
  const shares = evenShares(rows.length);
  return rows.map((row, index) => ({ id: row.id, percent: String(shares[index]!) }));
}

/** One pick's share, as typed. */
export const withShare = (rows: readonly SettingsPick[], id: string, percent: string): readonly SettingsPick[] =>
  rows.map((row) => (row.id === id ? { id, percent } : row));

/** The typed shares' sum; a box that is empty or not a whole number counts as 0. */
export const shareTotal = (rows: readonly SettingsPick[]): number =>
  rows.reduce((sum, row) => sum + (/^\d+$/.test(row.percent.trim()) ? Number(row.percent.trim()) : 0), 0);

/** Dollars typed in the threshold box, or null when it is not a plain positive amount (up to cents). */
export function thresholdUsdOf(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}
